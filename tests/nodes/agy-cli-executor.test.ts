/**
 * `agy-cli` neuron executor — the contract.
 *
 * Five of these are the specification and the rest are consequences:
 *
 *   1. The child's environment is an ALLOWLIST, and the entries that matter
 *      most are the Gemini ones. `MONGODB_URI` / `REDIS_URL` /
 *      `INTERNAL_SERVICE_KEY` must not reach a process the model can read
 *      `/proc/self/environ` from — and `GEMINI_API_KEY` must not either, because
 *      a leaked one would silently move a SUBSCRIPTION neuron onto the metered
 *      API, which is the bill this provider exists to avoid.
 *   2. `--dangerously-skip-permissions` is never passed. It is the CLI's
 *      documented escape from headless deny-by-default; passing it would
 *      auto-approve every built-in tool.
 *   3. The private HOME is built at the exact paths the CLI reads, with exactly
 *      one permission grant and an EMPTY deny list.
 *   4. Usage adds the cache read back into the input total, because this CLI
 *      reports it outside and every other provider in the engine reports it
 *      inside.
 *   5. A turn the permission policy blocked fails the step instead of writing
 *      an empty string into graph state.
 *
 * The envelope fixtures are the real wire shapes, recorded off agy 1.1.27 on
 * 2026-09-08.
 *
 * The "CLI" here is a generated node script — the executor spawns whatever
 * `AGY_CLI_BIN` names, and the script bakes its behaviour in rather than
 * reading env vars, because the env allowlist is precisely what stops a child
 * from receiving any.
 *
 * NOTE: never run this on a fleet box by hand — CI (org runners) runs it, and
 * the shell on a fleet node exports production database URIs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runAgyCliStep,
  buildAgyChildEnv,
  buildAgySpawnArgs,
  buildAgyHome,
  parseAgyEnvelope,
  mapAgyUsage,
  resolveAgyModel,
  resolveAgyEffort,
  resolveWorkspaceMount,
  readCachedToken,
  writeCachedToken,
  withStateLock,
  looksLikeRateLimit,
  looksLikeAuthPrompt,
  stripGlogNoise,
  redactToken,
  redactArgvForLog,
  bridgeGrant,
  agyStateDir,
  maxConcurrent,
  AgyCliError,
  AGY_MODELS,
  AGY_HOME_PATHS,
  DEFAULT_MODEL,
  MAX_PROMPT_ARG_BYTES,
  EFFORT_LEVELS,
  __agySlotsInUse,
  __agyLiveChildCount,
} from '../../src/lib/nodes/universal/executors/agyCliExecutor';
import { extractCacheUsage } from '../../src/lib/neurons/prompt-cache';
import { AGY_EFFORT_LEVELS, DEFAULT_AGY_EFFORT } from '../../src/lib/types/neuron';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// =============================================================================
// Fixtures — real wire shapes (agy 1.1.27, 2026-09-08)
// =============================================================================

/** A clean turn. Note `cache_read_tokens` sits OUTSIDE `total_tokens`. */
const SUCCESS_ENVELOPE = {
  conversation_id: 'b01a9675-99d1-4481-a44a-8a872a2da48a',
  status: 'SUCCESS',
  response: 'ok-e1\n',
  duration_seconds: 0.786981509,
  num_turns: 1,
  usage: {
    input_tokens: 5551,
    output_tokens: 4,
    thinking_tokens: 0,
    cache_read_tokens: 8130,
    total_tokens: 5555,
  },
};

/** A turn the permission policy blocked. `response` is EMPTY. */
const DENIED_ENVELOPE = {
  conversation_id: '1bbeff54-4a65-4b11-b512-a5a2ce7fb3ee',
  status: 'SUCCESS',
  response: '',
  duration_seconds: 1.167558603,
  num_turns: 1,
  usage: {
    input_tokens: 13696,
    output_tokens: 137,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 13833,
  },
  denied_actions: [{ action: 'command', display_name: 'RunCommand' }],
};

/** The CLI's own `--print-timeout` firing. */
const TIMEOUT_ENVELOPE = {
  conversation_id: 'fe228638-c16a-40c8-9f52-777e2bef4057',
  status: 'ERROR',
  response: '',
  error: 'timeout waiting for response',
  duration_seconds: 89.321910577,
  num_turns: 1,
  usage: {
    input_tokens: 165673,
    output_tokens: 13529,
    thinking_tokens: 10137,
    cache_read_tokens: 839027,
    total_tokens: 179202,
  },
};

/** A bad credential. Reached only after the CLI's 60 s interactive window. */
const AUTH_ENVELOPE = {
  conversation_id: '',
  status: 'ERROR',
  response: '',
  error: 'authentication failed or timed out',
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
    cache_read_tokens: 0,
    total_tokens: 0,
  },
};

/** The stderr the CLI prints while it waits for an interactive login. */
const AUTH_STDERR =
  'Authentication required. Please visit the URL to log in:\n' +
  '  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-x.apps.googleusercontent.com\n' +
  '\nWaiting for authentication (timeout 60s)...\n';

/** The glog banner every run prints before `google.Init`. Not a diagnostic. */
const GLOG_NOISE =
  'ERROR: logging before google.Init: I0908 22:14:30.251440 1 cli_setting_manager.go:92] ' +
  'CLI settings initialized: permissions=<nil>, toolPermission=request-review\n';

