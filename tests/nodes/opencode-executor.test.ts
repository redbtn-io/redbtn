/**
 * `opencode` executor — unit tests against a FAKE `opencode` binary.
 *
 * The fake speaks the real `opencode run --format json` protocol (NDJSON
 * `step_start` / `text` / `tool_use` / `step_finish` / `error`), reads the
 * prompt off stdin, and can read the private config the executor wrote and dial
 * the per-run bridge over its Unix socket exactly like the real CLI's MCP
 * client would. Live tests against the real CLI are in
 * `opencode-executor-live.test.ts` (opt-in).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  resolveOpencodeModel,
  resolveOpencodeBinary,
  modelProvider,
  OpencodeCliError,
  runOpencodeStep,
  buildOpencodeSpawnArgs,
  buildOpencodeServeArgs,
  buildOpencodeChildEnv,
  buildOpencodeConfig,
  buildOpencodePermissions,
  resolveProviderCredential,
  readHostOpencodeKey,
  handleOpencodeLine,
  createOpencodeStreamState,
  mapOpencodeUsage,
  classifyOpencodeError,
  joinTextParts,
  SENTINEL_READ_RESOURCE,
  SENTINEL_SHELL_RESOURCE,
  __opencodeSlotsInUse,
  __opencodeLiveChildCount,
} from '../../src/lib/nodes/universal/executors/opencodeExecutor';
import { OPENCODE_FALLBACK_CODES } from '../../src/lib/nodes/universal/executors/neuronFallback';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'REDBTN_RUN_DIR_ROOT',
  'OPENCODE_CLI_BIN',
  'OPENCODE_BIN_PATH',
  'OPENCODE_CLI_MAX_CONCURRENT',
  'OPENCODE_CLI_QUEUE_WAIT_MS',
  'OPENCODE_HOST_DB',
  'OPENCODE_NEURON_SECRET',
  'OPENCODE_MCP_SETTLE_MS',
];

beforeEach(() => {
  // Short root: a Unix socket path is capped at ~104 bytes on macOS.
  tmpRoot = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'oc-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.REDBTN_RUN_DIR_ROOT = path.join(tmpRoot, 'run');
  process.env.OPENCODE_MCP_SETTLE_MS = '0';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** A turn's worth of events, as the real CLI emits them. */
function turn(texts: string[], opts: { tokens?: Any; cost?: number; session?: string } = {}): Any[] {
  const sessionID = opts.session ?? 'ses_fake123';
  const events: Any[] = [{ type: 'step_start', sessionID, part: { type: 'step-start' } }];
  for (const text of texts) events.push({ type: 'text', sessionID, part: { type: 'text', text } });
  events.push({
    type: 'step_finish',
    sessionID,
    part: {
      type: 'step-finish',
      reason: 'stop',
      cost: opts.cost ?? 0,
      tokens: opts.tokens ?? { input: 100, output: 20, reasoning: 5, cache: { read: 300, write: 0 } },
    },
  });
  return events;
}

/**
 * Write a fake `opencode`. In scope for `body`: `emit(obj)`, `err(s)`,
 * `whenPrompt(fn)` (fn(prompt) once stdin closed), `CONFIG` (the parsed
 * private opencode.json), `dump(obj)`.
 */
function writeFakeOpencode(
  body: string,
  dumpPath = path.join(tmpRoot, 'dump.json'),
  serveStatus: 'connected' | 'failed' | 'never' = 'connected',
): string {
  const file = path.join(tmpRoot, `fake-oc-${Math.random().toString(36).slice(2, 8)}.js`);
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      'const fs = require("fs");\nconst path = require("path");\nconst net = require("net");\n' +
      // `serve`: the private server. Answers /api/mcp (basic auth with the
      // per-step password) with the bridge status, and records its argv/env.
      'if (process.argv[2] === "serve") {\n' +
      '  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);\n' +
      `  fs.writeFileSync(${JSON.stringify(dumpPath + '.serve')}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));\n` +
      '  const want = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64");\n' +
      '  require("http").createServer((req, res) => {\n' +
      '    if (req.headers.authorization !== want) { res.writeHead(401); return res.end(); }\n' +
      `    const st = ${JSON.stringify(serveStatus)};\n` +
      '    const data = st === "never" ? [] : [{ name: "redbtn", status: { status: st, error: st === "failed" ? "boom" : undefined } }];\n' +
      '    res.setHeader("content-type", "application/json");\n' +
      '    res.end(JSON.stringify({ location: { directory: process.cwd() }, data }));\n' +
      '  }).listen(port, "127.0.0.1");\n' +
      '  return;\n' +
      '}\n' +
      'const emit = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");\n' +
      'const err = (s) => fs.writeSync(2, s);\n' +
      `const dump = (o) => fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify(o));\n` +
      'let CONFIG = null;\n' +
      'try { CONFIG = JSON.parse(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME, "opencode/opencode.json"), "utf8")); } catch (e) { CONFIG = { error: String(e) }; }\n' +
      'let STDIN = "";\nconst waiting = [];\nconst whenPrompt = (fn) => { waiting.push(fn); };\n' +
      'process.stdin.setEncoding("utf8");\nprocess.stdin.on("error", () => {});\n' +
      'process.stdin.on("data", (c) => { STDIN += c; });\n' +
      'process.stdin.on("end", () => { for (const fn of waiting) fn(STDIN); });\n' +
      body +
      '\n',
    { mode: 0o755 },
  );
  return file;
}

