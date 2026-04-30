/**
 * Vitest for native tool: invoke_tool
 *
 * Per META-PACK-HANDOFF.md §6 — happy path + meta-recursion blocking + deny +
 * allow + audit logging + glob pattern matching + error pass-through.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  NativeToolContext,
  NativeToolDefinition,
  NativeMcpResult,
} from '../../src/lib/tools/native-registry';

// Build a deterministic mock registry. Unique per beforeEach.
const mockRegistry = new Map<string, NativeToolDefinition>();

vi.mock('../../src/lib/tools/native-registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/tools/native-registry')
  >('../../src/lib/tools/native-registry');
  return {
    ...actual,
    getNativeRegistry: () => ({
      listTools: () =>
        Array.from(mockRegistry.entries()).map(([name, def]) => ({
          name,
          description: def.description,
          inputSchema: def.inputSchema,
          server: def.server || 'system',
        })),
      get: (name: string) => mockRegistry.get(name),
      has: (name: string) => mockRegistry.has(name),
    }),
  };
});

import invokeToolTool from '../../src/lib/tools/native/invoke-tool';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function call(
  args: Record<string, unknown>,
  ctx?: NativeToolContext,
): Promise<NativeMcpResult> {
  return invokeToolTool.handler(args, ctx ?? makeMockContext());
}

function expectOk(r: NativeMcpResult): Record<string, unknown> {
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text);
}

function expectErr(r: NativeMcpResult): { code: string; error: string } {
  expect(r.isError).toBe(true);
  return JSON.parse(r.content[0].text);
}

const okHandler = vi.fn<
  (args: Record<string, unknown>, ctx: NativeToolContext) => Promise<NativeMcpResult>
>();

function setMockTools(entries: Array<[string, Partial<NativeToolDefinition>]>): void {
  mockRegistry.clear();
  for (const [name, def] of entries) {
    mockRegistry.set(name, {
      description: def.description ?? 'A test tool',
      inputSchema: def.inputSchema ?? { type: 'object', properties: {} },
      server: def.server ?? 'test',
      handler:
        def.handler ??
        (async (a: Record<string, unknown>) => ({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, args: a }) }],
        })),
    });
  }
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  okHandler.mockReset();
  okHandler.mockImplementation(async (args) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: true, receivedArgs: args }),
      },
    ],
  }));

  setMockTools([
    [
      'fetch_url',
      {
        description: 'Fetch a URL',
        server: 'web',
        inputSchema: { type: 'object', required: ['url'], properties: {} },
        handler: okHandler,
      },
    ],
    [
      'fs_read',
      {
        description: 'Read a file',
        server: 'fs',
      },
    ],
    [
      'fs_write',
      {
        description: 'Write a file',
        server: 'fs',
      },
    ],
    [
      'delete_document',
      {
        description: 'Delete a doc',
        server: 'library',
      },
    ],
    [
      'throwing_tool',
      {
        description: 'Always throws',
        server: 'test',
        handler: async () => {
          throw new Error('boom inside tool');
        },
      },
    ],
    [
      'error_result_tool',
      {
        description: 'Returns isError: true',
        server: 'test',
        handler: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ inner: 'fail' }) }],
          isError: true,
        }),
      },
    ],
    // The meta tools — must always refuse dispatch
    ['list_available_tools', { description: 'meta', server: 'meta' }],
    ['get_tool_schema', { description: 'meta', server: 'meta' }],
    ['invoke_tool', { description: 'meta', server: 'meta' }],
  ]);

  consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
});

describe('invoke_tool — schema', () => {
  test('exposes the documented inputs', () => {
    expect(invokeToolTool.description.toLowerCase()).toMatch(/invoke|dispatch|tool/);
    expect(invokeToolTool.inputSchema.required).toEqual(['toolName', 'args']);
    expect(invokeToolTool.inputSchema.properties.toolName).toBeDefined();
    expect(invokeToolTool.inputSchema.properties.args).toBeDefined();
    expect(invokeToolTool.server).toBe('meta');
  });
});

describe('invoke_tool — happy path', () => {
  test('dispatches to the named tool with the provided args', async () => {
    const result = await call({
      toolName: 'fetch_url',
      args: { url: 'https://example.com' },
    });
    const body = expectOk(result);
    expect(body.ok).toBe(true);
    expect(okHandler).toHaveBeenCalledTimes(1);
    expect(okHandler.mock.calls[0][0]).toEqual({ url: 'https://example.com' });
  });

  test('passes the unmodified context through to the dispatched tool', async () => {
    const ctx = makeMockContext({
      runId: 'run-pass-through',
      nodeId: 'node-pass',
      state: { userId: 'u-pass', toolToolsConfig: undefined },
    });
    await call({ toolName: 'fetch_url', args: {} }, ctx);
    const passedCtx = okHandler.mock.calls[0][1];
    expect(passedCtx.runId).toBe('run-pass-through');
    expect(passedCtx.nodeId).toBe('node-pass');
    expect(passedCtx.state.userId).toBe('u-pass');
  });

  test('result is returned UNMODIFIED (pass-through MCP shape)', async () => {
    okHandler.mockImplementationOnce(async () => ({
      content: [{ type: 'text', text: 'raw inner text' }],
    }));
    const result = await call({ toolName: 'fetch_url', args: {} });
    expect(result.content[0].text).toBe('raw inner text');
    expect(result.isError).toBeFalsy();
  });

  test('isError: true result from the inner tool flows through unchanged', async () => {
    const result = await call({ toolName: 'error_result_tool', args: {} });
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.inner).toBe('fail');
  });

  test('whitespace around toolName is trimmed', async () => {
    await call({ toolName: '  fetch_url  ', args: {} });
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  test('empty args object is allowed', async () => {
    await call({ toolName: 'fetch_url', args: {} });
    expect(okHandler).toHaveBeenCalledWith({}, expect.any(Object));
  });
});

describe('invoke_tool — META_RECURSION_BLOCKED', () => {
  test('refuses to dispatch to invoke_tool itself', async () => {
    const result = await call({
      toolName: 'invoke_tool',
      args: { toolName: 'fetch_url', args: {} },
    });
    const body = expectErr(result);
    expect(body.code).toBe('META_RECURSION_BLOCKED');
  });

  test('refuses to dispatch to list_available_tools', async () => {
    const result = await call({ toolName: 'list_available_tools', args: {} });
    const body = expectErr(result);
    expect(body.code).toBe('META_RECURSION_BLOCKED');
  });

  test('refuses to dispatch to get_tool_schema', async () => {
    const result = await call({
      toolName: 'get_tool_schema',
      args: { toolName: 'fetch_url' },
    });
    const body = expectErr(result);
    expect(body.code).toBe('META_RECURSION_BLOCKED');
  });

  test('refusal happens BEFORE registry lookup (no audit log emitted)', async () => {
    consoleSpy.mockClear();
    await call({ toolName: 'invoke_tool', args: {} });
    const metaLogs = consoleSpy.mock.calls.filter((c) =>
      String(c[0]).includes('[meta-pack] invoking'),
    );
    expect(metaLogs).toHaveLength(0);
  });
});

describe('invoke_tool — TOOL_NOT_FOUND', () => {
  test('unknown tool name → TOOL_NOT_FOUND', async () => {
    const result = await call({ toolName: 'nonexistent', args: {} });
    const body = expectErr(result);
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });

  test('not-found does NOT call the handler', async () => {
    await call({ toolName: 'nonexistent', args: {} });
    expect(okHandler).not.toHaveBeenCalled();
  });
});

describe('invoke_tool — deny config', () => {
  test('exact-match deny → TOOL_NOT_FOUND (existence is hidden)', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['fetch_url'] } },
    });
    const result = await call({ toolName: 'fetch_url', args: {} }, ctx);
    const body = expectErr(result);
    expect(body.code).toBe('TOOL_NOT_FOUND');
    expect(okHandler).not.toHaveBeenCalled();
  });

  test('glob deny matches across a family', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['fs_*'] } },
    });
    const r1 = await call({ toolName: 'fs_read', args: {} }, ctx);
    const r2 = await call({ toolName: 'fs_write', args: {} }, ctx);
    expect(expectErr(r1).code).toBe('TOOL_NOT_FOUND');
    expect(expectErr(r2).code).toBe('TOOL_NOT_FOUND');
  });

  test('deny patterns are independent — non-matching tools still pass', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['delete_*'] } },
    });
    await call({ toolName: 'fetch_url', args: { url: 'x' } }, ctx);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  test('multiple deny patterns combine', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['fs_*', 'delete_*'] } },
    });
    const r1 = await call({ toolName: 'fs_read', args: {} }, ctx);
    const r2 = await call({ toolName: 'delete_document', args: {} }, ctx);
    expect(expectErr(r1).code).toBe('TOOL_NOT_FOUND');
    expect(expectErr(r2).code).toBe('TOOL_NOT_FOUND');
  });
});

describe('invoke_tool — allow config', () => {
  test('allowed tool dispatches normally', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fetch_url'] } },
    });
    const result = await call({ toolName: 'fetch_url', args: {} }, ctx);
    expectOk(result);
    expect(okHandler).toHaveBeenCalledTimes(1);
  });

  test('not-allowed tool → TOOL_NOT_FOUND', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fs_*'] } },
    });
    const result = await call({ toolName: 'fetch_url', args: {} }, ctx);
    expect(expectErr(result).code).toBe('TOOL_NOT_FOUND');
  });

  test('glob allow with wildcard', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fs_*'] } },
    });
    const result = await call({ toolName: 'fs_read', args: {} }, ctx);
    expectOk(result);
  });

  test('deny short-circuits before allow check', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['*'], deny: ['fetch_*'] } },
    });
    const result = await call({ toolName: 'fetch_url', args: {} }, ctx);
    expect(expectErr(result).code).toBe('TOOL_NOT_FOUND');
    expect(okHandler).not.toHaveBeenCalled();
  });

  test('empty allow array is treated as no-allow (everything allowed)', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: [] } },
    });
    const result = await call({ toolName: 'fetch_url', args: {} }, ctx);
    expectOk(result);
  });
});

describe('invoke_tool — error handling', () => {
  test('inner tool throws → wrapped as DISPATCH_ERROR', async () => {
    const result = await call({ toolName: 'throwing_tool', args: {} });
    const body = expectErr(result);
    expect(body.code).toBe('DISPATCH_ERROR');
    expect(body.error).toMatch(/throwing_tool/);
    expect(body.error).toMatch(/boom inside tool/);
  });

  test('non-Error thrown by inner tool is stringified into the error', async () => {
    setMockTools([
      [
        'string_thrower',
        {
          handler: async () => {
            throw 'plain string error';
          },
        },
      ],
    ]);
    const result = await call({ toolName: 'string_thrower', args: {} });
    const body = expectErr(result);
    expect(body.code).toBe('DISPATCH_ERROR');
    expect(body.error).toMatch(/plain string error/);
  });
});

describe('invoke_tool — validation', () => {
  test('missing toolName → VALIDATION', async () => {
    const result = await call({ args: {} });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('non-string toolName → VALIDATION', async () => {
    const result = await call({ toolName: 42, args: {} });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('empty-string toolName → VALIDATION', async () => {
    const result = await call({ toolName: '', args: {} });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('missing args → VALIDATION', async () => {
    const result = await call({ toolName: 'fetch_url' });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('non-object args → VALIDATION', async () => {
    const result = await call({ toolName: 'fetch_url', args: 'not-an-object' });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('array args → VALIDATION (must be object, not array)', async () => {
    const result = await call({ toolName: 'fetch_url', args: ['x', 'y'] });
    expect(expectErr(result).code).toBe('VALIDATION');
  });

  test('null args → VALIDATION', async () => {
    const result = await call({ toolName: 'fetch_url', args: null });
    expect(expectErr(result).code).toBe('VALIDATION');
  });
});

describe('invoke_tool — audit logging', () => {
  test('emits "[meta-pack] invoking" log line on successful dispatch', async () => {
    consoleSpy.mockClear();
    await call({ toolName: 'fetch_url', args: { url: 'https://x' } });
    const found = consoleSpy.mock.calls.some((c) =>
      String(c[0]).startsWith('[meta-pack] invoking fetch_url'),
    );
    expect(found).toBe(true);
  });

  test('audit line includes the runId from context', async () => {
    consoleSpy.mockClear();
    const ctx = makeMockContext({ runId: 'run-audit-123' });
    await call({ toolName: 'fetch_url', args: {} }, ctx);
    const matched = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes('run=run-audit-123'),
    );
    expect(matched).toBeDefined();
  });

  test('audit line falls back to "unknown" when runId is null', async () => {
    consoleSpy.mockClear();
    const ctx = makeMockContext({ runId: null });
    await call({ toolName: 'fetch_url', args: {} }, ctx);
    const matched = consoleSpy.mock.calls.find((c) =>
      String(c[0]).includes('run=unknown'),
    );
    expect(matched).toBeDefined();
  });

  test('audit line emits even when the tool throws', async () => {
    consoleSpy.mockClear();
    await call({ toolName: 'throwing_tool', args: {} });
    const found = consoleSpy.mock.calls.some((c) =>
      String(c[0]).startsWith('[meta-pack] invoking throwing_tool'),
    );
    expect(found).toBe(true);
  });

  test('NO audit line for blocked meta-recursion (denied before lookup)', async () => {
    consoleSpy.mockClear();
    await call({ toolName: 'invoke_tool', args: {} });
    const found = consoleSpy.mock.calls.some((c) =>
      String(c[0]).startsWith('[meta-pack] invoking invoke_tool'),
    );
    expect(found).toBe(false);
  });

  test('NO audit line for not-found tool', async () => {
    consoleSpy.mockClear();
    await call({ toolName: 'nonexistent', args: {} });
    const found = consoleSpy.mock.calls.some((c) =>
      String(c[0]).includes('[meta-pack] invoking'),
    );
    expect(found).toBe(false);
  });
});
