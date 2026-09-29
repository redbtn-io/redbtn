/**
 * Run-scoped MCP client: the neuron tool loop reaches MCP through the run
 * context's `mcpClient`, which is bound to the GRAPH OWNER. This exercises the
 * real path — tool-resolver -> run mcpClient -> McpRegistry -> McpClientSSE —
 * for a graph that references an account-owned tool by bare name
 * (`{ name, source: 'mcp' }`, how the Become AI graph does it) with a per-call
 * end-user bearer (the neuron step's `toolCredentials`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpRegistry } from '../../src/lib/mcp/registry';
import { createRunMcpClient, resolveRunMcpScope } from '../../src/lib/mcp/run-scope';
import { resolveTools } from '../../src/lib/tools/tool-resolver';

const OWNER = 'graph-owner';
const OTHER = 'someone-else';

describe('run-scoped MCP client', () => {
  let requests: Array<{ url: string; headers: Record<string, string>; body: any }>;

  beforeEach(() => {
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url: any, init: any) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url: String(url), headers: { ...(init?.headers ?? {}) }, body });
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: body?.id, result: { content: [{ type: 'text', text: '{"streak":7}' }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function registry() {
    const reg = new McpRegistry();
    await reg.registerStaticServer({
      name: `Become@${OWNER}`,
      url: 'https://gw.example/become/data',
      tools: ['become_get_progress'],
      messagePath: '',
      ownerUserId: OWNER,
    });
    return reg;
  }

  function stateFor(reg: McpRegistry, graphOwner: string, runUser: string) {
    return {
      data: {},
      mcpClient: createRunMcpClient(
        (name, args, meta, signal, scope) => reg.callTool(name, args, meta as any, signal, scope),
        resolveRunMcpScope({ userId: graphOwner }, runUser),
      ),
    } as Record<string, unknown>;
  }

  it('scopes to the graph owner, not the invoking user', () => {
    expect(resolveRunMcpScope({ userId: OWNER }, OTHER)).toEqual({ userId: OWNER });
    expect(resolveRunMcpScope({}, OTHER)).toEqual({ userId: OTHER });
    expect(resolveRunMcpScope(undefined, undefined)).toEqual({});
  });

  it("lets the owner's graph call its account tool with the end-user bearer", async () => {
    const reg = await registry();
    // Invoked by someone else, but the graph belongs to OWNER.
    const state = stateFor(reg, OWNER, OTHER);
    const [tool] = await resolveTools([{ name: 'become_get_progress', source: 'mcp' } as any], state);

    const out = await tool.invoke({}, {
      state, runId: 'r1', toolId: 't1', abortSignal: null,
      credentials: { type: 'bearer', headers: { Authorization: 'Bearer end-user' } },
    });

    expect(out).toEqual({ streak: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe('Bearer end-user');
  });

  it("does not expose the account tool to another account's graph", async () => {
    const reg = await registry();
    const state = stateFor(reg, OTHER, OTHER);
    const [tool] = await resolveTools([{ name: 'become_get_progress', source: 'mcp' } as any], state);

    await expect(tool.invoke({}, {
      state, runId: 'r2', toolId: 't2', abortSignal: null,
      credentials: { type: 'bearer', headers: { Authorization: 'Bearer end-user' } },
    })).rejects.toThrow('Tool not found: become_get_progress');
    expect(requests).toHaveLength(0);
  });

  it('keeps the scope fixed even if the caller mutates it', async () => {
    const reg = await registry();
    const client = createRunMcpClient(
      (name, args, meta, signal, scope) => reg.callTool(name, args, meta as any, signal, scope),
      { userId: OTHER },
    );
    expect(() => { (client.scope as any).userId = OWNER; }).toThrow();
    await expect(client.callTool('become_get_progress', {})).rejects.toThrow('Tool not found');
  });
});