const TOKEN = 'ya29.FAKE-ANTIGRAVITY-OAUTH-TOKEN-FOR-TESTS-0123456789';

const NEURON_CFG = {
  id: 'agy-flash-3-8',
  name: 'Agy Flash 3.8',
  provider: 'agy-cli',
  endpoint: 'agy-cli://worker',
  model: 'gemini-3.8-flash',
  apiKey: TOKEN,
  secretName: 'agy-oauth-token',
  role: 'worker',
  tier: 1,
  parameters: { effort: 'high' },
};

// =============================================================================
// Harness
// =============================================================================

let tmpRoot: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'REDBTN_RUN_DIR_ROOT',
  'AGY_CLI_BIN',
  'AGY_STATE_DIR',
  'AGY_CLI_MAX_CONCURRENT',
  'AGY_CLI_QUEUE_WAIT_MS',
  'AGY_OAUTH_TOKEN',
  'AGY_INSTALLATION_ID',
];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-'));
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  process.env.REDBTN_RUN_DIR_ROOT = path.join(tmpRoot, 'run');
  process.env.AGY_STATE_DIR = path.join(tmpRoot, 'state');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key] as string;
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/**
 * Write a fake `agy`. The body runs immediately — unlike the Claude CLI this
 * one is spawned with stdin IGNORED, so a fake that waited for `stdin.end`
 * would hang forever.
 */