const emitAll = (events: Any[]) => events.map((e) => `emit(${JSON.stringify(e)});`).join('\n');

const NEURON = {
  id: 'oc-test',
  name: 'OpenCode test',
  provider: 'opencode',
  endpoint: 'opencode://worker',
  model: 'opencode/muse-spark-1.3-contributor-free',
  role: 'worker',
  tier: 0,
};

function makePublisher() {
  const events: Array<{ kind: string; name?: string; text?: string }> = [];
  return {
    events,
    chunks: [] as string[],
    replaced: [] as string[],
    async toolStart(_id: string, name: string) {
      events.push({ kind: 'toolStart', name });
    },
    async toolComplete() {
      events.push({ kind: 'toolComplete' });
    },
    async toolError(_id: string, error: string) {
      events.push({ kind: 'toolError', text: error });
    },
    async chunk(text: string) {
      await new Promise((r) => setTimeout(r, 2));
      this.chunks.push(text);
    },
    async replaceOutputContent(text: string) {
      this.replaced.push(text);
    },
    async getState() {
      return { status: 'running' };
    },
  };
}

async function runStep(over: Record<string, unknown> = {}, neuronOver: Record<string, unknown> = {}, dataOver: Record<string, unknown> = {}) {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const publisher = makePublisher();
  const usage: Array<{ response: Any; hint?: string; stepId?: string }> = [];
  const result = await runOpencodeStep({
    config: {
      neuronId: 'oc-test',
      outputField: 'data.out',
      systemPrompt: 'be terse',
      userPrompt: 'say ok',
      tools: [],
      ...over,
    } as Any,
    state: {
      runId,
      userId: 'user_test',
      runPublisher: publisher,
      systemPrefix: 'NODE PREFIX',
      data: { runId, userId: 'user_test', ...dataOver },
    },
    neuronCfg: { ...NEURON, ...neuronOver },
    neuronId: 'oc-test',
    userId: 'user_test',
    callRunId: runId,
    emitUsage: (response, hint, stepId) => usage.push({ response, hint, stepId }),
  });
  return { result, publisher, usage };
}

// =============================================================================
// Pure helpers
// =============================================================================

