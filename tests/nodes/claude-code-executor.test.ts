/**
 * `claude-code` neuron executor — the contract.
 *
 * Four of these are the specification and the rest are consequences:
 *
 *   1. The child's environment is an ALLOWLIST. `MONGODB_URI`, `REDIS_URL`,
 *      `INTERNAL_SERVICE_KEY` and `WEBAPP_URL` must not reach a process the
 *      model can read `/proc/self/environ` from.
 *   2. The `system/init` guard fires before a turn is spent, and rejects a
 *      session that was offered anything but bridge tools, a bridge that did
 *      not connect, or an `apiKeySource` that proves an API key leaked in.
 *   3. Cancellation, run-level abort and the wall clock all kill the child, and
 *      the step directory (socket, `mcp.json`, config dir, `TMPDIR`) is gone
 *      afterwards in every one of those paths.
 *   4. Usage is mapped the way the subscription actually bills: cache creation
 *      and cache reads are input tokens, and `total_tokens` is computed because
 *      the CLI does not send one.
 *
 * The stream-json fixtures are the real event shapes, recorded off the wire on
 * 2026-09-07 (`prep-reports/16-phase0-smoke.md` §4): `system/init` with its 23
 * keys, `stream_event` deltas, `rate_limit_event`, and a `result/success` with
 * its 24 keys.
 *
 * The "CLI" here is a generated node script — the executor spawns whatever
 * `CLAUDE_CODE_BIN` names, and the script bakes its behaviour in rather than
 * reading env vars, because the env allowlist is precisely what stops a child
 * from receiving any.
 *
 * NOTE: never run this on a fleet box by hand — CI (org runners) runs it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runClaudeCodeStep,
  buildChildEnv,
  buildSpawnArgs,
  assertInitEvent,
  createStreamHandler,
  mapResultUsage,
  mapModelUsageEntry,
  resolveWorkspaceMount,
  resolveEffort,
  resolveModel,
  DEFAULT_MODEL,
  looksLikeAuthFailure,
  sanitizeSegment,
  uuidv5,
  runDirRoot,
  sweepStaleRunDirs,
  STALE_DIR_MAX_AGE_MS,
  MAX_JSON_SCHEMA_ARG_BYTES,
  __resetStaleSweep,
  __liveChildCount,
  ClaudeCodeError,
  BRIDGE_PREAMBLE,
  DEFAULT_MAX_TURNS,
  EFFORT_LEVELS,
  __claudeCodeSlotsInUse,
  type ClaudeInitEvent,
} from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';
import { extractCacheUsage } from '../../src/lib/neurons/prompt-cache';
import { DEFAULT_CLAUDE_CODE_EFFORT } from '../../src/lib/types/neuron';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';

// =============================================================================
// Fixtures — real wire shapes (16-phase0-smoke.md §4)
// =============================================================================

const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  agents: ['claude'],
  analytics_disabled: true,
  apiKeySource: 'none',
  capabilities: ['interrupt_receipt_v1'],
  claude_code_version: '2.1.263',
  cwd: '/ws/workspace/tree',
  mcp_servers: [{ name: 'redbtn', status: 'connected' }],
  model: 'claude-opus-5',
  output_style: 'default',
  permissionMode: 'dontAsk',
  session_id: '48e41cd5-2401-4694-a45c-7e9ae4a4e3b5',
  skills: [],
  slash_commands: [],
  tools: [],
  uuid: 'e0e2f1a0-0000-4000-8000-000000000001',
};

const RESULT_EVENT = {
  type: 'result',
  subtype: 'success',
  api_error_status: null,
  duration_api_ms: 1352,
  duration_ms: 1385,
  is_error: false,
  modelUsage: {
    'claude-opus-5': {
      inputTokens: 2,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 3146,
      costUSD: 0.03157,
      canonicalModel: 'claude-opus-5',
    },
  },
  num_turns: 1,
  permission_denials: [],
  result: 'ok',
  session_id: '48e41cd5-2401-4694-a45c-7e9ae4a4e3b5',
  stop_reason: 'end_turn',
  subagent_stats: { spawned: 0, completed: 0, failed: 0 },
  terminal_reason: 'completed',
  total_cost_usd: 0.03157,
  ttft_ms: 1361,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 3146,
    cache_read_input_tokens: 0,
    output_tokens: 4,
    service_tier: 'standard',
  },
  uuid: 'e0e2f1a0-0000-4000-8000-000000000002',
};

const RATE_LIMIT_EVENT = {
  type: 'rate_limit_event',
  session_id: RESULT_EVENT.session_id,
  uuid: 'e0e2f1a0-0000-4000-8000-000000000003',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1788812400,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'out_of_credits',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.43, resetsAt: 1788812400 },
      seven_day: { utilization: 0.08, resetsAt: 1789387200 },
    },
  },
};

function textDelta(text: string, parentToolUseId: string | null = null) {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    session_id: RESULT_EVENT.session_id,
    uuid: 'e0e2f1a0-0000-4000-8000-000000000004',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
  };
}

function thinkingDelta(thinking: string) {
  return {
    type: 'stream_event',
    parent_tool_use_id: null,
    session_id: RESULT_EVENT.session_id,
    uuid: 'e0e2f1a0-0000-4000-8000-000000000005',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking },
    },
  };
}

// =============================================================================
// Harness
// =============================================================================

let tmpRoot: string;
let savedRunDirRoot: string | undefined;
let savedBin: string | undefined;
let savedConcurrency: string | undefined;
let savedQueueWait: string | undefined;

interface FakePublisher {
  chunks: string[];
  thinking: string[];
  toolEvents: Array<{ kind: string; toolId: string; name?: string; error?: string }>;
  chunk(text: string): Promise<void>;
  thinkingChunk(text: string): Promise<void>;
  toolStart(toolId: string, name: string, type: string, opts?: unknown): Promise<void>;
  toolComplete(toolId: string, result?: unknown): Promise<void>;
  toolError(toolId: string, error: string): Promise<void>;
  getState(): Promise<{ status: string }>;
  status: string;
}

function makePublisher(status = 'running'): FakePublisher {
  const pub: FakePublisher = {
    chunks: [],
    thinking: [],
    toolEvents: [],
    status,
    async chunk(text: string) {
      pub.chunks.push(text);
    },
    async thinkingChunk(text: string) {
      pub.thinking.push(text);
    },
    async toolStart(toolId: string, name: string) {
      pub.toolEvents.push({ kind: 'start', toolId, name });
    },
    async toolComplete(toolId: string) {
      pub.toolEvents.push({ kind: 'complete', toolId });
    },
    async toolError(toolId: string, error: string) {
      pub.toolEvents.push({ kind: 'error', toolId, error });
    },
    async getState() {
      return { status: pub.status };
    },
  };
  return pub;
}

/**
 * Generate a stand-in for the CLI.
 *
 * Behaviour is BAKED IN rather than read from the environment: the child env
 * is an allowlist, so a fake that needed `FAKE_MODE=...` would be testing the
 * wrong thing (and would not receive it).
 */