function writeFakeAgy(body: string): string {
  const file = path.join(tmpRoot, `fake-agy-${Math.random().toString(36).slice(2, 8)}.js`);
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n` +
      "'use strict';\n" +
      'const fs = require("fs");\n' +
      // Synchronous writes: a `process.stdout.write` to a pipe is async, so an
      // `out(...); process.exit(0)` pair can truncate the envelope.
      'const out = (o) => fs.writeSync(1, typeof o === "string" ? o : JSON.stringify(o) + "\\n");\n' +
      'const err = (s) => fs.writeSync(2, s);\n' +
      body +
      '\n',
    { mode: 0o755 },
  );
  return file;
}

/** Dump argv, env and cwd so the spawn contract can be asserted. */
function dumpLine(dumpPath: string): string {
  // `cwdEntries` is captured by the CHILD, because the step directory the cwd
  // may fall back into is removed by the executor's `finally` before the test
  // gets to look at it.
  return `fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({argv: process.argv.slice(2), env: process.env, cwd: process.cwd(), cwdEntries: fs.readdirSync(process.cwd()), homeToken: fs.readFileSync(require("path").join(process.env.HOME, ".gemini/antigravity-cli/antigravity-oauth-token"), "utf8"), grants: fs.readFileSync(require("path").join(process.env.HOME, ".gemini/config/config.json"), "utf8")}));`;
}

interface FakePublisher {
  toolStart: Any;
  toolError: Any;
  events: Array<{ kind: string; name?: string }>;
}

function makePublisher(): FakePublisher {
  const events: Array<{ kind: string; name?: string }> = [];
  return {
    events,
    toolStart: async (_id: string, name: string) => {
      events.push({ kind: 'toolStart', name });
    },
    toolError: async () => {
      events.push({ kind: 'toolError' });
    },
  };
}

function baseState(runId: string, publisher?: FakePublisher, extra: Record<string, unknown> = {}) {
  return {
    runId,
    userId: 'user_test',
    runPublisher: publisher,
    systemPrefix: 'NODE PREFIX',
    data: { runId, userId: 'user_test', ...extra },
  } as Record<string, unknown>;
}

function stepConfig(over: Record<string, unknown> = {}) {
  return {
    neuronId: 'agy-flash-3-8',
    outputField: 'data.out',
    systemPrompt: 'be terse',
    userPrompt: 'say ok',
    tools: [],
    ...over,
  } as Any;
}

async function runStep(over: Record<string, unknown> = {}, stateOver: Record<string, unknown> = {}) {
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const usage: Array<{ response: unknown; hint?: string }> = [];
  const publisher = makePublisher();
  const result = await runAgyCliStep({
    config: stepConfig(over),
    state: baseState(runId, publisher, stateOver),
    neuronCfg: NEURON_CFG,
    neuronId: 'agy-flash-3-8',
    userId: 'user_test',
    callRunId: runId,
    abortSignal: undefined,
    emitUsage: (response, hint) => usage.push({ response, hint }),
  });
  return { result, usage, publisher, runId };
}

// =============================================================================
// 1. argv — the security-relevant shape
// =============================================================================

describe('buildAgySpawnArgs', () => {
  it('builds the exact spawn line', () => {
    expect(
      buildAgySpawnArgs({
        model: 'gemini-3.8-flash',
        effort: 'high',
        prompt: 'PROMPT',
        printTimeoutMs: 120_000,
      }),
    ).toEqual([
      '-p',
      'PROMPT',
      '--model',
      'gemini-3.8-flash',
      '--effort',
      'high',
      '--output-format',
      'json',
      '--disable-slash-commands',
      '--sandbox',
      '--print-timeout',
      '120s',
    ]);
  });

  it('NEVER passes --dangerously-skip-permissions', () => {
    // The CLI's documented escape from headless deny-by-default. With it, every
    // built-in tool (shell, file write, web fetch) is auto-approved and the
    // whole permission design below is decoration.
    for (const effort of [undefined, 'low', 'high']) {
      const args = buildAgySpawnArgs({
        model: 'gemini-3.8-flash',
        effort,
        prompt: 'p',
        printTimeoutMs: 1000,
        jsonSchema: '{}',
        conversationId: 'c',
      });
      expect(args).not.toContain('--dangerously-skip-permissions');
      expect(args).not.toContain('--mode');
    }
  });

  it('omits --effort entirely when the model refuses one', () => {
    // VERIFIED: `--effort high` with claude-sonnet-4-6 is refused at
    // argument-parse time, before a conversation exists.
    const args = buildAgySpawnArgs({
      model: 'claude-sonnet-4-6',
      effort: undefined,
      prompt: 'p',
      printTimeoutMs: 1000,
    });
    expect(args).not.toContain('--effort');
  });

  it('passes --json-schema and --conversation when given', () => {
    const args = buildAgySpawnArgs({
      model: 'gemini-3.8-flash-low',
      prompt: 'p',
      printTimeoutMs: 90_000,
      jsonSchema: '{"type":"object"}',
      conversationId: 'abc-123',
    });
    expect(args).toContain('--json-schema');
    expect(args[args.indexOf('--json-schema') + 1]).toBe('{"type":"object"}');
    expect(args[args.indexOf('--conversation') + 1]).toBe('abc-123');
  });

  it('converts the print timeout to whole seconds, never below 1', () => {
    const short = buildAgySpawnArgs({ model: 'gemini-3.8-flash', prompt: 'p', printTimeoutMs: 10 });
    expect(short[short.indexOf('--print-timeout') + 1]).toBe('1s');
  });

  it('elides the prompt and the schema from a log line', () => {
    const args = buildAgySpawnArgs({
      model: 'gemini-3.8-flash',
      prompt: 'x'.repeat(4096),
      printTimeoutMs: 1000,
      jsonSchema: '{"a":1}',
    });
    const logged = redactArgvForLog(args);
    expect(logged.join(' ')).not.toContain('xxxx');
    expect(logged).toContain('<4096 bytes>');
  });
});

// =============================================================================
// 2. The child environment
// =============================================================================

describe('buildAgyChildEnv', () => {
  const parent = {
    PATH: '/usr/bin',
    LANG: 'en_GB.UTF-8',
    MONGODB_URI: 'mongodb://prod/redbtn',
    REDIS_URL: 'redis://:pw@10.100.0.3:6379',
    INTERNAL_SERVICE_KEY: 'internal-secret',
    WEBAPP_URL: 'https://app.redbtn.io',
    GEMINI_API_KEY: 'AIza-METERED-KEY',
    GOOGLE_API_KEY: 'AIza-OTHER-KEY',
    GOOGLE_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com',
    AGY_OAUTH_TOKEN: TOKEN,
  } as NodeJS.ProcessEnv;

  it('is an allowlist, not a filtered copy', () => {
    const env = buildAgyChildEnv({ home: '/step/home', dir: '/step', parentEnv: parent });
    expect(Object.keys(env).sort()).toEqual(
      ['HOME', 'LANG', 'NO_COLOR', 'PATH', 'TERM', 'TMPDIR', 'TZ', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].sort(),
    );
  });

  it('never carries the worker credentials', () => {
    const env = buildAgyChildEnv({ home: '/step/home', dir: '/step', parentEnv: parent });
    for (const key of ['MONGODB_URI', 'REDIS_URL', 'INTERNAL_SERVICE_KEY', 'WEBAPP_URL']) {
      expect(env[key]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('internal-secret');
  });

  it('never carries a Gemini API key into a SUBSCRIPTION child', () => {
    // The one that is specific to this provider. A leaked GEMINI_API_KEY would
    // let the CLI answer on the metered API while still looking like a
    // subscription run — the exact bill `agy-cli` exists to stop paying.
    const env = buildAgyChildEnv({ home: '/step/home', dir: '/step', parentEnv: parent });
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GEMINI_BASE_URL']) {
      expect(env[key]).toBeUndefined();
    }
    expect(JSON.stringify(env)).not.toContain('AIza');
  });

  it('never carries the OAuth token as an environment value', () => {
    // Unlike claude-code, the credential here is a FILE inside the private
    // HOME. Keeping it out of the env keeps it out of `/proc/self/environ` and
    // out of every `ps -e` on the worker.
    const env = buildAgyChildEnv({ home: '/step/home', dir: '/step', parentEnv: parent });
    expect(JSON.stringify(env)).not.toContain(TOKEN);
  });

  it('confines HOME, the XDG dirs and TMPDIR to the step directory', () => {
    const env = buildAgyChildEnv({ home: '/step/home', dir: '/step', parentEnv: parent });
    expect(env.HOME).toBe('/step/home');
    expect(env.TMPDIR).toBe('/step');
    expect(env.XDG_CONFIG_HOME).toBe('/step/home/.config');
    expect(env.XDG_CACHE_HOME).toBe('/step/home/.cache');
  });
});

// =============================================================================
// 3. The private HOME
// =============================================================================

describe('buildAgyHome', () => {
  const mcpConfig = {
    mcpServers: {
      redbtn: {
        type: 'stdio',
        command: '/usr/bin/node',
        args: ['/tmp/shim.js'],
        env: { REDBTN_BRIDGE_SOCK: '/tmp/s.sock', REDBTN_BRIDGE_NONCE: 'deadbeef' },
      },
    },
  };

  function build(over: Record<string, unknown> = {}) {
    const home = path.join(tmpRoot, `home-${Math.random().toString(36).slice(2, 6)}`);
    buildAgyHome({ home, token: TOKEN, installationId: 'inst-123', mcpConfig, ...over });
    return home;
  }

  it('writes the credential at the path the CLI actually reads', () => {
    const home = build();
    expect(fs.readFileSync(path.join(home, AGY_HOME_PATHS.token), 'utf8')).toBe(TOKEN);
    expect(fs.readFileSync(path.join(home, AGY_HOME_PATHS.installationId), 'utf8')).toBe('inst-123');
  });

  it('writes the MCP config at .gemini/config, not .gemini/antigravity-cli', () => {
    // Both files exist in a real HOME; only the first is loaded. Confirmed by
    // running `agy mcp add` and diffing the tree, and by `agy mcp list`
    // reporting no servers while only the second was written.
    const home = build();
    const loaded = JSON.parse(fs.readFileSync(path.join(home, AGY_HOME_PATHS.mcpConfig), 'utf8'));
    expect(loaded).toEqual(mcpConfig);
    expect(fs.existsSync(path.join(home, '.gemini/antigravity-cli/mcp_config.json'))).toBe(false);
  });

  it('grants exactly the bridge, and denies nothing explicitly', () => {
    // The allow list is the whole policy. `deny` stays EMPTY on purpose: the
    // CLI's headless auto-deny ends a blocked turn in ~3 s, whereas an explicit
    // deny is reported to the model as a refusal it retries against — one
    // measured run burned 165 673 input tokens doing exactly that.
    const home = build();
    const cfg = JSON.parse(fs.readFileSync(path.join(home, AGY_HOME_PATHS.config), 'utf8'));
    expect(cfg.userSettings.globalPermissionGrants).toEqual({
      allow: ['mcp(redbtn/*)'],
      deny: [],
      ask: [],
    });
    expect(bridgeGrant()).toBe('mcp(redbtn/*)');
  });

  it('never grants a command, a file write or a file read', () => {
    const home = build();
    const raw = fs.readFileSync(path.join(home, AGY_HOME_PATHS.config), 'utf8');
    for (const action of ['command(', 'write_file(', 'read_file(', 'read_url(', 'unsandboxed(']) {
      expect(raw).not.toContain(action);
    }
  });

  it('names the subscription auth type in settings.json', () => {
    const home = build();
    const settings = JSON.parse(fs.readFileSync(path.join(home, AGY_HOME_PATHS.settings), 'utf8'));
    expect(settings.security.auth.selectedType).toBe('oauth-personal');
  });

  it('makes every directory 0700 and every file 0600', () => {
    // Not decoration: a 0600 DIRECTORY breaks the CLI outright, because it
    // creates log/, brain/ and conversations/ under it on first run.
    const home = build();
    for (const rel of ['.gemini', '.gemini/antigravity-cli', '.gemini/config']) {
      expect(fs.statSync(path.join(home, rel)).mode & 0o777).toBe(0o700);
    }
    for (const rel of Object.values(AGY_HOME_PATHS)) {
      expect(fs.statSync(path.join(home, rel)).mode & 0o777).toBe(0o600);
    }
  });

  it('omits the installation id when there is none', () => {
    // VERIFIED: the CLI generates one and the run succeeds.
    const home = build({ installationId: undefined });
    expect(fs.existsSync(path.join(home, AGY_HOME_PATHS.installationId))).toBe(false);
  });
});

// =============================================================================
// 4. Model and effort
// =============================================================================

describe('resolveAgyModel', () => {
  it('accepts every model agy lists', () => {
    for (const model of AGY_MODELS.keys()) expect(resolveAgyModel(model)).toBe(model);
  });

  it('knows the models the neuron docs will actually name', () => {
    for (const model of [
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]) {
      expect(AGY_MODELS.has(model)).toBe(true);
    }
  });

  it('refuses a model the CLI cannot run, rather than substituting', () => {
    // Substituting could silently move the step onto Gemini 3.1 Pro, which is
    // the expensive thing this provider exists to stop paying for.
    expect(() => resolveAgyModel('gemini-9-ultra')).toThrow(AgyCliError);
    try {
      resolveAgyModel('gemini-9-ultra');
    } catch (err) {
      expect((err as AgyCliError).code).toBe('agy_bad_model');
    }
  });

  it('refuses a flag-shaped or non-string model', () => {
    for (const bad of ['--model', ' ', 42, {}]) {
      expect(() => resolveAgyModel(bad)).toThrow(AgyCliError);
    }
  });

  it('falls back to the default when the doc carries no model', () => {
    expect(resolveAgyModel(undefined)).toBe(DEFAULT_MODEL);
    expect(resolveAgyModel('')).toBe(DEFAULT_MODEL);
    expect(AGY_MODELS.get(DEFAULT_MODEL)).toBe('required');
  });
});

describe('resolveAgyEffort', () => {
  it('only accepts the three levels agy knows', () => {
    expect([...EFFORT_LEVELS].sort()).toEqual([...AGY_EFFORT_LEVELS].sort());
    for (const level of AGY_EFFORT_LEVELS) {
      expect(resolveAgyEffort({}, { parameters: { effort: level } }, 'required')).toBe(level);
    }
  });

  it('degrades a claude-code level instead of failing the run', () => {
    // `xhigh` and `max` are legal in the shared Mongoose enum, so a neuron
    // re-pointed from claude-code to agy-cli carries one. Passing it through
    // would kill the run at argument-parse time.
    for (const level of ['xhigh', 'max', 'nonsense']) {
      expect(resolveAgyEffort({}, { parameters: { effort: level } }, 'required')).toBe(
        DEFAULT_AGY_EFFORT,
      );
    }
  });

  it('defaults to high when nothing names a level', () => {
    expect(resolveAgyEffort({}, {}, 'required')).toBe('high');
    expect(DEFAULT_AGY_EFFORT).toBe('high');
  });

  it('prefers the node parameter over the neuron document', () => {
    expect(
      resolveAgyEffort({ parameters: { effort: 'low' } }, { parameters: { effort: 'high' } }, 'optional'),
    ).toBe('low');
  });

  it('returns nothing at all for a model that refuses --effort', () => {
    expect(resolveAgyEffort({ parameters: { effort: 'high' } }, {}, 'unsupported')).toBeUndefined();
  });
});

// =============================================================================
// 5. The result envelope
// =============================================================================

describe('parseAgyEnvelope', () => {
  it('parses the ordinary single-object stdout', () => {
    expect(parseAgyEnvelope(`${JSON.stringify(SUCCESS_ENVELOPE)}\n`)).toEqual(SUCCESS_ENVELOPE);
  });

  it('finds the envelope behind a stray banner line', () => {
    // A banner would otherwise turn a completed, paid-for turn into "no result".
    const stdout = `Fetching available models...\n${JSON.stringify(SUCCESS_ENVELOPE)}\n`;
    expect(parseAgyEnvelope(stdout)?.response).toBe('ok-e1\n');
  });

  it('returns null for empty or unparseable stdout', () => {
    expect(parseAgyEnvelope('')).toBeNull();
    expect(parseAgyEnvelope('   \n')).toBeNull();
    expect(parseAgyEnvelope('not json at all')).toBeNull();
  });
});

describe('mapAgyUsage', () => {
  it('adds the cache read back into the input total', () => {
    // agy reports `total_tokens: 5555` for `input 5551 + output 4`, EXCLUDING
    // the 8 130 cache reads. Every other provider in the engine — and the
    // Rater — treats `input_tokens` as the total input including cached reads,
    // so passing agy's number through would under-report every cached turn and
    // make an agy step look cheaper than the identical Gemini API step.
    const usage = mapAgyUsage(SUCCESS_ENVELOPE.usage);
    expect(usage.input_tokens).toBe(5551 + 8130);
    expect(usage.uncached_input_tokens).toBe(5551);
    expect(usage.input_token_details.cache_read).toBe(8130);
    expect(usage.output_tokens).toBe(4);
    expect(usage.total_tokens).toBe(5551 + 8130 + 4);
  });

  it('records thinking tokens without double-counting them', () => {
    // `thinking_tokens` are already inside `output_tokens`.
    const usage = mapAgyUsage(TIMEOUT_ENVELOPE.usage);
    expect(usage.thinking_tokens).toBe(10137);
    expect(usage.output_tokens).toBe(13529);
  });

  it('handles a missing usage block', () => {
    const usage = mapAgyUsage(undefined);
    expect(usage.total_tokens).toBe(0);
    expect(usage.input_token_details).toEqual({ cache_creation: 0, cache_read: 0 });
  });

  it('is readable by the shared cache-usage extractor (one reader, both paths)', () => {
    const cache = extractCacheUsage({ usage_metadata: mapAgyUsage(SUCCESS_ENVELOPE.usage) });
    expect(cache?.cacheReadInputTokens).toBe(8130);
  });
});

// =============================================================================
// 6. Text classifiers
// =============================================================================

describe('stripGlogNoise', () => {
  it('drops the pre-google.Init banner but keeps the real diagnostic', () => {
    expect(stripGlogNoise(`${GLOG_NOISE}real failure here`)).toBe('real failure here');
  });

  it('keeps the banner when it is the ONLY thing there', () => {
    // Better a noisy tail than an empty one when a run really did fail.
    expect(stripGlogNoise(GLOG_NOISE)).toContain('CLI settings initialized');
  });
});

describe('looksLikeRateLimit', () => {
  it('matches the shapes the Gemini backends actually use', () => {
    for (const text of [
      'RESOURCE_EXHAUSTED: quota exceeded for model',
      'QUOTA_EXCEEDED',
      'HTTP 429 Too Many Requests',
      'rate limit reached for this subscription',
      'the model is overloaded, please try again',
      'over capacity',
    ]) {
      expect(looksLikeRateLimit(text)).toBe(true);
    }
  });

  it('does NOT match a content refusal or an ordinary failure', () => {
    for (const text of [
      "I can't help with that request.",
      'timeout waiting for response',
      'invalid model selection',
      'authentication failed or timed out',
    ]) {
      expect(looksLikeRateLimit(text)).toBe(false);
    }
  });
});

describe('looksLikeAuthPrompt', () => {
  it('matches the interactive login on its FIRST line', () => {
    // The whole point: recognising it on line one is what lets the executor
    // kill the child instead of parking a worker slot for the CLI's 60 s
    // interactive window.
    expect(looksLikeAuthPrompt(AUTH_STDERR.split('\n')[0])).toBe(true);
    expect(looksLikeAuthPrompt(AUTH_ENVELOPE.error)).toBe(true);
  });

  it('does NOT match a rate limit or a normal turn', () => {
    expect(looksLikeAuthPrompt('RESOURCE_EXHAUSTED')).toBe(false);
    expect(looksLikeAuthPrompt('ok-e1')).toBe(false);
  });
});

describe('redactToken', () => {
  it('removes the credential from anything bound for a log', () => {
    expect(redactToken(`failed with ${TOKEN}`, TOKEN)).toBe(
      'failed with [REDACTED:AGY_OAUTH_TOKEN]',
    );
  });
});

// =============================================================================
// 7. The persistent token cache
// =============================================================================

describe('the token cache', () => {
  it('prefers a refreshed token over the secret it came from', () => {
    const dir = path.join(tmpRoot, 'state-a');
    writeCachedToken(dir, TOKEN, 'ya29.REFRESHED');
    expect(readCachedToken(dir, TOKEN)).toBe('ya29.REFRESHED');
  });

  it('ignores the cache once the SECRET is rotated', () => {
    // Without the seed check, rotating the secret to a different account would
    // be silently undone by a stale cache on every worker.
    const dir = path.join(tmpRoot, 'state-b');
    writeCachedToken(dir, TOKEN, 'ya29.REFRESHED');
    expect(readCachedToken(dir, 'ya29.A-DIFFERENT-ACCOUNT')).toBe('ya29.A-DIFFERENT-ACCOUNT');
  });

  it('falls back to the secret when there is no cache at all', () => {
    expect(readCachedToken(path.join(tmpRoot, 'nope'), TOKEN)).toBe(TOKEN);
  });

  it('writes the cache 0700/0600', () => {
    const dir = path.join(tmpRoot, 'state-c');
    writeCachedToken(dir, TOKEN, TOKEN);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, 'antigravity-oauth-token')).mode & 0o777).toBe(0o600);
  });

  it('serialises concurrent writers', async () => {
    const dir = path.join(tmpRoot, 'state-d');
    fs.mkdirSync(dir, { recursive: true });
    const order: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        withStateLock(dir, async () => {
          order.push(`${id}:in`);
          await new Promise((r) => setTimeout(r, 10));
          order.push(`${id}:out`);
        }),
      ),
    );
    // Every enter is immediately followed by its own exit: no interleaving.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].split(':')[0]).toBe(order[i + 1].split(':')[0]);
    }
  });

  it('breaks a stale lock rather than deadlocking', async () => {
    // The holder may have been SIGKILLed by an OOM or a deploy. A token cache
    // that can deadlock is worse than one that can race.
    const dir = path.join(tmpRoot, 'state-e');
    fs.mkdirSync(dir, { recursive: true });
    const lock = path.join(dir, '.lock');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(lock, old, old);
    await expect(withStateLock(dir, () => 'through')).resolves.toBe('through');
  });
});

// =============================================================================
// 8. Small helpers
// =============================================================================

describe('helpers', () => {
  it('falls back to a stable placeholder workspace', () => {
    expect(resolveWorkspaceMount({}).tree).toBe('/ws/workspace/tree');
    expect(resolveWorkspaceMount({ data: { ws: { name: 'indy' } } }).tree).toBe('/ws/indy/tree');
  });

  it('confines ws.tree to the mount the validated slug already fixed', () => {
    const escaped = resolveWorkspaceMount({
      data: { ws: { name: 'indy', tree: '/etc/cron.d' } },
    });
    expect(escaped.tree).toBe('/ws/indy/tree');
    const traversal = resolveWorkspaceMount({
      data: { ws: { name: 'indy', tree: '/ws/indy/../../etc' } },
    });
    expect(traversal.tree).toBe('/ws/indy/tree');
  });

  it('reads its knobs from the environment at call time', () => {
    process.env.AGY_CLI_MAX_CONCURRENT = '5';
    expect(maxConcurrent()).toBe(5);
    delete process.env.AGY_CLI_MAX_CONCURRENT;
    expect(maxConcurrent()).toBe(2);
    process.env.AGY_STATE_DIR = '/somewhere/else';
    expect(agyStateDir()).toBe('/somewhere/else');
  });
});

// =============================================================================
// 9. runAgyCliStep — end to end against a fake CLI
// =============================================================================

describe('runAgyCliStep', () => {
  it('runs a turn, returns the text, meters the usage and cleans up', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(SUCCESS_ENVELOPE)});`);
    const { result, usage } = await runStep();

    expect(result['data.out']).toBe('ok-e1\n');
    expect(usage).toHaveLength(1);
    expect(usage[0].hint).toBe('agy-cli/gemini-3.8-flash');
    expect((usage[0].response as Any).usage_metadata.input_tokens).toBe(5551 + 8130);

    const cli = (result['data._cli'] as Any)['data.out'];
    expect(cli.provider).toBe('agy-cli');
    expect(cli.conversationId).toBe(SUCCESS_ENVELOPE.conversation_id);
    // Subscription-backed: nothing to charge.
    expect(cli.totalCostUsdEstimate).toBe(0);

    // Nothing left on disk — the private HOME holds a live OAuth token. The
    // run root itself survives (it is the worker's, not this step's); what must
    // be gone is everything under it.
    expect(fs.readdirSync(process.env.REDBTN_RUN_DIR_ROOT as string)).toEqual([]);
    expect(__agySlotsInUse()).toBe(0);
    expect(__agyLiveChildCount()).toBe(0);
  });

  it('hands the child an allowlisted env, an empty cwd and both prompts', async () => {
    const dump = path.join(tmpRoot, 'dump.json');
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `${dumpLine(dump)} out(${JSON.stringify(SUCCESS_ENVELOPE)});`,
    );
    process.env.MONGODB_URI = 'mongodb://prod/should-not-leak';
    process.env.GEMINI_API_KEY = 'AIza-SHOULD-NOT-LEAK';
    try {
      await runStep();
    } finally {
      delete process.env.MONGODB_URI;
      delete process.env.GEMINI_API_KEY;
    }

    const seen = JSON.parse(fs.readFileSync(dump, 'utf8'));
    expect(seen.env.MONGODB_URI).toBeUndefined();
    expect(seen.env.GEMINI_API_KEY).toBeUndefined();
    expect(JSON.stringify(seen.env)).not.toContain(TOKEN);

    // The prompt is ONE argv value: this CLI has no --system-prompt flag and
    // does not read stdin, so the system prompt is delimited inside it.
    const prompt = seen.argv[seen.argv.indexOf('-p') + 1];
    expect(prompt).toContain('=== SYSTEM INSTRUCTIONS ===');
    expect(prompt).toContain('NODE PREFIX');
    expect(prompt).toContain('be terse');
    expect(prompt).toContain('call_mcp_tool');
    expect(prompt).toContain('say ok');

    // The cwd is empty: this CLI auto-discovers GEMINI.md / AGENTS.md /
    // .agents/rules from it, so anything in there becomes instructions.
    expect(seen.cwdEntries).toEqual([]);

    // The credential reaches the child as a FILE inside its private HOME, and
    // the only permission grant it finds there is the bridge.
    expect(seen.homeToken).toBe(TOKEN);
    expect(JSON.parse(seen.grants).userSettings.globalPermissionGrants).toEqual({
      allow: ['mcp(redbtn/*)'],
      deny: [],
      ask: [],
    });
  });

  it('classifies a capped subscription as agy_rate_limited', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `out(${JSON.stringify({
        ...AUTH_ENVELOPE,
        error: 'RESOURCE_EXHAUSTED: quota exceeded for gemini-3.8-flash',
      })});`,
    );
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_rate_limited' });
  });

  it('classifies a dead credential as agy_auth_required, from the ENVELOPE', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(AUTH_ENVELOPE)});`);
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_auth_required' });
  });

  it('kills the child the moment it asks for an interactive login', async () => {
    // The real CLI blocks for 60 s waiting for a human to paste a code. The
    // executor must not hold a worker slot for that, so it matches the prompt
    // on stderr AS IT ARRIVES rather than waiting for the envelope.
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `err(${JSON.stringify(AUTH_STDERR)});\nsetTimeout(() => { out(${JSON.stringify(AUTH_ENVELOPE)}); }, 60000);`,
    );
    const started = Date.now();
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_auth_required' });
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it("maps the CLI's own print timeout to agy_timeout", async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(TIMEOUT_ENVELOPE)});`);
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_timeout' });
  });

  it('kills the child on the wall clock and reports agy_timeout', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy('setTimeout(() => {}, 60000);');
    await expect(runStep({ timeoutMs: 1500 })).rejects.toMatchObject({ code: 'agy_timeout' });
    expect(__agyLiveChildCount()).toBe(0);
  });

  it('fails the step when the policy blocked the turn, instead of returning ""', async () => {
    // The security case. `status` is SUCCESS and `response` is empty, so a naive
    // reading writes '' into graph state and the run carries on as though the
    // step worked — which is exactly how a denied tool call becomes invisible.
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(DENIED_ENVELOPE)});`);
    const err = await runStep().catch((e) => e);
    expect(err.code).toBe('agy_tool_denied');
    expect(err.message).toContain('RunCommand');
  });

  it('audits every denial onto the run record, even when the turn answered', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `out(${JSON.stringify({ ...DENIED_ENVELOPE, response: 'I could not run that.' })});`,
    );
    const { result, publisher } = await runStep();
    expect(result['data.out']).toBe('I could not run that.');
    expect(publisher.events).toEqual([
      { kind: 'toolStart', name: 'RunCommand' },
      { kind: 'toolError' },
    ]);
    expect((result['data._cli'] as Any)['data.out'].permissionDenials).toBe(1);
  });

  it('reports agy_spawn_failed when the binary is not there', async () => {
    process.env.AGY_CLI_BIN = path.join(tmpRoot, 'no-such-agy');
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_spawn_failed' });
  });

  it('reports agy_failed when the CLI writes no envelope at all', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`err("boom\\n"); process.exit(3);`);
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_failed' });
  });

  it('strips the glog banner from a failure message but keeps the diagnostic', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `err(${JSON.stringify(`${GLOG_NOISE}the real problem\n`)}); process.exit(1);`,
    );
    const err = await runStep().catch((e) => e);
    expect(err.message).toContain('the real problem');
    expect(err.message).not.toContain('logging before google.Init');
  });

  it('returns structured output as a PARSED object, from structured_output', async () => {
    // Every other provider hands the graph an object, so `{{state.data.out.name}}`
    // must resolve here too. `structured_output` is preferred over the response
    // text because the text has been observed carrying the CLI's own
    // toolAction/toolSummary keys alongside the schema's.
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `out(${JSON.stringify({
        ...SUCCESS_ENVELOPE,
        response: '{"age":36,"name":"Ada","toolAction":"Finishing task"}\n',
        structured_output: { age: 36, name: 'Ada' },
      })});`,
    );
    const { result } = await runStep({
      structuredOutput: { schema: { type: 'object', properties: { name: { type: 'string' } } } },
    });
    expect(result['data.out']).toEqual({ age: 36, name: 'Ada' });
  });

  it('refuses a prompt that cannot fit in argv, before a turn is spent', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(SUCCESS_ENVELOPE)});`);
    await expect(
      runStep({ userPrompt: 'x'.repeat(MAX_PROMPT_ARG_BYTES + 1) }),
    ).rejects.toMatchObject({ code: 'agy_prompt_too_large' });
  });

  it('refuses to run with no credential anywhere', async () => {
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(SUCCESS_ENVELOPE)});`);
    const runId = 'run_notoken';
    await expect(
      runAgyCliStep({
        config: stepConfig(),
        state: baseState(runId),
        neuronCfg: { ...NEURON_CFG, apiKey: undefined },
        neuronId: 'agy-flash-3-8',
        userId: 'user_test',
        callRunId: runId,
        abortSignal: undefined,
        emitUsage: () => {},
      }),
    ).rejects.toMatchObject({ code: 'agy_no_token' });
  });

  it('accepts AGY_OAUTH_TOKEN as the worker-level fallback credential', async () => {
    process.env.AGY_OAUTH_TOKEN = 'ya29.FROM-THE-WORKER-ENV';
    process.env.AGY_CLI_BIN = writeFakeAgy(`out(${JSON.stringify(SUCCESS_ENVELOPE)});`);
    const runId = 'run_envtoken';
    const result = await runAgyCliStep({
      config: stepConfig(),
      state: baseState(runId),
      neuronCfg: { ...NEURON_CFG, apiKey: undefined },
      neuronId: 'agy-flash-3-8',
      userId: 'user_test',
      callRunId: runId,
      abortSignal: undefined,
      emitUsage: () => {},
    });
    expect(result['data.out']).toBe('ok-e1\n');
  });

  it('caches a token the CLI refreshed, so the next run starts from it', async () => {
    // The CLI rewrites the token file in place when it refreshes. A purely
    // per-run HOME would throw that away and eventually strand the platform on
    // an expired credential.
    const tokenPath = AGY_HOME_PATHS.token;
    process.env.AGY_CLI_BIN = writeFakeAgy(
      'const home = process.env.HOME;\n' +
        `fs.writeFileSync(require("path").join(home, ${JSON.stringify(tokenPath)}), "ya29.REFRESHED-BY-THE-CLI");\n` +
        `out(${JSON.stringify(SUCCESS_ENVELOPE)});`,
    );
    await runStep();
    expect(readCachedToken(process.env.AGY_STATE_DIR as string, TOKEN)).toBe(
      'ya29.REFRESHED-BY-THE-CLI',
    );
  });

  it('caches a refresh even when the turn itself failed', async () => {
    // A run that failed may still have refreshed the credential on its way in;
    // discarding it would make the next run fail the same way.
    process.env.AGY_CLI_BIN = writeFakeAgy(
      'const home = process.env.HOME;\n' +
        `fs.writeFileSync(require("path").join(home, ${JSON.stringify(AGY_HOME_PATHS.token)}), "ya29.REFRESHED-THEN-FAILED");\n` +
        `out(${JSON.stringify({ ...AUTH_ENVELOPE, error: 'RESOURCE_EXHAUSTED' })});`,
    );
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_rate_limited' });
    expect(readCachedToken(process.env.AGY_STATE_DIR as string, TOKEN)).toBe(
      'ya29.REFRESHED-THEN-FAILED',
    );
  });

  it('queues past the concurrency limit and fails with agy_queue_timeout', async () => {
    process.env.AGY_CLI_MAX_CONCURRENT = '1';
    process.env.AGY_CLI_QUEUE_WAIT_MS = '250';
    process.env.AGY_CLI_BIN = writeFakeAgy(
      `setTimeout(() => { out(${JSON.stringify(SUCCESS_ENVELOPE)}); }, 3000);`,
    );
    const first = runStep();
    // Let the first step take the only slot before the second asks for one.
    await new Promise((r) => setTimeout(r, 200));
    await expect(runStep()).rejects.toMatchObject({ code: 'agy_queue_timeout' });
    await first;
    expect(__agySlotsInUse()).toBe(0);
  });
});