describe('model and binary', () => {
  it('resolves model names with opencode/ prefix if absent', () => {
    expect(resolveOpencodeModel('')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('big-pickle')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('opencode/big-pickle')).toBe('opencode/big-pickle');
    expect(resolveOpencodeModel('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-v4-pro');
    expect(resolveOpencodeModel('openrouter/cohere/north-mini-code:free')).toBe('openrouter/cohere/north-mini-code:free');
  });

  it('maps muse-spark aliases to opencode/muse-spark-1.3-contributor-free', () => {
    for (const alias of ['muse-spark-1.3', 'muse-spark', 'muse', 'opencode/muse-spark-1.3']) {
      expect(resolveOpencodeModel(alias)).toBe('opencode/muse-spark-1.3-contributor-free');
    }
  });

  it('refuses a flag-shaped model rather than putting it on argv', () => {
    expect(() => resolveOpencodeModel('--auto')).toThrow(OpencodeCliError);
    expect(() => resolveOpencodeModel('a b')).toThrow(OpencodeCliError);
  });

  it('names the provider of a model id', () => {
    expect(modelProvider('openrouter/cohere/x:free')).toBe('openrouter');
    expect(modelProvider('opencode/big-pickle')).toBe('opencode');
  });

  it('honours OPENCODE_CLI_BIN', () => {
    const fake = writeFakeOpencode('');
    process.env.OPENCODE_CLI_BIN = fake;
    expect(resolveOpencodeBinary()).toBe(fake);
  });
});

describe('the security-relevant shape', () => {
  it('builds the exact spawn lines and NEVER passes --auto', () => {
    const args = buildOpencodeSpawnArgs({ model: 'opencode/big-pickle', serverUrl: 'http://127.0.0.1:4242' });
    expect(args).toEqual(['run', '--server', 'http://127.0.0.1:4242', '--format', 'json', '--model', 'opencode/big-pickle']);
    expect(args).not.toContain('--auto');
    // The private server binds loopback only.
    expect(buildOpencodeServeArgs(4242)).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '4242']);
  });

  it('denies everything, keeps read/shell LISTED via sentinels, and allows only the bridge', () => {
    const perms = buildOpencodePermissions();
    expect(perms[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    const allows = perms.filter((p) => p.effect === 'allow');
    expect(allows).toEqual([
      { action: 'read', resource: SENTINEL_READ_RESOURCE, effect: 'allow' },
      { action: 'shell', resource: SENTINEL_SHELL_RESOURCE, effect: 'allow' },
      { action: 'redbtn.*', resource: '*', effect: 'allow' },
      { action: 'redbtn_*', resource: '*', effect: 'allow' },
    ]);
    // No 'ask' anywhere: headless it auto-rejects AND interrupts the step.
    expect(perms.some((p) => p.effect === 'ask')).toBe(false);
  });

  it('maps the bridge mcp.json onto an opencode local server with direct tools', () => {
    const cfg = buildOpencodeConfig({
      mcpServers: {
        redbtn: { type: 'stdio', command: '/usr/bin/node', args: ['/x/shim.js'], env: { REDBTN_BRIDGE_SOCK: '/s', REDBTN_BRIDGE_NONCE: 'n' } },
      },
    }) as Any;
    expect(cfg.mcp.servers.redbtn).toEqual({
      type: 'local',
      codemode: false,
      command: ['/usr/bin/node', '/x/shim.js'],
      environment: { REDBTN_BRIDGE_SOCK: '/s', REDBTN_BRIDGE_NONCE: 'n' },
    });
    expect(Object.keys(cfg.mcp.servers)).toEqual(['redbtn']);
  });

  it('builds the child env from nothing', () => {
    const env = buildOpencodeChildEnv({
      home: '/r/home',
      dir: '/r',
      credential: { envName: 'OPENROUTER_API_KEY', value: 'sk-or-x' },
      parentEnv: { PATH: '/bin', MONGODB_URI: 'mongodb://leak', OPENAI_API_KEY: 'sk-leak', HOME: '/Users/me' } as Any,
    });
    expect(env.MONGODB_URI).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.HOME).toBe('/r/home');
    expect(env.XDG_CONFIG_HOME).toBe('/r/home/.config');
    expect(env.XDG_DATA_HOME).toBe('/r/home/.local/share');
    expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1');
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(env.OPENROUTER_API_KEY).toBe('sk-or-x');
  });
});

