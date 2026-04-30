/**
 * Integration test for the meta pack ("tool tools").
 *
 * Per META-PACK-HANDOFF.md §6 — runs the canonical agent flow that uses the
 * three meta tools in sequence:
 *
 *   1. list_available_tools          → discover what tools exist
 *   2. get_tool_schema(toolName)     → inspect inputs for a chosen tool
 *   3. invoke_tool(toolName, args)   → dispatch
 *
 * The pack has zero external dependencies — it's a thin wrapper over the
 * NativeToolRegistry singleton. So instead of mocking HTTP/Mongo/Redis we
 * register a couple of fake "domain" tools alongside the meta tools and
 * exercise the full end-to-end agent loop.
 *
 * The chain validates:
 *   - Registry has all 3 meta tools wired.
 *   - The catalogue strips meta tools from the listing.
 *   - get_tool_schema returns the registered tool's inputSchema unchanged.
 *   - invoke_tool dispatches to the registered tool, passes args through, and
 *     returns the underlying tool's MCP result unmodified.
 *   - Safety rails — meta-recursion blocked, deny-list enforced, audit log
 *     emitted on dispatch.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
  type NativeToolDefinition,
  type NativeMcpResult,
} from '../../src/lib/tools/native-registry';

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run executing the TS sources
// directly, those .js paths don't exist next to the .ts module — the catch
// block silently swallows the failure. We work around it by importing the TS
// modules and explicitly re-registering them with the singleton.
import listAvailableToolsTool from '../../src/lib/tools/native/list-available-tools';
import getToolSchemaTool from '../../src/lib/tools/native/get-tool-schema';
import invokeToolTool from '../../src/lib/tools/native/invoke-tool';

// ── Fake domain tools to populate the registry alongside the meta tools ───
const greetingHandler = vi.fn<
  (args: Record<string, unknown>, ctx: NativeToolContext) => Promise<NativeMcpResult>
>();
greetingHandler.mockImplementation(async (args) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ greeting: `Hello, ${args.name ?? 'world'}!` }),
    },
  ],
}));

const greetingTool: NativeToolDefinition = {
  description:
    'Generate a greeting for the supplied name. Returns { greeting }.',
  server: 'demo',
  inputSchema: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', description: 'Name to greet.' },
      enthusiastic: {
        type: 'boolean',
        description: 'Add an exclamation mark.',
        default: true,
      },
    },
  },
  handler: greetingHandler,
};

const arithmeticTool: NativeToolDefinition = {
  description: 'Sum a list of numbers. Returns { total }.',
  server: 'demo',
  inputSchema: {
    type: 'object',
    required: ['numbers'],
    properties: {
      numbers: {
        type: 'array',
        items: { type: 'number' },
        description: 'Array of numbers to sum.',
      },
    },
  },
  handler: async (args: Record<string, unknown>): Promise<NativeMcpResult> => {
    const nums = (args.numbers as number[]) ?? [];
    const total = nums.reduce((a, b) => a + b, 0);
    return {
      content: [{ type: 'text', text: JSON.stringify({ total }) }],
    };
  },
};

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'integration-meta-' + Date.now(),
    nodeId: 'integration-meta-node',
    toolId: 'integration-meta-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

describe('meta pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('list_available_tools'))
      registry.register('list_available_tools', listAvailableToolsTool);
    if (!registry.has('get_tool_schema'))
      registry.register('get_tool_schema', getToolSchemaTool);
    if (!registry.has('invoke_tool'))
      registry.register('invoke_tool', invokeToolTool);

    // Domain tools the agent will discover + invoke
    registry.register('greet', greetingTool);
    registry.register('arithmetic_sum', arithmeticTool);
  });

  beforeEach(() => {
    greetingHandler.mockClear();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  test('NativeToolRegistry has all 3 meta-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of ['list_available_tools', 'get_tool_schema', 'invoke_tool']) {
      expect(registry.has(name)).toBe(true);
    }
    // All three share the 'meta' server label
    for (const name of ['list_available_tools', 'get_tool_schema', 'invoke_tool']) {
      expect(registry.get(name)?.server).toBe('meta');
    }
  });

  describe('end-to-end: list → schema → invoke', () => {
    test('agent discovers the catalogue, inspects schema, invokes a tool', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // ── 1. list_available_tools ──────────────────────────────────────────
      const listResult = await registry.callTool(
        'list_available_tools',
        {},
        ctx,
      );
      expect(listResult.isError).toBeFalsy();
      const listBody = JSON.parse(listResult.content[0].text) as {
        tools: Array<{ name: string; description: string; server: string }>;
        total: number;
      };

      // The two demo tools must appear in the catalogue
      const names = listBody.tools.map((t) => t.name);
      expect(names).toContain('greet');
      expect(names).toContain('arithmetic_sum');

      // The meta tools themselves must NOT appear
      expect(names).not.toContain('list_available_tools');
      expect(names).not.toContain('get_tool_schema');
      expect(names).not.toContain('invoke_tool');

      // ── 2. get_tool_schema — inspect the chosen tool ─────────────────────
      const schemaResult = await registry.callTool(
        'get_tool_schema',
        { toolName: 'greet' },
        ctx,
      );
      expect(schemaResult.isError).toBeFalsy();
      const schemaBody = JSON.parse(schemaResult.content[0].text) as {
        name: string;
        inputSchema: { required: string[]; properties: Record<string, unknown> };
        server: string;
      };
      expect(schemaBody.name).toBe('greet');
      expect(schemaBody.server).toBe('demo');
      expect(schemaBody.inputSchema.required).toEqual(['name']);
      expect(schemaBody.inputSchema.properties.name).toBeDefined();

      // The agent now knows it needs to provide `{ name: string }`.
      const requiredField = schemaBody.inputSchema.required[0];

      // ── 3. invoke_tool — dispatch to the chosen tool ─────────────────────
      const invokeResult = await registry.callTool(
        'invoke_tool',
        {
          toolName: 'greet',
          args: { [requiredField]: 'Agent', enthusiastic: true },
        },
        ctx,
      );
      expect(invokeResult.isError).toBeFalsy();
      const invokeBody = JSON.parse(invokeResult.content[0].text) as {
        greeting: string;
      };
      expect(invokeBody.greeting).toBe('Hello, Agent!');

      // Underlying tool was called with the agent-constructed args.
      expect(greetingHandler).toHaveBeenCalledTimes(1);
      expect(greetingHandler.mock.calls[0][0]).toEqual({
        name: 'Agent',
        enthusiastic: true,
      });

      // Audit log line was emitted with the runId.
      const auditLine = consoleSpy.mock.calls.find((c) =>
        String(c[0]).includes('[meta-pack] invoking greet'),
      );
      expect(auditLine).toBeDefined();
      expect(String(auditLine![0])).toContain(`run=${ctx.runId}`);
    });

    test('agent flow over a second domain tool — arithmetic_sum', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      const listResult = await registry.callTool('list_available_tools', { filter: 'sum' }, ctx);
      const listBody = JSON.parse(listResult.content[0].text);
      expect(listBody.tools.find((t: { name: string }) => t.name === 'arithmetic_sum'))
        .toBeDefined();

      const schemaResult = await registry.callTool(
        'get_tool_schema',
        { toolName: 'arithmetic_sum' },
        ctx,
      );
      const schemaBody = JSON.parse(schemaResult.content[0].text);
      expect(schemaBody.inputSchema.required).toEqual(['numbers']);

      const invokeResult = await registry.callTool(
        'invoke_tool',
        { toolName: 'arithmetic_sum', args: { numbers: [1, 2, 3, 4] } },
        ctx,
      );
      const invokeBody = JSON.parse(invokeResult.content[0].text);
      expect(invokeBody.total).toBe(10);
    });
  });

  describe('safety rails enforced end-to-end', () => {
    test('agent attempt to invoke invoke_tool itself is blocked', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();
      const result = await registry.callTool(
        'invoke_tool',
        { toolName: 'invoke_tool', args: { toolName: 'greet', args: {} } },
        ctx,
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('META_RECURSION_BLOCKED');
    });

    test('agent attempt to introspect invoke_tool is blocked', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();
      const result = await registry.callTool(
        'get_tool_schema',
        { toolName: 'invoke_tool' },
        ctx,
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.code).toBe('META_TOOL_NOT_INTROSPECTABLE');
    });

    test('deny-list hides a tool across all three meta tools (consistent surface)', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext({
        state: { toolToolsConfig: { deny: ['arithmetic_*'] } },
      });

      // 1. list — hidden
      const listResult = await registry.callTool('list_available_tools', {}, ctx);
      const listBody = JSON.parse(listResult.content[0].text);
      const names = listBody.tools.map((t: { name: string }) => t.name);
      expect(names).not.toContain('arithmetic_sum');
      expect(names).toContain('greet'); // unaffected

      // 2. get_tool_schema — TOOL_NOT_FOUND
      const schemaResult = await registry.callTool(
        'get_tool_schema',
        { toolName: 'arithmetic_sum' },
        ctx,
      );
      expect(schemaResult.isError).toBe(true);
      expect(JSON.parse(schemaResult.content[0].text).code).toBe(
        'TOOL_NOT_FOUND',
      );

      // 3. invoke — TOOL_NOT_FOUND, handler not called
      const invokeResult = await registry.callTool(
        'invoke_tool',
        { toolName: 'arithmetic_sum', args: { numbers: [1] } },
        ctx,
      );
      expect(invokeResult.isError).toBe(true);
      expect(JSON.parse(invokeResult.content[0].text).code).toBe('TOOL_NOT_FOUND');
    });

    test('allow-list scopes the catalogue across the same surface', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext({
        state: { toolToolsConfig: { allow: ['greet'] } },
      });

      // Listing returns ONLY `greet` (other tools hidden)
      const listResult = await registry.callTool('list_available_tools', {}, ctx);
      const listBody = JSON.parse(listResult.content[0].text);
      const names = listBody.tools.map((t: { name: string }) => t.name);
      expect(names).toContain('greet');
      expect(names).not.toContain('arithmetic_sum');

      // Inspecting a non-allowed tool fails
      const schemaResult = await registry.callTool(
        'get_tool_schema',
        { toolName: 'arithmetic_sum' },
        ctx,
      );
      expect(schemaResult.isError).toBe(true);

      // Invoking a non-allowed tool fails
      const invokeResult = await registry.callTool(
        'invoke_tool',
        { toolName: 'arithmetic_sum', args: { numbers: [1] } },
        ctx,
      );
      expect(invokeResult.isError).toBe(true);
    });
  });

  describe('context pass-through', () => {
    test('dispatched tool receives the same context as a direct call', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext({
        runId: 'run-passthrough-id',
        state: { userId: 'agent-user', toolToolsConfig: undefined },
      });

      await registry.callTool(
        'invoke_tool',
        { toolName: 'greet', args: { name: 'X' } },
        ctx,
      );

      expect(greetingHandler).toHaveBeenCalledTimes(1);
      const passedCtx = greetingHandler.mock.calls[0][1];
      expect(passedCtx.runId).toBe('run-passthrough-id');
      expect(passedCtx.state.userId).toBe('agent-user');
    });
  });
});
