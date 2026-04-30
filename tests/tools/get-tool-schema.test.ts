/**
 * Vitest for native tool: get_tool_schema
 *
 * Per META-PACK-HANDOFF.md §6 — happy path + missing + meta-tool refusal +
 * deny-as-not-found.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type {
  NativeToolContext,
  NativeToolDefinition,
} from '../../src/lib/tools/native-registry';

// Build a deterministic mock registry: a flat name → NativeToolDefinition map.
// Reset in beforeEach.
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

import getToolSchemaTool from '../../src/lib/tools/native/get-tool-schema';

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

function callOk(args: Record<string, unknown>, ctx?: NativeToolContext): Promise<{
  name: string;
  description: string;
  server: string;
  inputSchema: Record<string, unknown>;
}> {
  return getToolSchemaTool.handler(args, ctx ?? makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>, ctx?: NativeToolContext) {
  return getToolSchemaTool.handler(args, ctx ?? makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

function setMockTools(entries: Array<[string, Partial<NativeToolDefinition>]>): void {
  mockRegistry.clear();
  for (const [name, def] of entries) {
    mockRegistry.set(name, {
      description: def.description ?? 'A test tool',
      inputSchema: def.inputSchema ?? { type: 'object', properties: {} },
      // NOTE: pass-through `server` exactly as the caller specified — including
      // `undefined` — so the tool's "default to 'system'" behaviour is testable.
      // Use `'server' in def` to detect the explicit-undefined case vs missing.
      server: 'server' in def ? def.server : 'test',
      handler: async () => ({ content: [{ type: 'text', text: '{}' }] }),
    });
  }
}

beforeEach(() => {
  setMockTools([
    [
      'fetch_url',
      {
        description: 'Fetch a URL via HTTP',
        server: 'web',
        inputSchema: {
          type: 'object',
          required: ['url'],
          properties: { url: { type: 'string' } },
        },
      },
    ],
    [
      'fs_read',
      {
        description: 'Read a file',
        server: 'fs',
        inputSchema: {
          type: 'object',
          required: ['environmentId', 'path'],
          properties: {
            environmentId: { type: 'string' },
            path: { type: 'string' },
          },
        },
      },
    ],
    ['delete_document', { description: 'Delete a doc', server: 'library' }],
    // The meta tools — must always refuse introspection
    ['list_available_tools', { description: 'meta', server: 'meta' }],
    ['get_tool_schema', { description: 'meta', server: 'meta' }],
    ['invoke_tool', { description: 'meta', server: 'meta' }],
  ]);
});

describe('get_tool_schema — schema', () => {
  test('exposes the documented inputs', () => {
    expect(getToolSchemaTool.description.toLowerCase()).toMatch(/schema|input/);
    expect(getToolSchemaTool.inputSchema.required).toEqual(['toolName']);
    expect(getToolSchemaTool.inputSchema.properties.toolName).toBeDefined();
    expect(getToolSchemaTool.server).toBe('meta');
  });
});

describe('get_tool_schema — happy path', () => {
  test('returns name, description, server, inputSchema for a known tool', async () => {
    const body = await callOk({ toolName: 'fetch_url' });
    expect(body.name).toBe('fetch_url');
    expect(body.description).toBe('Fetch a URL via HTTP');
    expect(body.server).toBe('web');
    expect(body.inputSchema).toBeDefined();
    expect(body.inputSchema.required).toEqual(['url']);
    expect(body.inputSchema.properties).toBeDefined();
  });

  test('returns the FULL inputSchema (not just metadata)', async () => {
    const body = await callOk({ toolName: 'fs_read' });
    expect(body.inputSchema.required).toEqual(['environmentId', 'path']);
    expect(body.inputSchema.properties.environmentId).toBeDefined();
    expect(body.inputSchema.properties.path).toBeDefined();
  });

  test('whitespace around toolName is trimmed', async () => {
    const body = await callOk({ toolName: '  fetch_url  ' });
    expect(body.name).toBe('fetch_url');
  });

  test('server defaults to "system" when undefined', async () => {
    setMockTools([
      [
        'no_server_tool',
        {
          description: 'no server set',
          server: undefined,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    ]);
    const body = await callOk({ toolName: 'no_server_tool' });
    expect(body.server).toBe('system');
  });
});

describe('get_tool_schema — TOOL_NOT_FOUND', () => {
  test('unknown tool name → TOOL_NOT_FOUND', async () => {
    const body = await callErr({ toolName: 'nonexistent_tool' });
    expect(body.code).toBe('TOOL_NOT_FOUND');
    expect(body.error).toMatch(/nonexistent_tool/);
  });

  test('case mismatch is treated as not-found (names are exact)', async () => {
    const body = await callErr({ toolName: 'FETCH_URL' });
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });
});

describe('get_tool_schema — meta-tool refusal', () => {
  test('list_available_tools is not introspectable', async () => {
    const body = await callErr({ toolName: 'list_available_tools' });
    expect(body.code).toBe('META_TOOL_NOT_INTROSPECTABLE');
  });

  test('get_tool_schema is not introspectable (self-reference)', async () => {
    const body = await callErr({ toolName: 'get_tool_schema' });
    expect(body.code).toBe('META_TOOL_NOT_INTROSPECTABLE');
  });

  test('invoke_tool is not introspectable', async () => {
    const body = await callErr({ toolName: 'invoke_tool' });
    expect(body.code).toBe('META_TOOL_NOT_INTROSPECTABLE');
  });
});

describe('get_tool_schema — deny config (returns TOOL_NOT_FOUND, not a special code)', () => {
  test('exact-deny tool reports TOOL_NOT_FOUND (existence is hidden)', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['fetch_url'] } },
    });
    const body = await callErr({ toolName: 'fetch_url' }, ctx);
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });

  test('glob-denied tool reports TOOL_NOT_FOUND', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['fs_*'] } },
    });
    const body = await callErr({ toolName: 'fs_read' }, ctx);
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });

  test('non-denied tool still resolvable when deny is set', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['delete_*'] } },
    });
    const body = await callOk({ toolName: 'fetch_url' }, ctx);
    expect(body.name).toBe('fetch_url');
  });
});

describe('get_tool_schema — allow config', () => {
  test('tool not in allow list reports TOOL_NOT_FOUND', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fs_*'] } },
    });
    const body = await callErr({ toolName: 'fetch_url' }, ctx);
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });

  test('tool in allow list resolves normally', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fetch_url', 'fs_*'] } },
    });
    const body = await callOk({ toolName: 'fetch_url' }, ctx);
    expect(body.name).toBe('fetch_url');
  });

  test('deny wins over allow', async () => {
    const ctx = makeMockContext({
      state: {
        toolToolsConfig: { allow: ['*'], deny: ['fetch_url'] },
      },
    });
    const body = await callErr({ toolName: 'fetch_url' }, ctx);
    expect(body.code).toBe('TOOL_NOT_FOUND');
  });

  test('glob allow matches tool with wildcard', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fs_*'] } },
    });
    const body = await callOk({ toolName: 'fs_read' }, ctx);
    expect(body.name).toBe('fs_read');
  });
});

describe('get_tool_schema — validation errors', () => {
  test('missing toolName → VALIDATION', async () => {
    const body = await callErr({});
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/toolName/);
  });

  test('non-string toolName → VALIDATION', async () => {
    const body = await callErr({ toolName: 42 });
    expect(body.code).toBe('VALIDATION');
  });

  test('empty-string toolName → VALIDATION', async () => {
    const body = await callErr({ toolName: '' });
    expect(body.code).toBe('VALIDATION');
  });

  test('whitespace-only toolName → VALIDATION', async () => {
    const body = await callErr({ toolName: '   ' });
    expect(body.code).toBe('VALIDATION');
  });
});