describe('credentials', () => {
  it('passes nothing for a keyless neuron', () => {
    expect(resolveProviderCredential('opencode/big-pickle', undefined)).toBeNull();
  });

  it('exports the secret under the model provider env var', () => {
    expect(resolveProviderCredential('openrouter/cohere/x:free', 'sk-or-1')).toEqual({
      envName: 'OPENROUTER_API_KEY',
      value: 'sk-or-1',
    });
  });

  it('resolves the host-login sentinel from the host opencode login', () => {
    const read = vi.fn((p: string) => (p === 'openrouter' ? 'sk-host' : ''));
    expect(resolveProviderCredential('openrouter/x', 'keychain', read)).toEqual({
      envName: 'OPENROUTER_API_KEY',
      value: 'sk-host',
    });
    // A free Zen model with the sentinel and no host key just runs keyless.
    expect(resolveProviderCredential('opencode/big-pickle', 'keychain', () => '')).toBeNull();
    expect(() => resolveProviderCredential('openrouter/x', 'host', () => '')).toThrow(
      expect.objectContaining({ code: 'opencode_no_host_login' }),
    );
  });

  it('reads an API-key credential from an opencode database, read-only', async () => {
    let sqlite: Any;
    try {
      sqlite = await import('node:sqlite');
    } catch {
      return; // node without node:sqlite: nothing to prove here
    }
    const dbPath = path.join(tmpRoot, 'opencode.db');
    const db = new sqlite.DatabaseSync(dbPath);
    db.exec(
      'create table credential (id text primary key, integration_id text, label text not null, value text not null, connector_id text, method_id text, active integer, time_created integer not null, time_updated integer not null)',
    );
    const ins = db.prepare('insert into credential values (?,?,?,?,?,?,?,?,?)');
    ins.run('1', 'openrouter', 'k', JSON.stringify({ type: 'key', key: 'sk-or-db' }), null, null, 1, 1, 1);
    ins.run('2', 'github-copilot', 'o', JSON.stringify({ type: 'oauth', access: 'x' }), null, null, 1, 1, 1);
    db.close();
    expect(readHostOpencodeKey('openrouter', dbPath)).toBe('sk-or-db');
    expect(readHostOpencodeKey('github-copilot', dbPath)).toBe(''); // OAuth: not reusable
    expect(readHostOpencodeKey('anthropic', dbPath)).toBe('');
    expect(readHostOpencodeKey('openrouter', path.join(tmpRoot, 'none.db'))).toBe('');
  });
});