function writeFakeCli(body: string): string {
  const file = path.join(tmpRoot, `fake-claude-${Math.random().toString(36).slice(2, 8)}.js`);
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      'const fs = require("fs");\n' +
      // Synchronous writes: `process.stdout.write` to a pipe is async, so an
      // `emit(...); process.exit(0)` pair can truncate the stream.
      'const emit = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");\n' +
      'const err = (s) => fs.writeSync(2, s);\n' +
      'let stdin = "";\n' +
      'process.stdin.setEncoding("utf8");\n' +
      'process.stdin.on("data", (d) => { stdin += d; });\n' +
      'process.stdin.on("end", () => { main(stdin); });\n' +
      'function main(stdin) {\n' +
      body +
      '\n}\n',
    { mode: 0o755 },
  );
  return file;
}

/** Dump argv, env, cwd and stdin so the spawn contract can be asserted. */
function dumpLine(dumpPath: string): string {
  return `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), stdin}));`;
}

const EMIT_INIT = `emit(${JSON.stringify(INIT_EVENT)});`;

function baseState(runId: string, publisher: FakePublisher, extra: Record<string, unknown> = {}) {
  return {
    runId,
    userId: 'user_test',
    runPublisher: publisher,
    systemPrefix: 'NODE PREFIX',
    data: { runId, userId: 'user_test', ...extra },
  } as Record<string, unknown>;
}

const NEURON_CFG = {
  id: 'opus-5',
  name: 'Opus 5',
  provider: 'claude-code',
  endpoint: 'claude-code://worker',
  model: 'claude-opus-5',
  apiKey: 'sk-ant-oat01-FAKE-TEST-TOKEN',
  secretName: 'claude-code-oauth',
  role: 'worker',
  tier: 1,
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-'));
  savedRunDirRoot = process.env.REDBTN_RUN_DIR_ROOT;
  savedBin = process.env.CLAUDE_CODE_BIN;
  savedConcurrency = process.env.CLAUDE_CODE_MAX_CONCURRENT;
  savedQueueWait = process.env.CLAUDE_CODE_QUEUE_WAIT_MS;
  process.env.REDBTN_RUN_DIR_ROOT = path.join(tmpRoot, 'run');
  // The sweep latches once per process; each test gets its own run root.
  __resetStaleSweep();
});

