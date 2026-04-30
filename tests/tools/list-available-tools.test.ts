/**
 * Vitest for native tool: list_available_tools
 *
 * Per META-PACK-HANDOFF.md §6 — happy path + filters + allow/deny + glob
 * pattern matching + meta-tool stripping.
 *
 * The tool reads from the singleton registry, so we hook around `getNativeRegistry`
 * via vitest's `vi.mock` to inject a deterministic catalogue. This keeps the
 * tests fast (no MCP/Mongo/Redis) and isolates from whatever the real registry
 * happens to have wired at the moment.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import type {
  NativeToolContext,
  NativeToolInfo,
} from '../../src/lib/tools/native-registry';

// Build a deterministic mock registry. Exported via the mock factory so the
// tool sees it under the same identity it would in production.
const mockTools: NativeToolInfo[] = [];

vi.mock('../../src/lib/tools/native-registry', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/tools/native-registry')
  >('../../src/lib/tools/native-registry');
  return {
    ...actual,
    getNativeRegistry: () => ({
      listTools: () => mockTools.slice(),
      get: (name: string) =>
        mockTools.find((t) => t.name === name)
          ? { description: '', inputSchema: {}, server: 'system', handler: async () => ({ content: [] }) }
          : undefined,
      has: (name: string) => mockTools.some((t) => t.name === name),
    }),
  };
});

import listAvailableToolsTool, {
  matchesPattern,
  isAllowed,
  META_TOOL_NAMES,
} from '../../src/lib/tools/native/list-available-tools';

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
  tools: Array<{ name: string; description: string; server: string }>;
  total: number;
}> {
  return listAvailableToolsTool
    .handler(args, ctx ?? makeMockContext())
    .then((r) => {
      expect(r.isError).toBeFalsy();
      return JSON.parse(r.content[0].text);
    });
}

function callErr(args: Record<string, unknown>, ctx?: NativeToolContext) {
  return listAvailableToolsTool
    .handler(args, ctx ?? makeMockContext())
    .then((r) => {
      expect(r.isError).toBe(true);
      return JSON.parse(r.content[0].text);
    });
}

function setMockCatalogue(tools: NativeToolInfo[]): void {
  mockTools.length = 0;
  mockTools.push(...tools);
}

const baseFixture: NativeToolInfo[] = [
  { name: 'fetch_url', description: 'Fetch a URL via HTTP', inputSchema: {}, server: 'web' },
  { name: 'web_search', description: 'Google Custom Search', inputSchema: {}, server: 'web' },
  { name: 'fs_read', description: 'Read a file', inputSchema: {}, server: 'fs' },
  { name: 'fs_write', description: 'Write a file', inputSchema: {}, server: 'fs' },
  { name: 'delete_document', description: 'Delete a document', inputSchema: {}, server: 'library' },
  { name: 'send_email', description: 'Send email', inputSchema: {}, server: 'notifications' },
  { name: 'task_create', description: 'Create a task', inputSchema: {}, server: 'task' },
  // The three meta tools — these MUST be stripped from results
  { name: 'list_available_tools', description: 'meta', inputSchema: {}, server: 'meta' },
  { name: 'get_tool_schema', description: 'meta', inputSchema: {}, server: 'meta' },
  { name: 'invoke_tool', description: 'meta', inputSchema: {}, server: 'meta' },
];

beforeEach(() => {
  setMockCatalogue(baseFixture);
});

describe('list_available_tools — schema', () => {
  test('exposes the documented inputs', () => {
    expect(listAvailableToolsTool.description.toLowerCase()).toMatch(
      /list|discover|tool/,
    );
    expect(listAvailableToolsTool.inputSchema.required).toEqual([]);
    expect(listAvailableToolsTool.inputSchema.properties.filter).toBeDefined();
    expect(listAvailableToolsTool.inputSchema.properties.source).toBeDefined();
    expect(listAvailableToolsTool.inputSchema.properties.source.enum).toEqual([
      'native',
    ]);
    expect(listAvailableToolsTool.server).toBe('meta');
  });

  test('META_TOOL_NAMES exposes the three meta tools', () => {
    expect(META_TOOL_NAMES.has('list_available_tools')).toBe(true);
    expect(META_TOOL_NAMES.has('get_tool_schema')).toBe(true);
    expect(META_TOOL_NAMES.has('invoke_tool')).toBe(true);
    expect(META_TOOL_NAMES.has('fetch_url')).toBe(false);
  });
});

describe('list_available_tools — happy path', () => {
  test('default args returns the full non-meta catalogue', async () => {
    const body = await callOk({});
    // 7 non-meta + 3 meta = 10; only 7 should remain
    expect(body.total).toBe(7);
    expect(body.tools).toHaveLength(7);
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('fetch_url');
    expect(names).toContain('fs_read');
    expect(names).toContain('task_create');
  });

  test('strips all three meta tools from the listing', async () => {
    const body = await callOk({});
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('list_available_tools');
    expect(names).not.toContain('get_tool_schema');
    expect(names).not.toContain('invoke_tool');
  });

  test('returns name, description, server (NOT inputSchema)', async () => {
    const body = await callOk({});
    const sample = body.tools[0];
    expect(sample.name).toBeTypeOf('string');
    expect(sample.description).toBeTypeOf('string');
    expect(sample.server).toBeTypeOf('string');
    // Must not include inputSchema (keep payload small)
    expect((sample as Record<string, unknown>).inputSchema).toBeUndefined();
  });

  test('source=native is accepted', async () => {
    const body = await callOk({ source: 'native' });
    expect(body.total).toBe(7);
  });

  test('empty catalogue returns total=0', async () => {
    setMockCatalogue([]);
    const body = await callOk({});
    expect(body.total).toBe(0);
    expect(body.tools).toEqual([]);
  });
});

describe('list_available_tools — filter', () => {
  test('substring matches against tool name (case-insensitive)', async () => {
    const body = await callOk({ filter: 'FETCH' });
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('fetch_url');
    expect(names).not.toContain('fs_read');
  });

  test('substring matches against tool description', async () => {
    const body = await callOk({ filter: 'google' });
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('web_search');
  });

  test('whitespace-only filter is treated as no filter', async () => {
    const body = await callOk({ filter: '   ' });
    expect(body.total).toBe(7);
  });

  test('non-matching filter returns empty list', async () => {
    const body = await callOk({ filter: 'nonexistent-substring' });
    expect(body.total).toBe(0);
    expect(body.tools).toEqual([]);
  });
});

describe('list_available_tools — deny config', () => {
  test('exact-match deny removes a single tool', async () => {
    const ctx = makeMockContext({ state: { toolToolsConfig: { deny: ['fetch_url'] } } });
    const body = await callOk({}, ctx);
    expect(body.tools.find((t) => t.name === 'fetch_url')).toBeUndefined();
    expect(body.total).toBe(6);
  });

  test('glob deny removes all matching tools', async () => {
    const ctx = makeMockContext({ state: { toolToolsConfig: { deny: ['fs_*'] } } });
    const body = await callOk({}, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('fs_read');
    expect(names).not.toContain('fs_write');
    expect(names).toContain('fetch_url');
  });

  test('multiple deny patterns combine', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { deny: ['delete_*', 'send_*'] } },
    });
    const body = await callOk({}, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('delete_document');
    expect(names).not.toContain('send_email');
    expect(names).toContain('fetch_url');
  });
});

describe('list_available_tools — allow config', () => {
  test('exact-match allow keeps only the listed tool', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fetch_url'] } },
    });
    const body = await callOk({}, ctx);
    expect(body.tools.map((t) => t.name)).toEqual(['fetch_url']);
  });

  test('glob allow keeps all matching tools', async () => {
    const ctx = makeMockContext({ state: { toolToolsConfig: { allow: ['fs_*'] } } });
    const body = await callOk({}, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['fs_read', 'fs_write']));
    expect(names).not.toContain('fetch_url');
  });

  test('allow=["*"] keeps everything (except meta tools)', async () => {
    const ctx = makeMockContext({ state: { toolToolsConfig: { allow: ['*'] } } });
    const body = await callOk({}, ctx);
    expect(body.total).toBe(7);
  });

  test('deny wins over allow', async () => {
    const ctx = makeMockContext({
      state: {
        toolToolsConfig: { allow: ['*'], deny: ['delete_*'] },
      },
    });
    const body = await callOk({}, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).not.toContain('delete_document');
    expect(names).toContain('fetch_url');
  });

  test('empty allow array does NOT block — degenerate config returns full catalogue', async () => {
    // allow=[] is an empty allowlist; we treat it as "no allow set" so the agent
    // doesn't accidentally lock themselves out by passing in an empty list.
    const ctx = makeMockContext({ state: { toolToolsConfig: { allow: [] } } });
    const body = await callOk({}, ctx);
    expect(body.total).toBe(7);
  });
});

describe('list_available_tools — pattern matcher', () => {
  test('exact match with no wildcards', () => {
    expect(matchesPattern('fetch_url', 'fetch_url')).toBe(true);
    expect(matchesPattern('fetch_url', 'fetch_urlx')).toBe(false);
  });

  test('* matches zero or more characters', () => {
    expect(matchesPattern('fs_read', 'fs_*')).toBe(true);
    expect(matchesPattern('fs_', 'fs_*')).toBe(true);
    expect(matchesPattern('fs', 'fs_*')).toBe(false);
    expect(matchesPattern('delete_document', 'delete_*')).toBe(true);
  });

  test('* in the middle matches', () => {
    expect(matchesPattern('fetch_url_v2', 'fetch_*_v2')).toBe(true);
    expect(matchesPattern('fetch_url_v3', 'fetch_*_v2')).toBe(false);
  });

  test('? matches exactly one character', () => {
    expect(matchesPattern('task_x', 'task_?')).toBe(true);
    expect(matchesPattern('task_xy', 'task_?')).toBe(false);
  });

  test('regex meta-chars in patterns are escaped as literals', () => {
    // A literal `.` should NOT match any char — only a `.`
    expect(matchesPattern('fs_read', 'fs.read')).toBe(false);
    expect(matchesPattern('fs.read', 'fs.read')).toBe(true);
    expect(matchesPattern('fs_read', 'fs_read')).toBe(true);
  });

  test('square brackets are literal (no character classes)', () => {
    expect(matchesPattern('a[b]c', 'a[b]c')).toBe(true);
    expect(matchesPattern('abc', 'a[b]c')).toBe(false);
  });

  test('pipes are literal (no alternation)', () => {
    expect(matchesPattern('a|b', 'a|b')).toBe(true);
    expect(matchesPattern('a', 'a|b')).toBe(false);
    expect(matchesPattern('b', 'a|b')).toBe(false);
  });

  test('isAllowed with no config allows everything', () => {
    expect(isAllowed('fetch_url')).toBe(true);
    expect(isAllowed('fetch_url', null)).toBe(true);
    expect(isAllowed('fetch_url', undefined)).toBe(true);
    expect(isAllowed('fetch_url', {})).toBe(true);
  });

  test('isAllowed: deny short-circuits even with matching allow', () => {
    expect(
      isAllowed('fs_read', { allow: ['fs_*'], deny: ['fs_read'] }),
    ).toBe(false);
  });

  test('isAllowed: empty allow array is treated as no-allow (everything allowed)', () => {
    expect(isAllowed('fetch_url', { allow: [] })).toBe(true);
  });
});

describe('list_available_tools — validation errors', () => {
  test('non-string filter → VALIDATION', async () => {
    const body = await callErr({ filter: 42 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/filter/i);
  });

  test('non-string source → VALIDATION', async () => {
    const body = await callErr({ source: 99 });
    expect(body.code).toBe('VALIDATION');
  });

  test('source other than native → VALIDATION', async () => {
    const body = await callErr({ source: 'mcp' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/native/i);
  });
});

describe('list_available_tools — combined scenarios', () => {
  test('filter + deny stack', async () => {
    const ctx = makeMockContext({ state: { toolToolsConfig: { deny: ['fs_write'] } } });
    const body = await callOk({ filter: 'fs_' }, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).toContain('fs_read');
    expect(names).not.toContain('fs_write');
  });

  test('filter + allow stack — only matches passing both', async () => {
    const ctx = makeMockContext({
      state: { toolToolsConfig: { allow: ['fetch_*', 'fs_*'] } },
    });
    const body = await callOk({ filter: 'fetch' }, ctx);
    const names = body.tools.map((t) => t.name);
    expect(names).toEqual(['fetch_url']);
  });
});