describe('the NDJSON stream', () => {
  it('collects text, tool calls, denials and usage across steps', () => {
    const st = createOpencodeStreamState();
    const lines = [
      { type: 'step_start', sessionID: 'ses_1', part: {} },
      { type: 'text', part: { text: 'Let me look.' } },
      { type: 'tool_use', part: { tool: 'shell', state: { status: 'error', error: 'Permission denied: shell' } } },
      { type: 'tool_use', part: { tool: 'redbtn_read_file', state: { status: 'completed', output: 'x' } } },
      { type: 'step_finish', part: { cost: 0.001, tokens: { input: 100, output: 10, reasoning: 50, cache: { read: 0, write: 0 } } } },
      { type: 'step_start', part: {} },
      { type: 'text', part: { text: 'Done.' } },
      { type: 'step_finish', part: { cost: 0.002, tokens: { input: 20, output: 5, reasoning: 0, cache: { read: 300, write: 7 } } } },
    ];
    const streamed = lines.map((l) => handleOpencodeLine(st, JSON.stringify(l))).filter(Boolean);
    expect(streamed).toEqual(['Let me look.', 'Done.']);
    expect(st.sessionId).toBe('ses_1');
    expect(st.lastStepTexts).toEqual(['Done.']);
    expect(st.toolCalls).toBe(2);
    expect(st.bridgeToolCalls).toBe(1);
    expect(st.denials).toEqual([{ tool: 'shell', error: 'Permission denied: shell' }]);
    expect(st.cost).toBeCloseTo(0.003);
    const usage = mapOpencodeUsage(st);
    // Input INCLUDES cache reads/writes (the engine-wide convention).
    expect(usage.input_tokens).toBe(120 + 300 + 7);
    expect(usage.uncached_input_tokens).toBe(120);
    expect(usage.output_tokens).toBe(15 + 50);
    expect(usage.input_token_details).toEqual({ cache_creation: 7, cache_read: 300 });
    expect(handleOpencodeLine(st, 'not json')).toBeNull();
    expect(handleOpencodeLine(st, '{broken')).toBeNull();
  });

  it('joins text parts the way they are published', () => {
    expect(joinTextParts(['a', 'b'])).toBe('a\n\nb');
    expect(joinTextParts(['a\n', 'b'])).toBe('a\nb');
  });

  it('classifies the CLI error events', () => {
    expect(classifyOpencodeError({ type: 'provider.auth', status: 403, message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode" }).code).toBe('opencode_free_tier_refused');
    expect(classifyOpencodeError({ status: 429, message: 'slow down' }).code).toBe('opencode_rate_limited');
    expect(classifyOpencodeError({ message: 'Rate limit exceeded' }).code).toBe('opencode_rate_limited');
    expect(classifyOpencodeError({ type: 'provider.auth', status: 401, message: 'Missing Authentication header' }).code).toBe('opencode_auth_failed');
    expect(classifyOpencodeError({ type: 'provider.error', message: 'boom' }).code).toBe('opencode_error_result');
  });

  it('keeps the fallback set to operational failures only', () => {
    for (const code of ['opencode_spawn_failed', 'opencode_rate_limited', 'opencode_queue_timeout', 'opencode_timeout', 'opencode_failed', 'opencode_error_result']) {
      expect(OPENCODE_FALLBACK_CODES.has(code)).toBe(true);
    }
    for (const code of ['opencode_auth_failed', 'opencode_free_tier_refused', 'opencode_tool_denied', 'opencode_no_host_login', 'opencode_bad_structured_output']) {
      expect(OPENCODE_FALLBACK_CODES.has(code)).toBe(false);
    }
  });
});

// =============================================================================
// runOpencodeStep — end to end against the fake CLI
// =============================================================================

describe('runOpencodeStep', () => {
  it('runs a turn, returns the final message, meters usage and cleans up', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(`whenPrompt(() => { ${emitAll(turn(['ok']))} });`);
    const { result, usage } = await runStep();
    expect(result['data.out']).toBe('ok');
    const cli = (result['data._cli'] as Any)['data.out'];
    expect(cli.provider).toBe('opencode');
    expect(cli.model).toBe('opencode/muse-spark-1.3-contributor-free');
    expect(cli.sessionId).toBe('ses_fake123');
    expect(usage).toHaveLength(1);
    expect(usage[0].hint).toBe('opencode-cli/opencode/muse-spark-1.3-contributor-free');
    expect(usage[0].response.usage_metadata.input_tokens).toBe(400);
    expect(fs.readdirSync(process.env.REDBTN_RUN_DIR_ROOT as string)).toEqual([]);
    expect(__opencodeSlotsInUse()).toBe(0);
    expect(__opencodeLiveChildCount()).toBe(0);
  });

  it('hands the child a private HOME, an allowlisted env, an empty cwd and the delimited prompt on stdin', async () => {
    const dumpPath = path.join(tmpRoot, 'dump.json');
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt((p) => { dump({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), prompt: p, config: CONFIG, configMode: (fs.statSync(path.join(process.env.XDG_CONFIG_HOME, "opencode/opencode.json")).mode & 0o777) }); ${emitAll(turn(['ok']))} });`,
      dumpPath,
    );
    process.env.MONGODB_URI = 'mongodb://prod/should-not-leak';
    process.env.OPENROUTER_API_KEY = 'sk-should-not-leak';
    try {
      await runStep();
    } finally {
      delete process.env.MONGODB_URI;
      delete process.env.OPENROUTER_API_KEY;
    }
    const seen = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const served = JSON.parse(fs.readFileSync(`${dumpPath}.serve`, 'utf8'));
    expect(served.argv.slice(0, 3)).toEqual(['serve', '--hostname', '127.0.0.1']);
    const port = served.argv[served.argv.indexOf('--port') + 1];
    expect(seen.argv).toEqual(['run', '--server', `http://127.0.0.1:${port}`, '--format', 'json', '--model', 'opencode/muse-spark-1.3-contributor-free']);
    // Both children: same private HOME, same per-step password, same cwd.
    expect(served.env.HOME).toBe(seen.env.HOME);
    expect(served.env.OPENCODE_SERVER_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(seen.env.OPENCODE_SERVER_PASSWORD).toBe(served.env.OPENCODE_SERVER_PASSWORD);
    expect(served.cwd).toBe(seen.cwd);
    expect(seen.env.MONGODB_URI).toBeUndefined();
    expect(seen.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(seen.env.HOME).not.toBe(os.homedir());
    expect(seen.env.HOME.startsWith(process.env.REDBTN_RUN_DIR_ROOT as string)).toBe(true);
    expect(seen.cwdEntries).toEqual([]);
    expect(seen.configMode).toBe(0o600);
    expect(seen.config.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(seen.config.mcp.servers.redbtn.codemode).toBe(false);
    expect(seen.config.mcp.servers.redbtn.environment.REDBTN_BRIDGE_NONCE).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.prompt).toContain('=== SYSTEM INSTRUCTIONS ===');
    expect(seen.prompt).toContain('NODE PREFIX');
    expect(seen.prompt).toContain('be terse');
    expect(seen.prompt).toContain('redbtn_run_command');
    expect(seen.prompt.trim().endsWith('say ok')).toBe(true);
    // The nonce reaches the child only through the 0600 config file.
    expect(JSON.stringify(seen.env)).not.toContain(seen.config.mcp.servers.redbtn.environment.REDBTN_BRIDGE_NONCE);
  });

  it('passes a provider key from the neuron secret, and redacts it from errors', async () => {
    const dumpPath = path.join(tmpRoot, 'dump.json');
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { dump({ env: process.env }); err("auth trouble with sk-or-SECRET-123456\\n"); process.exit(2); });`,
      dumpPath,
    );
    await expect(runStep({}, { model: 'openrouter/cohere/north-mini-code:free', apiKey: 'sk-or-SECRET-123456' })).rejects.toMatchObject({
      code: 'opencode_failed',
      message: expect.not.stringContaining('sk-or-SECRET-123456'),
    });
    const seen = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    expect(seen.env.OPENROUTER_API_KEY).toBe('sk-or-SECRET-123456');
  });

  it('serves redbtn tools over the bridge the config points at', async () => {
    const dumpPath = path.join(tmpRoot, 'mcp.json');
    const { getNativeRegistry } = await import('../../src/lib/tools/native-registry');
    const nowTool = (await import('../../src/lib/tools/native/now')).default;
    getNativeRegistry().register('now', nowTool);
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => {
  const srv = CONFIG.mcp.servers.redbtn;
  const sock = net.connect(srv.environment.REDBTN_BRIDGE_SOCK, () => {
    sock.write(JSON.stringify({ redbtn: 'auth', nonce: srv.environment.REDBTN_BRIDGE_NONCE }) + '\\n');
    sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\\n');
  });
  let buf = ''; const responses = [];
  sock.on('data', (c) => {
    buf += c; let i;
    while ((i = buf.indexOf('\\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
      const msg = JSON.parse(line); responses.push(msg);
      if (msg.id === 1) sock.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\\n');
      else if (msg.id === 2) sock.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'now', arguments: { format: 'iso' } } }) + '\\n');
      else if (msg.id === 3) {
        dump({ responses }); sock.end();
        ${emitAll([
          { type: 'step_start', sessionID: 's', part: {} },
          { type: 'tool_use', part: { tool: 'redbtn_now', state: { status: 'completed', output: 't' } } },
          { type: 'step_finish', part: { tokens: { input: 1, output: 1 } } },
          ...turn(['The time is known.']),
        ])}
      }
    }
  });
});`,
      dumpPath,
    );
    const { result, publisher } = await runStep({ tools: ['now'] });
    const seen = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));
    const listed = seen.responses.find((r: Any) => r.id === 2).result.tools.map((t: Any) => t.name);
    expect(listed).toEqual(['now']);
    const call = seen.responses.find((r: Any) => r.id === 3).result;
    expect(call.isError).toBeFalsy();
    expect(publisher.events.some((e) => e.kind === 'toolStart' && e.name === 'now')).toBe(true);
    expect(result['data.out']).toBe('The time is known.');
    expect((result['data._cli'] as Any)['data.out'].bridgeToolCalls).toBe(1);
  });

  it('streams every text part in order and returns only the final message', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { ${emitAll([
        { type: 'step_start', sessionID: 's', part: {} },
        { type: 'text', part: { text: 'Looking at calc.py.' } },
        { type: 'tool_use', part: { tool: 'redbtn_read_file', state: { status: 'completed' } } },
        { type: 'step_finish', part: { tokens: { input: 1, output: 1 } } },
        ...turn(['Fixed the bug.', 'Tests pass.']),
      ])} });`,
    );
    const { result, publisher } = await runStep({ stream: true });
    expect(publisher.chunks).toEqual(['Looking at calc.py.', '\n\nFixed the bug.', '\n\nTests pass.']);
    expect(result['data.out']).toBe('Fixed the bug.\n\nTests pass.');
    expect(publisher.replaced).toEqual([]); // the stream ends with the answer
  });

  it('audits denied built-in calls and keeps the answer', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { ${emitAll([
        { type: 'step_start', sessionID: 's', part: {} },
        { type: 'tool_use', part: { tool: 'shell', state: { status: 'error', error: 'Permission denied: shell' } } },
        { type: 'step_finish', part: { tokens: { input: 1, output: 1 } } },
        ...turn(['Used redbtn_run_command instead.']),
      ])} });`,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result, publisher } = await runStep();
      expect(result['data.out']).toBe('Used redbtn_run_command instead.');
      expect(publisher.events).toContainEqual({ kind: 'toolStart', name: 'shell' });
      expect(publisher.events.some((e) => e.kind === 'toolError' && /permission denial: shell/.test(e.text ?? ''))).toBe(true);
      expect((result['data._cli'] as Any)['data.out'].permissionDenials).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('fails with opencode_tool_denied when denials were all the turn produced', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { ${emitAll([
        { type: 'step_start', sessionID: 's', part: {} },
        { type: 'tool_use', part: { tool: 'edit', state: { status: 'error', error: 'Permission denied: edit' } } },
        { type: 'step_finish', part: { tokens: { input: 1, output: 1 } } },
      ])} });`,
    );
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runStep()).rejects.toMatchObject({ code: 'opencode_tool_denied' });
    } finally {
      errSpy.mockRestore();
    }
  });

  it('classifies the free-tier gate and rate limits from the error event', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { emit({ type: 'error', sessionID: 's', error: { type: 'provider.auth', message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode", status: 403 } }); process.exit(1); });`,
    );
    await expect(runStep()).rejects.toMatchObject({ code: 'opencode_free_tier_refused' });
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt(() => { emit({ type: 'error', sessionID: 's', error: { type: 'provider.error', message: 'Too Many Requests', status: 429 } }); process.exit(1); });`,
    );
    await expect(runStep()).rejects.toMatchObject({ code: 'opencode_rate_limited' });
  });

  it('parses structured output from the final message', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(
      `whenPrompt((p) => { if (!p.includes('JSON schema')) process.exit(9); ${emitAll(turn(['```json\n{"steps":["a","b"]}\n```']))} });`,
    );
    const { result } = await runStep({ structuredOutput: { schema: { type: 'object', properties: { steps: { type: 'array' } } } } });
    expect(result['data.out']).toEqual({ steps: ['a', 'b'] });
  });

  it('fails fast when the private server cannot connect the bridge', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode(`whenPrompt(() => { ${emitAll(turn(['never']))} });`, undefined, 'failed');
    await expect(runStep()).rejects.toMatchObject({ code: 'opencode_failed', message: expect.stringContaining('could not connect the redbtn bridge') });
    expect(__opencodeLiveChildCount()).toBe(0);
  });

  it('gives up on a server that never connects the bridge, within the ready timeout', async () => {
    const saved = process.env.OPENCODE_MCP_READY_TIMEOUT_MS;
    process.env.OPENCODE_MCP_READY_TIMEOUT_MS = '600';
    try {
      process.env.OPENCODE_CLI_BIN = writeFakeOpencode(`whenPrompt(() => { ${emitAll(turn(['never']))} });`, undefined, 'never');
      await expect(runStep()).rejects.toMatchObject({ code: 'opencode_failed', message: expect.stringContaining('did not connect') });
    } finally {
      if (saved === undefined) delete process.env.OPENCODE_MCP_READY_TIMEOUT_MS;
      else process.env.OPENCODE_MCP_READY_TIMEOUT_MS = saved;
    }
  });

  it('reports opencode_spawn_failed when the binary cannot be spawned', async () => {
    // An existing but non-executable file: resolveOpencodeBinary() takes it (so a
    // real opencode installed on the CI host at /usr/local/bin etc. is never
    // picked up), and spawn() fails with EACCES.
    const unrunnable = path.join(tmpRoot, 'unrunnable-opencode');
    fs.writeFileSync(unrunnable, 'not a program\n', { mode: 0o644 });
    process.env.OPENCODE_CLI_BIN = unrunnable;
    process.env.OPENCODE_BIN_PATH = unrunnable;
    // resolveOpencodeBinary skips missing paths, so point PATH lookups nowhere.
    const savedPath = process.env.PATH;
    process.env.PATH = tmpRoot;
    const savedHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    try {
      await expect(runStep()).rejects.toMatchObject({ code: 'opencode_spawn_failed' });
    } finally {
      process.env.PATH = savedPath;
      process.env.HOME = savedHome;
    }
  });

  it('kills the child on the wall clock and reports opencode_timeout', async () => {
    process.env.OPENCODE_CLI_BIN = writeFakeOpencode('setTimeout(() => {}, 60000);');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(runStep({ timeoutMs: 500 })).rejects.toMatchObject({ code: 'opencode_timeout' });
    } finally {
      warn.mockRestore();
    }
    expect(__opencodeLiveChildCount()).toBe(0);
  });
});