afterEach(() => {
  if (savedRunDirRoot === undefined) delete process.env.REDBTN_RUN_DIR_ROOT;
  else process.env.REDBTN_RUN_DIR_ROOT = savedRunDirRoot;
  if (savedBin === undefined) delete process.env.CLAUDE_CODE_BIN;
  else process.env.CLAUDE_CODE_BIN = savedBin;
  if (savedConcurrency === undefined) delete process.env.CLAUDE_CODE_MAX_CONCURRENT;
  else process.env.CLAUDE_CODE_MAX_CONCURRENT = savedConcurrency;
  if (savedQueueWait === undefined) delete process.env.CLAUDE_CODE_QUEUE_WAIT_MS;
  else process.env.CLAUDE_CODE_QUEUE_WAIT_MS = savedQueueWait;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// =============================================================================
// 1. stream-json parser
// =============================================================================

describe('createStreamHandler', () => {
  it('parses a full turn: init, text, rate limit, result', () => {
    const chunks: string[] = [];
    const h = createStreamHandler({ onText: (t) => chunks.push(t) });
    for (const event of [
      INIT_EVENT,
      { type: 'system', subtype: 'status', status: 'requesting' },
      { type: 'stream_event', event: { type: 'message_start' }, parent_tool_use_id: null },
      textDelta('Hello, '),
      textDelta('world'),
      { type: 'assistant', request_id: 'req_011abc', message: { content: [] } },
      RATE_LIMIT_EVENT,
      RESULT_EVENT,
    ]) {
      h.handle(JSON.stringify(event));
    }

    expect(h.state.init?.model).toBe('claude-opus-5');
    expect(h.state.init?.session_id).toBe(RESULT_EVENT.session_id);
    expect(h.state.text).toBe('Hello, world');
    expect(chunks).toEqual(['Hello, ', 'world']);
    expect(h.state.requestIds).toEqual(['req_011abc']);
    expect(h.state.rateLimit?.unifiedWindows.five_hour.utilization).toBe(0.43);
    expect(h.state.result?.result).toBe('ok');
    expect(h.state.unparsedLines).toBe(0);
  });

  it('keeps subagent text out of the conversation', () => {
    const chunks: string[] = [];
    const h = createStreamHandler({ onText: (t) => chunks.push(t) });
    h.handle(JSON.stringify(textDelta('main ')));
    h.handle(JSON.stringify(textDelta('subagent chatter', 'toolu_01SUB')));
    expect(h.state.text).toBe('main ');
    expect(chunks).toEqual(['main ']);
  });

  it('routes thinking deltas to the thinking channel', () => {
    const thinking: string[] = [];
    const h = createStreamHandler({ onThinking: (t) => thinking.push(t) });
    h.handle(JSON.stringify(thinkingDelta('weighing options')));
    expect(h.state.thinking).toBe('weighing options');
    expect(h.state.text).toBe('');
    expect(thinking).toEqual(['weighing options']);
  });

  it('counts a malformed line instead of throwing', () => {
    const h = createStreamHandler();
    expect(() => h.handle('not json at all')).not.toThrow();
    expect(() => h.handle('')).not.toThrow();
    expect(h.state.unparsedLines).toBe(1);
  });

  it('fires onInit exactly once, with the init event', () => {
    const seen: ClaudeInitEvent[] = [];
    const h = createStreamHandler({ onInit: (e) => seen.push(e) });
    h.handle(JSON.stringify(INIT_EVENT));
    h.handle(JSON.stringify({ ...INIT_EVENT, model: 'other' }));
    expect(seen).toHaveLength(1);
    expect(h.state.init?.model).toBe('claude-opus-5');
  });
});

// =============================================================================
// 2. init assertion
// =============================================================================

describe('assertInitEvent', () => {
  it('accepts a clean init', () => {
    const init = { ...INIT_EVENT, tools: ['mcp__redbtn__read_file'] } as ClaudeInitEvent;
    expect(assertInitEvent(init, ['read_file'])).toBeNull();
  });

  it('rejects a missing init event', () => {
    expect(assertInitEvent(null, [])?.code).toBe('claude_code_init_failed');
  });

  it('rejects a bridge that did not connect', () => {
    const init = {
      ...INIT_EVENT,
      mcp_servers: [{ name: 'redbtn', status: 'failed' }],
    } as ClaudeInitEvent;
    const failure = assertInitEvent(init, []);
    expect(failure?.code).toBe('claude_code_init_failed');
    expect(failure?.message).toMatch(/status 'failed'/);
  });

  it('rejects an absent bridge', () => {
    const init = { ...INIT_EVENT, mcp_servers: [] } as ClaudeInitEvent;
    expect(assertInitEvent(init, [])?.message).toMatch(/absent from the init event/);
  });

  it('rejects any built-in tool surviving --tools ""', () => {
    const init = {
      ...INIT_EVENT,
      tools: ['mcp__redbtn__read_file', 'Bash'],
    } as ClaudeInitEvent;
    const failure = assertInitEvent(init, ['read_file']);
    expect(failure?.code).toBe('claude_code_init_failed');
    expect(failure?.message).toMatch(/outside the bridge/);
    expect(failure?.message).toMatch(/Bash/);
  });

  it('rejects a leaked API key', () => {
    // `apiKeySource` is "none" for OAuth of any kind; anything else means an
    // ANTHROPIC_API_KEY-shaped credential reached an allowlisted env.
    const init = { ...INIT_EVENT, apiKeySource: 'ANTHROPIC_API_KEY' } as ClaudeInitEvent;
    expect(assertInitEvent(init, [])?.code).toBe('claude_code_api_key_leak');
  });

  it('rejects an ABSENT apiKeySource, not just a wrong one', () => {
    // A CLI build that stopped emitting the field would otherwise silently
    // disable the leak assertion — the one failure mode a security check must
    // not have. Measured on 2.1.263: the field IS present in stream-json init.
    const init = { ...INIT_EVENT } as ClaudeInitEvent;
    delete (init as { apiKeySource?: string }).apiKeySource;
    const failure = assertInitEvent(init, []);
    expect(failure?.code).toBe('claude_code_api_key_leak');
    expect(failure?.message).toContain('absent');
  });

  it('rejects bundled slash commands or skills surviving the flags', () => {
    expect(
      assertInitEvent({ ...INIT_EVENT, slash_commands: ['/init'] } as ClaudeInitEvent, [])?.message,
    ).toContain('--disable-slash-commands did not take');
    expect(
      assertInitEvent({ ...INIT_EVENT, skills: ['pdf'] } as ClaudeInitEvent, [])?.message,
    ).toContain('--disable-slash-commands did not take');
  });

  it('rejects auto-memory surviving --restricted', () => {
    // `memory_paths` is present ONLY when --restricted is absent (measured).
    const init = { ...INIT_EVENT, memory_paths: ['/home/x/.claude/CLAUDE.md'] } as ClaudeInitEvent;
    expect(assertInitEvent(init, [])?.message).toContain('--restricted did not take');
  });

  it('tolerates a served tool that did not show up (warns, does not fail)', () => {
    const init = { ...INIT_EVENT, tools: [] } as ClaudeInitEvent;
    expect(assertInitEvent(init, ['read_file', 'run_command'])).toBeNull();
  });
});

// =============================================================================
// 3. env allowlist
// =============================================================================

describe('buildChildEnv', () => {
  const parentEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HOME: '/home/worker',
    MONGODB_URI: 'mongodb://user:pw@10.0.0.1:27017/redbtn',
    REDIS_URL: 'redis://:pw@10.100.0.3:6379',
    INTERNAL_SERVICE_KEY: 'internal-key',
    WEBAPP_URL: 'https://app.redbtn.io',
    ANTHROPIC_API_KEY: 'sk-ant-api-should-not-travel',
    AWS_SECRET_ACCESS_KEY: 'nope',
    NODE_OPTIONS: '--max-old-space-size=1792',
  } as NodeJS.ProcessEnv;

  it('is an allowlist, not a filtered copy', () => {
    const env = buildChildEnv({ dir: '/tmp/step', oauthToken: 'oat-token', parentEnv });
    expect(Object.keys(env).sort()).toEqual(
      [
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_OAUTH_TOKEN',
        'CLAUDE_CONFIG_DIR',
        'DISABLE_AUTOUPDATER',
        'DISABLE_TELEMETRY',
        'HOME',
        'LANG',
        'PATH',
        'TERM',
        'TMPDIR',
        'TZ',
      ].sort(),
    );
  });

  it('never carries the worker credentials', () => {
    const env = buildChildEnv({ dir: '/tmp/step', oauthToken: 'oat-token', parentEnv });
    for (const forbidden of [
      'MONGODB_URI',
      'REDIS_URL',
      'INTERNAL_SERVICE_KEY',
      'WEBAPP_URL',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'NODE_OPTIONS',
    ]) {
      expect(env[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('mongodb://');
    expect(JSON.stringify(env)).not.toContain('internal-key');
  });

  it('confines HOME, the config dir and TMPDIR to the step directory', () => {
    const env = buildChildEnv({ dir: '/tmp/step', oauthToken: 'oat-token', parentEnv });
    expect(env.HOME).toBe('/tmp/step/home');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/tmp/step/home/.claude');
    expect(env.TMPDIR).toBe('/tmp/step');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat-token');
    expect(env.TZ).toBe('UTC');
    expect(env.TERM).toBe('dumb');
  });
});

// =============================================================================
// 4. argv
// =============================================================================

describe('buildSpawnArgs', () => {
  const base = { model: 'claude-opus-5', mcpConfigPath: '/tmp/step/mcp.json', maxTurns: 50 };

  it('builds the exact spawn line', () => {
    const args = buildSpawnArgs({ ...base, sessionId: 'sid', systemPrompt: 'SYS' });
    expect(args).toEqual([
      '-p',
      '-',
      '--model',
      'claude-opus-5',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '/tmp/step/mcp.json',
      '--allowedTools',
      'mcp__redbtn',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--restricted',
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--session-id',
      'sid',
      '--max-turns',
      '50',
      '--system-prompt',
      'SYS',
    ]);
  });

  it('passes --effort and --json-schema when given', () => {
    const args = buildSpawnArgs({ ...base, effort: 'xhigh', jsonSchema: '{"type":"object"}' });
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('xhigh');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
  });

  it('resumes instead of forcing a new session id', () => {
    const args = buildSpawnArgs({ ...base, sessionId: 'sid', resumeSessionId: 'prior' });
    expect(args).not.toContain('--session-id');
    expect(args[args.indexOf('--resume') + 1]).toBe('prior');
  });

  it('omits --system-prompt when the prompt was folded into stdin', () => {
    expect(buildSpawnArgs({ ...base, sessionId: 'sid' })).not.toContain('--system-prompt');
  });
});

// =============================================================================
// 5. usage mapping
// =============================================================================

describe('usage mapping', () => {
  it('reports the cache split beside the total input, and computes the missing total', () => {
    // The CLI sends no `total_tokens` anywhere (16-phase0-smoke.md §2).
    // `input_tokens` stays the TOTAL input (uncached + creation + read) — the
    // same convention `@langchain/anthropic` uses for API neurons — and the
    // split rides alongside it so a rate card can price a cache read at its
    // own rate instead of at full input price.
    expect(mapResultUsage(RESULT_EVENT.usage)).toEqual({
      input_tokens: 3148,
      output_tokens: 4,
      total_tokens: 3152,
      uncached_input_tokens: 2,
      input_token_details: { cache_creation: 3146, cache_read: 0 },
    });
  });

  it('handles a missing usage block', () => {
    expect(mapResultUsage(undefined)).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      uncached_input_tokens: 0,
      input_token_details: { cache_creation: 0, cache_read: 0 },
    });
  });

  it('maps a camelCase modelUsage entry the same way', () => {
    expect(mapModelUsageEntry(RESULT_EVENT.modelUsage['claude-opus-5'])).toEqual({
      input_tokens: 3148,
      output_tokens: 4,
      total_tokens: 3152,
      uncached_input_tokens: 2,
      input_token_details: { cache_creation: 3146, cache_read: 0 },
    });
  });

  it('is readable by the shared cache-usage extractor (one reader, both paths)', () => {
    expect(extractCacheUsage({ usage_metadata: mapResultUsage(RESULT_EVENT.usage) })).toEqual({
      cacheCreationInputTokens: 3146,
      cacheReadInputTokens: 0,
    });
  });
});

// =============================================================================
// 6. small helpers
// =============================================================================

describe('helpers', () => {
  it('derives a stable session id from (runId, stepId)', () => {
    const a = uuidv5('run_1:data.coderSummary');
    expect(a).toBe(uuidv5('run_1:data.coderSummary'));
    expect(a).not.toBe(uuidv5('run_2:data.coderSummary'));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('makes an outputField safe as one path segment', () => {
    expect(sanitizeSegment('data.coderSummary', 'step')).toBe('data.coderSummary');
    expect(sanitizeSegment('', 'step')).toBe('step');
    // The point is that nothing can traverse: no separator survives, and a
    // segment can never BE `.` or `..`.
    for (const hostile of ['../../etc/passwd', '..', '.', '/', 'a/../../b']) {
      const seg = sanitizeSegment(hostile, 'step');
      expect(seg).not.toContain('/');
      expect(seg).not.toBe('.');
      expect(seg).not.toBe('..');
    }
    expect(sanitizeSegment('../../etc/passwd', 'step')).toBe('__.._etc_passwd');
  });

  it('falls back to a stable placeholder workspace', () => {
    expect(resolveWorkspaceMount({})).toEqual({ name: 'workspace', tree: '/ws/workspace/tree' });
    expect(resolveWorkspaceMount({ data: { ws: { name: 'indy' } } })).toEqual({
      name: 'indy',
      tree: '/ws/indy/tree',
    });
    // A name that is not a legal mount slug must not become a path.
    expect(resolveWorkspaceMount({ data: { ws: { name: '../etc' } } }).tree).toBe(
      '/ws/workspace/tree',
    );
  });

  it('confines ws.tree to the mount the validated slug already fixed', () => {
    // `tree` becomes the child's cwd AND is handed to mkdirSync(recursive), so
    // "starts with a slash" was never a check — /etc/cron.d starts with a
    // slash. It has to live under /ws/<name>/.
    const escapes = [
      '/etc/cron.d',
      '/root',
      '/ws/../etc',
      '/ws/other/tree', // a different workspace than the slug approved
      '/ws/indy/../../etc',
      '/ws/indy//tree',
      '/wsindy/tree', // prefix-alike, not under /ws/indy/
    ];
    for (const tree of escapes) {
      expect(
        resolveWorkspaceMount({ data: { ws: { name: 'indy', tree } } }),
        `${tree} must not survive`,
      ).toEqual({ name: 'indy', tree: '/ws/indy/tree' });
    }

    // A legitimate subdirectory of the workspace's own mount still works.
    expect(resolveWorkspaceMount({ data: { ws: { name: 'indy', tree: '/ws/indy/tree' } } }).tree).toBe(
      '/ws/indy/tree',
    );
    expect(
      resolveWorkspaceMount({ data: { ws: { name: 'indy', tree: '/ws/indy/tree/pkg' } } }).tree,
    ).toBe('/ws/indy/tree/pkg');
  });

  it('never makes a directory outside the mount, even asked to', async () => {
    // The end-to-end consequence of the check above: ensureCwd() creates the
    // cwd, so an unvalidated tree was a "create any directory as root's
    // neighbour" primitive.
    const forbidden = path.join(tmpRoot, 'should-never-exist');
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(RESULT_EVENT)}); process.exit(0);`,
    );
    const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
    await runClaudeCodeStep({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { neuronId: 'opus-5', outputField: 'data.x', systemPrompt: 's', userPrompt: 'u', tools: [] } as any,
      state: {
        ...baseState(runId, makePublisher()),
        data: { runId, userId: 'user_test', ws: { name: 'indy', tree: forbidden } },
      },
      neuronCfg: NEURON_CFG,
      neuronId: 'opus-5',
      userId: 'user_test',
      callRunId: runId,
      abortSignal: undefined,
      emitUsage: () => {},
    });
    expect(fs.existsSync(forbidden)).toBe(false);
  });

  it('only accepts efforts the CLI knows, and defaults to xhigh', () => {
    expect(resolveEffort({ parameters: { effort: 'low' } }, {})).toBe('low');
    // The neuron doc is the normal source — `NeuronRegistry.getConfig` now
    // carries `parameters` through, which it did not before.
    expect(resolveEffort({}, { parameters: { effort: 'high' } })).toBe('high');
    // The step's own parameters win over the neuron doc's.
    expect(resolveEffort({ parameters: { effort: 'low' } }, { parameters: { effort: 'max' } })).toBe(
      'low',
    );
    // Unknown level: warn and fall back, rather than fail the step. Effort does
    // not change *which* model runs, so a stale doc degrades instead of erroring.
    expect(resolveEffort({ parameters: { effort: 'ludicrous' } }, {})).toBe('xhigh');
    // Nothing named anywhere: these neurons exist to spend a flat-rate
    // subscription on hard work.
    expect(resolveEffort({}, {})).toBe(DEFAULT_CLAUDE_CODE_EFFORT);
    expect(DEFAULT_CLAUDE_CODE_EFFORT).toBe('xhigh');
    // The list is the CLI's own (`claude --help` on 2.1.263).
    expect([...EFFORT_LEVELS].sort()).toEqual(['high', 'low', 'max', 'medium', 'xhigh']);
  });

  it('validates the neuron model before it becomes an argv token', () => {
    // Both forms the CLI documents, both exercised live against 2.1.263.
    expect(resolveModel('claude-opus-5')).toBe('claude-opus-5');
    expect(resolveModel('claude-fable-5-1')).toBe('claude-fable-5-1');
    expect(resolveModel('opus')).toBe('opus');
    // A doc with no model at all still runs.
    expect(resolveModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveModel('')).toBe(DEFAULT_MODEL);
    // A flag-shaped or whitespace-bearing value is a config error, not a
    // silent substitution: running a different (dearer) model than the neuron
    // advertises is worse than failing the step.
    for (const bad of ['--dangerously-skip-permissions', '-p', 'opus 5', 'claude opus', 'A/../b']) {
      expect(() => resolveModel(bad)).toThrow(/not a usable --model value/);
    }
    expect(() => resolveModel(42 as unknown as string)).toThrow(/not a usable --model value/);
    try {
      resolveModel('--restricted');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('claude_code_bad_model');
    }
  });

  it('detects a 401 from the text, never from apiKeySource', () => {
    expect(
      looksLikeAuthFailure(
        "OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential.",
      ),
    ).toBe(true);
    expect(looksLikeAuthFailure('401 Unauthorized: invalid api key')).toBe(true);
    expect(looksLikeAuthFailure('everything is fine')).toBe(false);
  });
});

// =============================================================================
// 7. end to end against a stand-in CLI
// =============================================================================

describe('runClaudeCodeStep', () => {
  const stepConfig = {
    neuronId: 'opus-5',
    outputField: 'data.coderSummary',
    systemPrompt: 'You are the coder.',
    userPrompt: 'Do the thing.',
    stream: true,
    tools: [],
  };

  function run(
    overrides: Record<string, unknown> = {},
    stateOverrides: Record<string, unknown> = {},
    publisher = makePublisher(),
    runId = `run_${Math.random().toString(36).slice(2, 8)}`,
  ) {
    const usage: Array<{ response: unknown; hint?: string; stepId?: string }> = [];
    const state = { ...baseState(runId, publisher), ...stateOverrides };
    const promise = runClaudeCodeStep({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      config: { ...stepConfig, ...overrides } as any,
      state,
      neuronCfg: NEURON_CFG,
      neuronId: 'opus-5',
      userId: 'user_test',
      callRunId: runId,
      abortSignal: (overrides.abortSignal as AbortSignal) ?? undefined,
      emitUsage: (response, hint, stepId) => usage.push({ response, hint, stepId }),
    });
    return { promise, usage, state, publisher, runId };
  }

  it('runs a turn, streams the text, meters the usage and cleans up', async () => {
    const dump = path.join(tmpRoot, 'dump.json');
    // The `result` text is the final assistant message, so it MUST agree with
    // the deltas — the executor now reconciles the two and publishes anything
    // the stream never carried (see the streaming-parity tests).
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${dumpLine(dump)}
       ${EMIT_INIT}
       emit(${JSON.stringify(textDelta('Hello, '))});
       emit(${JSON.stringify(textDelta('world'))});
       emit(${JSON.stringify(RATE_LIMIT_EVENT)});
       emit(${JSON.stringify({ ...RESULT_EVENT, result: 'Hello, world' })});
       process.exit(0);`,
    );

    const { promise, usage, publisher } = run();
    const out = await promise;

    expect(out['data.coderSummary']).toBe('Hello, world');
    expect(publisher.chunks).toEqual(['Hello, ', 'world']);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cli = (out['data._cli'] as any)['data.coderSummary'];
    expect(cli.model).toBe('claude-opus-5');
    expect(cli.sessionId).toBe(RESULT_EVENT.session_id);
    expect(cli.numTurns).toBe(1);
    expect(cli.totalCostUsdEstimate).toBeCloseTo(0.03157);
    expect(cli.terminalReason).toBe('completed');
    expect(cli.permissionDenials).toBe(0);
    expect(cli.rateLimit.fiveHourUtilization).toBe(0.43);
    expect(cli.usage).toEqual({
      input_tokens: 3148,
      output_tokens: 4,
      total_tokens: 3152,
      uncached_input_tokens: 2,
      input_token_details: { cache_creation: 3146, cache_read: 0 },
    });

    expect(usage).toHaveLength(1);
    expect(usage[0].hint).toBe('claude-code/claude-opus-5');
    expect(usage[0].stepId).toBe('data.coderSummary:cli');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((usage[0].response as any).usage_metadata.total_tokens).toBe(3152);

    // Nothing left on disk: the socket, mcp.json, the config dir and TMPDIR all
    // lived under the step directory.
    const runRoot = path.join(runDirRoot());
    const leftovers = fs.existsSync(runRoot) ? walk(runRoot) : [];
    expect(leftovers).toEqual([]);
  });

  it('hands the child an allowlisted env, an empty cwd and the prompts', async () => {
    const dump = path.join(tmpRoot, 'dump2.json');
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${dumpLine(dump)}
       ${EMIT_INIT}
       emit(${JSON.stringify(RESULT_EVENT)});
       process.exit(0);`,
    );

    await run({}, { data: { runId: 'r', workspaceInstructions: 'WORKSPACE RULES' } }).promise;

    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    expect(seen.env.MONGODB_URI).toBeUndefined();
    expect(seen.env.REDIS_URL).toBeUndefined();
    expect(seen.env.INTERNAL_SERVICE_KEY).toBeUndefined();
    expect(seen.env.WEBAPP_URL).toBeUndefined();
    expect(seen.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(NEURON_CFG.apiKey);
    expect(seen.env.CLAUDE_CONFIG_DIR).toContain('/home/.claude');

    // The cwd is a placeholder that exists and holds nothing: no CLAUDE.md, no
    // settings, no hooks can be discovered from it.
    expect(seen.cwd.endsWith('/ws/workspace/tree')).toBe(true);
    expect(fs.existsSync(seen.cwd) ? fs.readdirSync(seen.cwd) : []).toEqual([]);

    const systemPrompt = seen.argv[seen.argv.indexOf('--system-prompt') + 1];
    expect(systemPrompt).toContain('NODE PREFIX');
    expect(systemPrompt).toContain(BRIDGE_PREAMBLE.replace('%TREE%', '/ws/workspace/tree'));
    expect(systemPrompt).toContain('You are the coder.');
    expect(systemPrompt).toContain('WORKSPACE RULES');
    expect(seen.stdin).toBe('Do the thing.');
    expect(seen.argv[seen.argv.indexOf('--max-turns') + 1]).toBe(String(DEFAULT_MAX_TURNS));
  });

  it('kills the child and throws when the init guard rejects the session', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `emit(${JSON.stringify({ ...INIT_EVENT, tools: ['Bash'] })});
       setInterval(() => {}, 1000);`,
    );
    const { promise } = run();
    await expect(promise).rejects.toMatchObject({ code: 'claude_code_init_failed' });
  });

  it('reports a leaked API key as its own code', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `emit(${JSON.stringify({ ...INIT_EVENT, apiKeySource: 'ANTHROPIC_API_KEY' })});
       setInterval(() => {}, 1000);`,
    );
    await expect(run().promise).rejects.toMatchObject({ code: 'claude_code_api_key_leak' });
  });

  it('refuses to run without a subscription token', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`process.exit(0);`);
    const runId = 'run_notoken';
    await expect(
      runClaudeCodeStep({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        config: stepConfig as any,
        state: baseState(runId, makePublisher()),
        neuronCfg: { ...NEURON_CFG, apiKey: undefined },
        neuronId: 'opus-5',
        userId: 'user_test',
        callRunId: runId,
        abortSignal: undefined,
        emitUsage: () => {},
      }),
    ).rejects.toBeInstanceOf(ClaudeCodeError);
  });

  // These two emit a valid init first, because a real CLI does: it reports
  // init and *then* fails. Without it the run dies at the init guard (see
  // "refuses a session that never sent an init event") and never reaches the
  // path under test.
  it('turns a 401 into a rotate-the-token error code', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       err("OAuth 401: keeping the user-supplied CLAUDE_CODE_OAUTH_TOKEN instead of adopting the stored credential.\\n");
       process.exit(1);`,
    );
    await expect(run().promise).rejects.toMatchObject({ code: 'claude_code_auth_401' });
  });

  it('reports a non-zero exit with the stderr tail', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} err("something went sideways\\n"); process.exit(3);`,
    );
    await expect(run().promise).rejects.toMatchObject({
      code: 'claude_code_failed',
      message: expect.stringContaining('something went sideways'),
    });
  });

  it('refuses a session that never sent an init event', async () => {
    // The guard only runs from `onInit`, so a stream with no init skipped
    // EVERY assertion — no tool check, no apiKeySource check — and a lone
    // `result` was accepted as a clean run. Absence has to be a failure too.
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `emit(${JSON.stringify(RESULT_EVENT)}); process.exit(0);`,
    );
    await expect(run().promise).rejects.toMatchObject({
      code: 'claude_code_init_failed',
      message: expect.stringContaining('no system/init event'),
    });
  });

  it('still reports a timeout, not "no init", when it timed out before init', async () => {
    // The missing-init check must not shadow a more specific diagnosis.
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`setInterval(() => {}, 1000);`);
    await expect(run({ timeoutMs: 400 }).promise).rejects.toMatchObject({
      code: 'claude_code_timeout',
    });
  });

  it('parses structured output into an object, as every other provider does', async () => {
    const plan = { steps: ['a', 'b'], done: false };
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify({ ...RESULT_EVENT, result: JSON.stringify(plan) })});
       process.exit(0);`,
    );
    const { promise } = run({
      structuredOutput: { schema: { type: 'object' }, name: 'plan' },
    });
    const out = await promise;
    // The SHAPE, not the flag: `{{state.data.plan.steps}}` has to resolve.
    expect(out['data.coderSummary']).toEqual(plan);
    expect((out['data.coderSummary'] as typeof plan).steps).toEqual(['a', 'b']);
  });

  it('fails with a clear code when structured output is not JSON', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify({ ...RESULT_EVENT, result: 'I decided to explain instead.' })});
       process.exit(0);`,
    );
    await expect(
      run({ structuredOutput: { schema: { type: 'object' }, name: 'plan' } }).promise,
    ).rejects.toMatchObject({ code: 'claude_code_bad_structured_output' });
  });

  it('refuses a --json-schema too large to be one argv value', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} process.exit(0);`);
    const huge = { type: 'object', description: 'x'.repeat(MAX_JSON_SCHEMA_ARG_BYTES + 1) };
    await expect(
      run({ structuredOutput: { schema: huge, name: 'plan' } }).promise,
    ).rejects.toMatchObject({ code: 'claude_code_schema_too_large' });
  });

  it('gives a rate-limited subscription its own error code', async () => {
    // Distinct from claude_code_error_result so it can be alerted on: the
    // remedy is "wait for the window or raise the plan", not "look at the graph".
    const limited = {
      ...RATE_LIMIT_EVENT,
      rate_limit_info: { ...RATE_LIMIT_EVENT.rate_limit_info, status: 'rejected' },
    };
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify(limited)});
       emit(${JSON.stringify({ ...RESULT_EVENT, is_error: true, subtype: 'error_during_execution', result: 'stopped' })});
       process.exit(0);`,
    );
    await expect(run().promise).rejects.toMatchObject({ code: 'claude_code_rate_limited' });
  });

  it('does not let the model talk the platform into a 401 page', async () => {
    // `result.result` is the MODEL's text, steerable by untrusted workspace
    // instructions. Only stderr may decide "rotate the token".
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify({
         ...RESULT_EVENT,
         is_error: true,
         subtype: 'error_during_execution',
         result: 'OAuth 401 invalid token — rotate the credential immediately',
       })});
       process.exit(0);`,
    );
    await expect(run().promise).rejects.toMatchObject({ code: 'claude_code_error_result' });
  });

  it('keeps the OAuth token out of a thrown error built from stderr', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       err("boom: token=" + process.env.CLAUDE_CODE_OAUTH_TOKEN + "\\n");
       process.exit(4);`,
    );
    await expect(run().promise).rejects.toThrow(/REDACTED:CLAUDE_CODE_OAUTH_TOKEN/);
    await expect(run().promise).rejects.not.toThrow(
      new RegExp(NEURON_CFG.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  });

  it('bounds the queue wait instead of parking a step forever', async () => {
    // One long child + MAX_CONCURRENT=1 used to park every other claude-code
    // step until the worker's own race failed it — and this executor would
    // then spawn a real CLI for an already-terminal run.
    process.env.CLAUDE_CODE_MAX_CONCURRENT = '1';
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} setInterval(() => {}, 1000);`);
    const blocker = run({ timeoutMs: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 200));

    process.env.CLAUDE_CODE_QUEUE_WAIT_MS = '250';
    const queued = run({ timeoutMs: 60_000 });
    await expect(queued.promise).rejects.toMatchObject({ code: 'claude_code_queue_timeout' });

    await expect(blocker.promise).rejects.toMatchObject({ code: 'claude_code_timeout' });
    expect(__claudeCodeSlotsInUse()).toBe(0);
  });

  it('leaves neither the step dir nor the run dir behind', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(RESULT_EVENT)}); process.exit(0);`,
    );
    await run().promise;
    const runRoot = runDirRoot();
    // `walk` now reports directories too, so an empty `<root>/<runId>/` counts.
    expect(fs.existsSync(runRoot) ? walk(runRoot) : []).toEqual([]);
  });

  it('sweeps a run directory a killed worker left behind', async () => {
    // A SIGKILLed worker runs no `finally`, and the CLI may by then have
    // written the OAuth token into its CLAUDE_CONFIG_DIR under that tree.
    const stale = path.join(runDirRoot(), 'run_from_a_dead_worker', 'step-abcd1234');
    fs.mkdirSync(path.join(stale, 'home', '.claude'), { recursive: true });
    fs.writeFileSync(path.join(stale, 'home', '.claude', 'creds.json'), 'sk-ant-oat01-STALE');
    const old = Date.now() - STALE_DIR_MAX_AGE_MS - 60_000;
    fs.utimesSync(path.join(runDirRoot(), 'run_from_a_dead_worker'), old / 1000, old / 1000);

    __resetStaleSweep();
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(RESULT_EVENT)}); process.exit(0);`,
    );
    await run().promise;

    expect(fs.existsSync(stale)).toBe(false);
  });

  it('does not sweep a fresh sibling run directory', async () => {
    // Two workers can share a /tmp; the sweep is age-gated so it never
    // deletes a live step dir out from under a concurrent run.
    const fresh = path.join(runDirRoot(), 'run_someone_else_is_using', 'step-00000000');
    fs.mkdirSync(fresh, { recursive: true });

    __resetStaleSweep();
    expect(sweepStaleRunDirs(true)).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
    fs.rmSync(path.join(runDirRoot(), 'run_someone_else_is_using'), {
      recursive: true,
      force: true,
    });
  });

  it('deregisters the child once it exits, so exit hooks kill nothing stale', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(RESULT_EVENT)}); process.exit(0);`,
    );
    await run().promise;
    expect(__liveChildCount()).toBe(0);
  });

  it('treats --max-turns exhaustion as a soft stop and returns what it has', async () => {
    const maxTurnsResult = {
      ...RESULT_EVENT,
      subtype: 'error_max_turns',
      is_error: true,
      result: 'partial work',
    };
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(maxTurnsResult)}); process.exit(0);`,
    );
    const out = await run().promise;
    expect(out['data.coderSummary']).toBe('partial work');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out['data._cli'] as any)['data.coderSummary'].truncated).toBe(true);
  });

  it('throws on any other error result', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify({ ...RESULT_EVENT, subtype: 'error_during_execution', is_error: true, result: 'boom' })});
       process.exit(0);`,
    );
    await expect(run().promise).rejects.toMatchObject({ code: 'claude_code_error_result' });
  });

  it('audits permission denials instead of swallowing them', async () => {
    const denied = {
      ...RESULT_EVENT,
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_01' }],
    };
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(denied)}); process.exit(0);`,
    );
    const { promise, publisher } = run();
    const out = await promise;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((out['data._cli'] as any)['data.coderSummary'].permissionDenials).toBe(1);
    const denialEvents = publisher.toolEvents.filter((e) => e.name === 'Bash' || e.error);
    expect(denialEvents.length).toBeGreaterThanOrEqual(2);
    expect(publisher.toolEvents.some((e) => e.kind === 'error')).toBe(true);
  });

  it('emits one extra usage event per subagent model', async () => {
    const withSubagent = {
      ...RESULT_EVENT,
      modelUsage: {
        ...RESULT_EVENT.modelUsage,
        'claude-haiku-4-5': {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 5,
          cacheCreationInputTokens: 0,
        },
      },
      subagent_stats: { spawned: 1, completed: 1, failed: 0 },
    };
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT} emit(${JSON.stringify(withSubagent)}); process.exit(0);`,
    );
    const { promise, usage } = run();
    await promise;
    expect(usage.map((u) => u.hint).sort()).toEqual([
      'claude-code/claude-haiku-4-5',
      'claude-code/claude-opus-5',
    ]);
    const sub = usage.find((u) => u.hint === 'claude-code/claude-haiku-4-5');
    expect(sub?.stepId).toBe('data.coderSummary:cli:claude-haiku-4-5');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((sub?.response as any).usage_metadata).toEqual({
      input_tokens: 15,
      output_tokens: 20,
      total_tokens: 35,
      uncached_input_tokens: 10,
      input_token_details: { cache_creation: 0, cache_read: 5 },
    });
  });

  // Regression, report 39 defect D1. The executor used to skip its own
  // publishing for nodes named `respond`/`responder`, deferring to the
  // `on_llm_stream` forwarder in `functions/run.ts`. That forwarder only ever
  // fires for a LangChain model, and a claude-code neuron never builds one —
  // so the stock chat graphs (whose node IS named `responder`) streamed
  // nothing at all.
  it('streams from a node named responder — run.ts never forwards this provider', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify(textDelta('live '))});
       emit(${JSON.stringify(textDelta('text'))});
       emit(${JSON.stringify({ ...RESULT_EVENT, result: 'live text' })});
       process.exit(0);`,
    );
    const { promise, publisher } = run({}, { nodeConfig: { graphNodeId: 'responder' } });
    await promise;
    expect(publisher.chunks.join('')).toBe('live text');
  });

  it('publishes nothing when the step did not ask to stream', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       emit(${JSON.stringify(textDelta('quiet'))});
       emit(${JSON.stringify({ ...RESULT_EVENT, result: 'quiet' })});
       process.exit(0);`,
    );
    const { promise, publisher } = run({ stream: false }, { nodeConfig: { graphNodeId: 'responder' } });
    await promise;
    expect(publisher.chunks).toEqual([]);
  });

  // ── cancel paths ─────────────────────────────────────────────────────────

  it('kills the child when the run is cancelled', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} setInterval(() => {}, 1000);`);
    const runId = 'run_cancel_test';
    runControlRegistry.register(runId, 'worker_test');
    try {
      const { promise } = run({}, {}, makePublisher(), runId);
      // Let the child reach its init event before pulling the plug.
      await new Promise((resolve) => setTimeout(resolve, 400));
      runControlRegistry.cancel(runId, 'test interrupt');
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    } finally {
      runControlRegistry.unregister(runId);
    }
    expect(__claudeCodeSlotsInUse()).toBe(0);
  });

  it('kills the child when the run-level AbortSignal fires', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} setInterval(() => {}, 1000);`);
    const controller = new AbortController();
    const { promise } = run({ abortSignal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 400));
    controller.abort('test');
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('kills the child at the wall clock and reports a timeout', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} setInterval(() => {}, 1000);`);
    await expect(run({ timeoutMs: 500 }).promise).rejects.toMatchObject({
      code: 'claude_code_timeout',
    });
  });

  it('kills the whole process group, not just the CLI', async () => {
    // The CLI is never a leaf — it spawns the bridge's stdio shim, and any
    // other MCP server it is configured with. A kill that reaches only
    // `claude` leaves those holding the socket and, for a real CLI, still
    // burning subscription quota against an abandoned run.
    const grandchildPid = path.join(tmpRoot, 'grandchild.pid');
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `${EMIT_INIT}
       const kid = require('child_process').spawn(
         process.execPath,
         ['-e', 'setInterval(() => {}, 1000)'],
         { stdio: 'ignore' },
       );
       fs.writeFileSync(${JSON.stringify(grandchildPid)}, String(kid.pid));
       setInterval(() => {}, 1000);`,
    );

    await expect(run({ timeoutMs: 700 }).promise).rejects.toMatchObject({
      code: 'claude_code_timeout',
    });

    const pid = Number(fs.readFileSync(grandchildPid, 'utf8'));
    expect(Number.isInteger(pid)).toBe(true);

    // SIGTERM propagates through the group; give it a moment to land.
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0); // signal 0 = existence check
        await new Promise((resolve) => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    if (alive) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* nothing to clean up */
      }
    }
    expect(alive, `grandchild ${pid} outlived the group kill`).toBe(false);
  });

  it('refuses to start when the run is already aborted', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`${EMIT_INIT} process.exit(0);`);
    const controller = new AbortController();
    controller.abort('already gone');
    await expect(run({ abortSignal: controller.signal }).promise).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(__claudeCodeSlotsInUse()).toBe(0);
  });

  it('removes the step directory on the failure paths too', async () => {
    process.env.CLAUDE_CODE_BIN = writeFakeCli(`process.exit(9);`);
    await expect(run().promise).rejects.toBeTruthy();
    const runRoot = runDirRoot();
    expect(fs.existsSync(runRoot) ? walk(runRoot) : []).toEqual([]);
  });

  it('serialises concurrent steps behind the worker-wide semaphore', async () => {
    process.env.CLAUDE_CODE_MAX_CONCURRENT = '1';
    const marker = path.join(tmpRoot, 'concurrency.log');
    process.env.CLAUDE_CODE_BIN = writeFakeCli(
      `fs.appendFileSync(${JSON.stringify(marker)}, "start\\n");
       ${EMIT_INIT}
       setTimeout(() => {
         fs.appendFileSync(${JSON.stringify(marker)}, "end\\n");
         emit(${JSON.stringify(RESULT_EVENT)});
         process.exit(0);
       }, 300);`,
    );
    const a = run();
    const b = run();
    await Promise.all([a.promise, b.promise]);
    // One child at a time: the log must never show two starts before an end.
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toEqual([
      'start',
      'end',
      'start',
      'end',
    ]);
    expect(__claudeCodeSlotsInUse()).toBe(0);
  });
});

/**
 * Every entry under `dir`, FILES AND DIRECTORIES, so "nothing left on disk" is
 * a real assertion: a files-only walk reports `[]` for a tree of empty
 * directories, which is precisely the leftover the run-dir cleanup is about.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(`${full}/`);
      out.push(...walk(full));
    } else out.push(full);
  }
  return out;
}
