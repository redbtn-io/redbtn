/**
 * Per-run MCP tool bridge — the security contract and the wire contract.
 *
 * The bridge is the ONLY real gate on what a `claude -p` child can do: client
 * flags (`--allowedTools`, `--tools ""`) gate nothing under
 * `defaultMode: bypassPermissions`, which is the fleet standard. So these tests
 * are the specification:
 *
 *   - `tools/list` is `node.tools ∩ native registry − FORBIDDEN`, nothing more.
 *   - Forbidden names are unreachable even when the node declares them and even
 *     when the client calls them directly without listing.
 *   - `environmentId` is invisible in the schema and overwritten on every call.
 *   - Three bad nonces revoke the session and fail the step.
 *   - Aborting the run revokes the bridge.
 *   - `callsTotal` is hard-capped at `maxToolIterations * 4 + 8`.
 *   - The wire is newline-delimited JSON-RPC 2.0 of the shape the CLI expects.
 *
 * The client here is a minimal, dependency-free JSON-RPC-over-UDS speaker — the
 * mirror image of the stdio probe fixture used in the design round
 * (`scratchpad/probe-mcp-stdio.js`, which is a SERVER, so it cannot drive this
 * suite). It exists so conformance is asserted against real bytes on a real
 * socket, not against the handler functions.
 *
 * NOTE: never run this on a fleet box by hand — CI (org runners) runs it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn } from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  startRunToolBridge,
  buildBridgeToolTable,
  isForbiddenForBridge,
  stripEnvironmentIdFromSchema,
  stripPrototypeKeys,
  scrubSecretsForPublish,
  scrubResultForPublish,
  FORBIDDEN_TOOLS,
  CALLER_TRUST_FIX_PRESENT,
  DEFAULT_PROTOCOL_VERSION,
  type RunToolBridge,
  type RunBridgeToolRef,
} from '../../src/lib/mcp/run-bridge';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import { __setRedisForTest } from '../../src/lib/permissions/exec-guard';
import type { CapabilityProfile } from '../../src/lib/permissions/types';

// =============================================================================
// Minimal JSON-RPC client over the bridge's Unix socket
// =============================================================================

interface RpcClient {
  send(method: string, params?: unknown): Promise<any>;
  notify(method: string, params?: unknown): void;
  raw(line: string): void;
  close(): void;
  readonly lines: string[];
  readonly closedPromise: Promise<void>;
}

function connectClient(socketPath: string, nonce: string | null): Promise<RpcClient> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
    const lines: string[] = [];
    let buffer = '';
    let id = 0;
    let closeResolve: () => void = () => {};
    const closedPromise = new Promise<void>((r) => {
      closeResolve = r;
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line.trim()) continue;
        lines.push(line);
        try {
          const msg = JSON.parse(line);
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            waiter.resolve(msg);
          }
        } catch {
          /* not our problem in a test client */
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      for (const waiter of pending.values()) waiter.reject(new Error('socket closed'));
      pending.clear();
      closeResolve();
    });
    socket.on('connect', () => {
      if (nonce !== null) socket.write(`${JSON.stringify({ redbtn: 'auth', nonce })}\n`);
      resolve({
        lines,
        closedPromise,
        send(method, params) {
          const rid = ++id;
          return new Promise((res, rej) => {
            pending.set(rid, { resolve: res, reject: rej });
            socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: rid, method, params })}\n`);
          });
        },
        notify(method, params) {
          socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
        },
        raw(line) {
          socket.write(`${line}\n`);
        },
        close() {
          socket.destroy();
        },
      });
    });
  });
}

// =============================================================================
// Fixtures
// =============================================================================

const RUN_ID = 'run-bridge-test';
const ENV_ID = 'env_run_test123';
const OTHER_ENV = 'env_alphaSystem_do_not_touch';
const WORKING_DIR = '/ws/indy/tree';

/** Args the stub `run_command` actually received, per call. */
let received: Array<{ name: string; args: any }> = [];

const execProfile: CapabilityProfile = {
  name: 'bridge-test-jail',
  capabilities: [{ resource: 'exec', actions: ['execute'], selector: 'env_run_*' }],
};

const RUN_COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The shell command to execute.' },
    cwd: { type: 'string', description: 'Working directory.' },
    timeout: { type: 'integer', minimum: 100 },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    environmentId: { type: 'string', description: 'Override the environment.' },
  },
  required: ['command'],
};

const READ_FILE_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    environmentId: { type: 'string' },
  },
  required: ['path', 'environmentId'],
};

/**
 * An UNMAPPED tool (no `tool-map` rule ⇒ no capability gate, no exec guard), so
 * arg-shaping can be asserted on the arguments a handler actually received
 * without also standing up the exec chain.
 */
const PROBE_SCHEMA = {
  type: 'object',
  properties: {
    note: { type: 'string' },
    cwd: { type: 'string' },
    workingDir: { type: 'string' },
    environmentId: { type: 'string' },
  },
  required: ['note'],
};

/** Node-declared tools: a real name, a forbidden name, an MCP tool, a ghost. */
function nodeTools(): RunBridgeToolRef[] {
  return [
    { name: 'run_command', description: 'run a command', inputSchema: RUN_COMMAND_SCHEMA, source: 'native' },
    { name: 'bridge_probe', description: 'ungated probe', inputSchema: PROBE_SCHEMA, source: 'native' },
    { name: 'read_file', description: 'read a file', inputSchema: READ_FILE_SCHEMA, source: 'native' },
    { name: 'invoke_tool', description: 'meta pack', inputSchema: { type: 'object', properties: {} }, source: 'native' },
    { name: 'ssh_shell', description: 'unscoped shell', inputSchema: { type: 'object', properties: {} }, source: 'native' },
    { name: 'invoke_graph', description: 'another run', inputSchema: { type: 'object', properties: {} }, source: 'native' },
    { name: 'create_neuron', description: 'self-modify', inputSchema: { type: 'object', properties: {} }, source: 'native' },
    { name: 'desktop_click', description: 'computer:control', inputSchema: { type: 'object', properties: {} }, source: 'native' },
    { name: 'fetch_url', description: 'network', inputSchema: { type: 'object', properties: { url: { type: 'string' } } }, source: 'native' },
    { name: 'server.remoteThing', description: 'an MCP tool', inputSchema: { type: 'object', properties: {} }, source: 'mcp' },
    { name: 'not_a_registered_tool', description: 'ghost', inputSchema: { type: 'object', properties: {} }, source: 'native' },
  ];
}

interface Published {
  starts: Array<{ toolId: string; name: string; options: any }>;
  completes: Array<{ toolId: string; result: any }>;
  errors: Array<{ toolId: string; error: string }>;
}

function makePublisher(): { publisher: any; published: Published } {
  const published: Published = { starts: [], completes: [], errors: [] };
  return {
    published,
    publisher: {
      async toolStart(toolId: string, name: string, _type: string, options: any) {
        published.starts.push({ toolId, name, options });
      },
      async toolComplete(toolId: string, result: any) {
        published.completes.push({ toolId, result });
      },
      async toolError(toolId: string, error: string) {
        published.errors.push({ toolId, error });
      },
    },
  };
}

let tmpDir: string;
let bridge: RunToolBridge | null = null;
let clients: RpcClient[] = [];
let originalRunCommand: any;
let originalReadFile: any;

beforeEach(() => {
  received = [];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-bridge-'));

  // Replace `run_command` on the singleton with a recording stub. The gate,
  // the exec guard and the audit still run — only the SSH relay is stubbed.
  const registry = getNativeRegistry();
  registry.register('bridge_probe', {
    description: 'ungated probe',
    inputSchema: PROBE_SCHEMA,
    handler: async (args: any) => {
      received.push({ name: 'bridge_probe', args });
      return { content: [{ type: 'text', text: 'probed' }] };
    },
  });
  // `read_file` is stubbed too, so the suite does not depend on the fs pack's
  // optional imports having registered in whatever environment CI runs in.
  originalReadFile = registry.get('read_file');
  registry.register('read_file', {
    description: 'read a file',
    inputSchema: READ_FILE_SCHEMA,
    handler: async (args: any) => {
      received.push({ name: 'read_file', args });
      return { content: [{ type: 'text', text: 'file body' }] };
    },
  });
  originalRunCommand = registry.get('run_command');
  registry.register('run_command', {
    description: 'run a command',
    inputSchema: RUN_COMMAND_SCHEMA,
    handler: async (args: any) => {
      received.push({ name: 'run_command', args });
      return { content: [{ type: 'text', text: `ran ${args.command}` }] };
    },
  });

  // Exec guard: fake Redis (no kill switch, no rate limit) + a working audit
  // sink, so `run_command` reaches the handler instead of failing closed.
  __setRedisForTest({
    get: async () => null,
    incr: async () => 1,
    expire: async () => 1,
  } as any);
  process.env.WEBAPP_URL = 'http://localhost:3000';
  delete process.env.EXEC_AUDIT_FAIL_OPEN;
  delete process.env.PERMISSIONS_SHADOW;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true }) as Response));

  runControlRegistry.register(RUN_ID, 'test-worker', { capabilityProfile: execProfile as any });
});

afterEach(async () => {
  for (const c of clients) c.close();
  clients = [];
  if (bridge) await bridge.close({ removeDir: true }).catch(() => {});
  bridge = null;
  runControlRegistry.unregister(RUN_ID);
  __setRedisForTest(null);
  vi.unstubAllGlobals();
  const registry = getNativeRegistry();
  if (originalRunCommand) registry.register('run_command', originalRunCommand);
  if (originalReadFile) registry.register('read_file', originalReadFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function start(overrides: Record<string, unknown> = {}): Promise<{ bridge: RunToolBridge; published: Published }> {
  const { publisher, published } = makePublisher();
  const started = await startRunToolBridge({
    runId: RUN_ID,
    // `authToken` is what makes the exec guard's fail-closed audit POST
    // authenticable in a test process (no INTERNAL_SERVICE_KEY here); without it
    // `run_command` would be denied `audit_unavailable` before the handler.
    state: { runId: RUN_ID, userId: 'u-test', authToken: 'test-token', data: { environmentId: ENV_ID } },
    publisher,
    resolvedTools: nodeTools(),
    environmentId: ENV_ID,
    workingDir: WORKING_DIR,
    abortSignal: null,
    neuronStepId: 'step-coder',
    dir: path.join(tmpDir, 'step'),
    maxToolIterations: 2,
    ...overrides,
  } as any);
  bridge = started;
  return { bridge: started, published };
}

async function client(b: RunToolBridge, nonce?: string | null): Promise<RpcClient> {
  const c = await connectClient(b.socketPath, nonce === undefined ? b.nonce : nonce);
  clients.push(c);
  return c;
}

// =============================================================================
// 1. Allowlist intersection
// =============================================================================

describe('tools/list — allowlist intersection', () => {
  it('serves node.tools ∩ registry − FORBIDDEN and nothing else', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('tools/list');
    const names = res.result.tools.map((t: any) => t.name).sort();

    expect(names).toContain('run_command');
    expect(names).toContain('read_file');
    // forbidden by name
    expect(names).not.toContain('invoke_tool');
    expect(names).not.toContain('ssh_shell');
    expect(names).not.toContain('invoke_graph');
    expect(names).not.toContain('create_neuron');
    // forbidden by tool-map resource (computer:*)
    expect(names).not.toContain('desktop_click');
    // not a native tool
    expect(names).not.toContain('server.remoteThing');
    // declared but not registered
    expect(names).not.toContain('not_a_registered_tool');
    expect(b.toolNames.sort()).toEqual(names);
  });

  it('drops a tool the node never declared, even though the registry has it', async () => {
    expect(getNativeRegistry().has('bridge_probe')).toBe(true);
    const table = buildBridgeToolTable([
      { name: 'run_command', description: 'x', inputSchema: RUN_COMMAND_SCHEMA, source: 'native' },
    ]);
    expect(table.map((t) => t.name)).toEqual(['run_command']);
    expect(table.find((t) => t.name === 'bridge_probe')).toBeUndefined();
  });

  it('de-duplicates a name the node listed twice', () => {
    const dup: RunBridgeToolRef = { name: 'run_command', description: 'x', inputSchema: RUN_COMMAND_SCHEMA, source: 'native' };
    expect(buildBridgeToolTable([dup, dup]).length).toBe(1);
  });
});

// =============================================================================
// 2. Forbidden removal
// =============================================================================

describe('FORBIDDEN set', () => {
  it('names every tool the scope forbids', () => {
    for (const name of [
      'invoke_tool', 'list_available_tools', 'get_tool_schema', 'invoke_graph', 'ssh_shell',
      'workspace_checkout', 'workspace_checkin', 'workspace_release',
      'create_neuron', 'update_neuron', 'delete_neuron',
    ]) {
      expect(FORBIDDEN_TOOLS.has(name)).toBe(true);
      expect(isForbiddenForBridge(name)).toBe(true);
    }
  });

  it('forbids every computer:* tool by its tool-map resource, not by a hand list', () => {
    for (const name of ['desktop_click', 'desktop_type', 'desktop_key', 'desktop_screenshot', 'desktop_scroll']) {
      expect(FORBIDDEN_TOOLS.has(name)).toBe(false);
      expect(isForbiddenForBridge(name)).toBe(true);
    }
  });

  it('forbids the network tools while the caller-trust fix is absent', () => {
    // Engine PR #378 lands `untrustedCaller` + the SSRF guard. Until then a
    // model-chosen URL can borrow INTERNAL_SERVICE_KEY, so these stay off.
    for (const name of ['fetch_url', 'scrape_url', 'web_search', 'ssh_copy']) {
      expect(isForbiddenForBridge(name)).toBe(CALLER_TRUST_FIX_PRESENT ? false : true);
    }
  });

  it('leaves exec:* tools servable — they are the point of the bridge', () => {
    for (const name of ['run_command', 'read_file', 'write_file', 'edit_file', 'glob', 'grep_files', 'list_dir']) {
      expect(isForbiddenForBridge(name)).toBe(false);
    }
  });

  it('refuses a forbidden tools/call even though it was never listed', async () => {
    const { bridge: b, published } = await start();
    const c = await client(b);
    const res = await c.send('tools/call', { name: 'ssh_shell', arguments: { command: 'id' } });
    expect(res.error.code).toBe(-32602);
    expect(res.result).toBeUndefined();
    expect(b.stats.denied).toBe(1);
    // the denial is audited on the run record
    expect(published.starts.at(-1)?.name).toBe('ssh_shell');
    expect(published.starts.at(-1)?.options.denied).toBe(true);
    expect(published.errors.at(-1)?.error).toMatch(/bridge denied/);
  });
});

// =============================================================================
// 3. environmentId pin + arg shaping
// =============================================================================

describe('environmentId pin', () => {
  it('removes environmentId from every served schema', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('tools/list');
    for (const tool of res.result.tools) {
      expect(tool.inputSchema.properties.environmentId).toBeUndefined();
      expect(tool.inputSchema.required ?? []).not.toContain('environmentId');
    }
    // read_file's schema required it; the stripped copy must not
    const readFile = res.result.tools.find((t: any) => t.name === 'read_file');
    expect(readFile.inputSchema.required).toEqual(['path']);
  });

  it('overwrites a CLI-supplied environmentId with the session pin', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('tools/call', {
      name: 'run_command',
      arguments: { command: 'whoami', environmentId: OTHER_ENV },
    });
    expect(res.result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0].args.environmentId).toBe(ENV_ID);
    expect(received[0].args.environmentId).not.toBe(OTHER_ENV);
  });

  it('deletes environmentId entirely when the session has no environment', async () => {
    const { bridge: b } = await start({ environmentId: '' });
    const c = await client(b);
    const res = await c.send('tools/call', {
      name: 'bridge_probe',
      arguments: { note: 'hi', environmentId: OTHER_ENV },
    });
    expect(res.result.isError).toBeFalsy();
    expect(received).toHaveLength(1);
    expect(received[0].args.environmentId).toBeUndefined();
  });

  it('pins the environment on an ungated tool too (the pin is not the gate)', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    await c.send('tools/call', { name: 'bridge_probe', arguments: { note: 'hi', environmentId: OTHER_ENV } });
    expect(received[0].args.environmentId).toBe(ENV_ID);
  });

  it('defaults workingDir as well as cwd when the schema declares it', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    await c.send('tools/call', { name: 'bridge_probe', arguments: { note: 'hi' } });
    expect(received[0].args.cwd).toBe(WORKING_DIR);
    expect(received[0].args.workingDir).toBe(WORKING_DIR);
  });

  it('defaults cwd to the session workingDir and leaves an explicit cwd alone', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    await c.send('tools/call', { name: 'run_command', arguments: { command: 'ls' } });
    expect(received[0].args.cwd).toBe(WORKING_DIR);

    await c.send('tools/call', { name: 'run_command', arguments: { command: 'ls', cwd: '/ws/indy/tree/sub' } });
    expect(received[1].args.cwd).toBe('/ws/indy/tree/sub');
  });

  it('gives run_command a default timeout when the CLI omits one', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    await c.send('tools/call', { name: 'run_command', arguments: { command: 'sleep 1' } });
    expect(received[0].args.timeout).toBe(300_000);

    await c.send('tools/call', { name: 'run_command', arguments: { command: 'sleep 1', timeout: 5000 } });
    expect(received[1].args.timeout).toBe(5000);
  });

  it('rejects non-object arguments', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('tools/call', { name: 'run_command', arguments: ['ls'] });
    expect(res.error.code).toBe(-32602);
    expect(received).toHaveLength(0);
  });

  it('strips prototype-polluting keys before dispatch', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    c.raw('{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"bridge_probe",'
      + '"arguments":{"note":"hi","__proto__":{"polluted":true}}}}');
    await new Promise((r) => setTimeout(r, 150));
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(received[0]?.args ?? {}, '__proto__')).toBe(false);
  });

  it('stripPrototypeKeys drops __proto__/constructor/prototype and keeps the rest', () => {
    const raw = JSON.parse('{"a":1,"__proto__":{"x":1},"constructor":2,"prototype":3}');
    const out = stripPrototypeKeys(raw);
    expect(Object.keys(out)).toEqual(['a']);
  });

  it('stripEnvironmentIdFromSchema does not mutate the source schema', () => {
    const src = { type: 'object', properties: { environmentId: { type: 'string' } }, required: ['environmentId'] };
    const out = stripEnvironmentIdFromSchema(src);
    expect(out.properties.environmentId).toBeUndefined();
    expect((src.properties as any).environmentId).toBeDefined();
    expect(out.required).toBeUndefined();
  });
});

// =============================================================================
// 4. Nonce
// =============================================================================

describe('nonce gate', () => {
  it('accepts a good nonce and answers', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    expect((await c.send('ping')).result).toEqual({});
    expect(b.stats.authFailures).toBe(0);
  });

  it('drops a connection whose first line is not an auth frame', async () => {
    const { bridge: b } = await start();
    const c = await connectClient(b.socketPath, null);
    clients.push(c);
    c.raw(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await c.closedPromise;
    expect(b.stats.authFailures).toBe(1);
    expect(b.revoked).toBe(false);
  });

  it('revokes the session and fails the step after three bad nonces', async () => {
    const fatals: Error[] = [];
    const { bridge: b } = await start({ onFatal: (e: Error) => fatals.push(e) });

    for (let i = 0; i < 3; i++) {
      const c = await connectClient(b.socketPath, `${'0'.repeat(63)}${i}`);
      clients.push(c);
      await c.closedPromise;
    }

    expect(b.stats.authFailures).toBe(3);
    expect(b.revoked).toBe(true);
    expect(b.revokedReason).toMatch(/failed authentication/);
    expect(fatals).toHaveLength(1);
    expect(fatals[0].message).toMatch(/3 failed authentication attempts/);

    // and the socket no longer serves anyone
    await expect(connectClient(b.socketPath, b.nonce)).rejects.toBeTruthy();
  });

  it('never leaks the nonce through the wire before auth', async () => {
    const { bridge: b } = await start();
    const c = await connectClient(b.socketPath, 'deadbeef');
    clients.push(c);
    await c.closedPromise;
    expect(c.lines.join('\n')).not.toContain(b.nonce);
  });

  it('mints a 64-hex nonce and a 0600 socket in a 0700 dir', async () => {
    const { bridge: b } = await start();
    expect(b.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(b.socketPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(b.socketPath)).mode & 0o777).toBe(0o700);
  });

  it('publishes an mcp.json that points at the shim, the socket and the nonce', async () => {
    const { bridge: b } = await start();
    const cfg: any = b.mcpConfig;
    expect(cfg.mcpServers.redbtn.type).toBe('stdio');
    expect(cfg.mcpServers.redbtn.command).toBe(process.execPath);
    expect(cfg.mcpServers.redbtn.args[0]).toMatch(/run-bridge-shim/);
    expect(cfg.mcpServers.redbtn.env.REDBTN_BRIDGE_SOCK).toBe(b.socketPath);
    expect(cfg.mcpServers.redbtn.env.REDBTN_BRIDGE_NONCE).toBe(b.nonce);
  });
});

// =============================================================================
// 5. Revoke on abort / cancel
// =============================================================================

describe('lifecycle', () => {
  it('revokes when the run aborts', async () => {
    const controller = new AbortController();
    const { bridge: b } = await start({ abortSignal: controller.signal });
    const c = await client(b);
    expect((await c.send('ping')).result).toEqual({});

    controller.abort();
    await c.closedPromise;
    expect(b.revoked).toBe(true);
    expect(b.revokedReason).toMatch(/aborted/);
  });

  it('starts already-revoked when handed an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { bridge: b } = await start({ abortSignal: controller.signal });
    expect(b.revoked).toBe(true);
  });

  it('kills the child, revokes and closes on run cancellation', async () => {
    let killed = false;
    const { bridge: b } = await start({ onCancel: () => { killed = true; } });
    const c = await client(b);
    await c.send('ping');

    runControlRegistry.cancel(RUN_ID, 'test');
    await c.closedPromise;

    expect(killed).toBe(true);
    expect(b.revoked).toBe(true);
  });

  it('unlinks the socket and removes the step dir on close', async () => {
    const { bridge: b } = await start();
    const dir = path.dirname(b.socketPath);
    expect(fs.existsSync(b.socketPath)).toBe(true);
    await b.close();
    expect(fs.existsSync(b.socketPath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(false);
    bridge = null;
  });

  it('keeps the dir when asked to', async () => {
    const { bridge: b } = await start();
    const dir = path.dirname(b.socketPath);
    await b.close({ removeDir: false });
    expect(fs.existsSync(b.socketPath)).toBe(false);
    expect(fs.existsSync(dir)).toBe(true);
    bridge = null;
  });
});

// =============================================================================
// 6. Hard cap
// =============================================================================

describe('hard call cap', () => {
  it('caps callsTotal at maxToolIterations * 4 + 8', async () => {
    const { bridge: b } = await start({ maxToolIterations: 2 });
    expect(b.maxCalls).toBe(16);
    const c = await client(b);

    for (let i = 0; i < 16; i++) {
      const res = await c.send('tools/call', { name: 'run_command', arguments: { command: `echo ${i}` } });
      expect(res.result.isError).toBeFalsy();
    }
    expect(b.stats.callsTotal).toBe(16);

    const over = await c.send('tools/call', { name: 'run_command', arguments: { command: 'echo over' } });
    expect(over.result.isError).toBe(true);
    expect(over.result.content[0].text).toMatch(/tool budget exhausted/);
    expect(b.stats.capped).toBe(1);
    expect(b.stats.callsTotal).toBe(16);
    expect(received).toHaveLength(16);
  });

  it('defaults to 50 iterations (208 calls) when the node sets none', async () => {
    const { bridge: b } = await start({ maxToolIterations: undefined });
    expect(b.maxCalls).toBe(208);
  });
});

// =============================================================================
// 7. JSON-RPC 2.0 conformance
// =============================================================================

describe('JSON-RPC conformance', () => {
  it('echoes the client protocolVersion on initialize', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'claude-code', version: '2.1.263' },
    });
    expect(res.jsonrpc).toBe('2.0');
    expect(res.result.protocolVersion).toBe('2025-03-26');
    expect(res.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(res.result.serverInfo.name).toBe('redbtn');
  });

  it('falls back to the default protocol version', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('initialize', { capabilities: {}, clientInfo: { name: 'x', version: '1' } });
    expect(res.result.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
  });

  it('never answers notifications/initialized', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    c.notify('notifications/initialized');
    await c.send('ping');
    // exactly one line came back: the ping response
    expect(c.lines).toHaveLength(1);
    expect(JSON.parse(c.lines[0]).id).toBe(1);
  });

  it('answers resources/list and prompts/list with empty arrays', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    expect((await c.send('resources/list')).result).toEqual({ resources: [] });
    expect((await c.send('prompts/list')).result).toEqual({ prompts: [] });
  });

  it('returns -32601 for an unknown method', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('completion/complete');
    expect(res.error.code).toBe(-32601);
    expect(res.error.message).toMatch(/Method not found/);
  });

  it('returns -32700 for an unparseable frame without dropping the connection', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    c.raw('{not json');
    const res = await c.send('ping');
    expect(res.result).toEqual({});
    expect(JSON.parse(c.lines[0]).error.code).toBe(-32700);
  });

  it('returns the native result verbatim, content blocks included', async () => {
    const { bridge: b } = await start();
    const c = await client(b);
    const res = await c.send('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } });
    expect(res.result).toEqual({ content: [{ type: 'text', text: 'ran echo hi' }] });
  });

  it('publishes tool_start / tool_complete with the neuron step id', async () => {
    const { bridge: b, published } = await start();
    const c = await client(b);
    await c.send('tools/call', { name: 'run_command', arguments: { command: 'echo hi' } });
    expect(published.starts).toHaveLength(1);
    expect(published.starts[0].options.triggeredBy).toBe('neuron');
    expect(published.starts[0].options.neuronStepId).toBe('step-coder');
    expect(published.completes).toHaveLength(1);
    expect(published.completes[0].toolId).toBe(published.starts[0].toolId);
  });
});

// =============================================================================
// 8. Secret scrub (publish path only)
// =============================================================================

describe('secret scrub', () => {
  it('masks every pattern the scope names', () => {
    const samples = [
      'rpat_abcdefghijklmnop',
      'rbt_abcdefghijklmnop',
      'rsk_abcdefghijklmnop',
      'ghp_0123456789abcdef0123456789abcdef0123',
      'AKIAIOSFODNN7EXAMPLE',
      'sk_live_abcdef123456',
      'sk-ant-api03-abcdefghijklmnopqrstuvwx',
      'AIzaSyA1234567890abcdefghijklmnopqrstu',
      'mongodb+srv://user:pw@cluster.example.net/db',
      '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
    ];
    for (const s of samples) {
      const scrubbed = scrubSecretsForPublish(`prefix ${s} suffix`);
      expect(scrubbed).toContain('[REDACTED]');
      expect(scrubbed).not.toContain(s.split('\n')[0]);
    }
    expect(scrubSecretsForPublish('nothing secret here')).toBe('nothing secret here');
  });

  it('scrubs what is PUBLISHED and not what is RETURNED', async () => {
    getNativeRegistry().register('run_command', {
      description: 'run a command',
      inputSchema: RUN_COMMAND_SCHEMA,
      handler: async () => ({ content: [{ type: 'text', text: 'token=rpat_abcdefghijklmnop done' }] }),
    });
    const { bridge: b, published } = await start();
    const c = await client(b);
    const res = await c.send('tools/call', { name: 'run_command', arguments: { command: 'cat .env' } });

    // the model gets the real bytes
    expect(res.result.content[0].text).toContain('rpat_abcdefghijklmnop');
    // the run archive does not
    expect(published.completes[0].result.content[0].text).toContain('[REDACTED]');
    expect(published.completes[0].result.content[0].text).not.toContain('rpat_abcdefghijklmnop');
  });

  it('leaves image blocks untouched', () => {
    const result = { content: [{ type: 'image', data: 'AAA', mimeType: 'image/png' }] };
    expect(scrubResultForPublish(result)).toEqual(result);
  });
});


// =============================================================================
// 9. The stdio shim, as a real child process
// =============================================================================

/**
 * The shim only exists compiled: the CLI launches it as `node <dist path>`, out
 * of any module graph. CI builds before it tests, so this runs there; a bare
 * `vitest` against a source tree with no `dist/` skips rather than fails.
 */
const BUILT_SHIM = path.join(process.cwd(), 'dist/lib/mcp/run-bridge-shim.js');
const shimBuilt = fs.existsSync(BUILT_SHIM);

describe('run-bridge-shim (stdio ↔ socket)', () => {
  it.skipIf(!shimBuilt)('relays JSON-RPC both ways and answers no notification', async () => {
    const { bridge: b } = await start();
    const cfg: any = b.mcpConfig;
    const child = spawn(process.execPath, [BUILT_SHIM], {
      env: { PATH: process.env.PATH, ...cfg.mcpServers.redbtn.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '2.1.263' } } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bridge_probe', arguments: { note: 'through-the-shim' } } })}\n`);
    await new Promise((r) => setTimeout(r, 800));

    const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(msgs[0].result.serverInfo.name).toBe('redbtn');
    expect(msgs[1].result.tools.map((t: any) => t.name)).toContain('bridge_probe');
    expect(msgs[2].result.content[0].text).toBe('probed');
    expect(err).toBe('');

    child.stdin.end();
    child.kill();
  });

  it.skipIf(!shimBuilt)('exits 2 without its environment and 1 with no server', async () => {
    const { bridge: b } = await start();
    const cfg: any = b.mcpConfig;

    const bare = spawn(process.execPath, [BUILT_SHIM], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(await new Promise((r) => bare.on('exit', r))).toBe(2);

    await b.close({ removeDir: false });
    bridge = null;
    const orphan = spawn(process.execPath, [BUILT_SHIM], {
      env: { PATH: process.env.PATH, ...cfg.mcpServers.redbtn.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(await new Promise((r) => orphan.on('exit', r))).toBe(1);
  });
});
