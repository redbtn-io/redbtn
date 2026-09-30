/**
 * `opencode` neuron executor — an OpenCode CLI child, not a chat model.
 *
 * # What this is
 *
 * The third sibling of `claudeCodeExecutor` and `agyCliExecutor`. A neuron
 * whose `provider` is `opencode` is an `opencode run` process spawned as a
 * child of THIS neuron step. OpenCode runs its own agent loop against whatever
 * model the neuron names (`provider/model`, e.g. a free OpenCode Zen model such
 * as `opencode/muse-spark-1.3-contributor-free`, or `openrouter/...`). The only
 * tools the model can use are the run's own tools, served over the per-run
 * Unix-socket MCP bridge (`lib/mcp/run-bridge.ts`) under the run's capability
 * profile — the same bridge, unmodified, that `claude-code` and `agy-cli` use.
 *
 * This replaces an earlier cut that ran `opencode run --auto` in the worker's
 * real `HOME`: the user's global OpenCode config (its MCP servers, its
 * allow-all permissions) and every built-in tool (shell, edit, read, web) were
 * live and AUTO-APPROVED, and none of the node's redbtn tools were offered.
 *
 * # How OpenCode differs (VERIFIED against opencode 2.0.18, 2026-09-29)
 *
 *   | concern         | `opencode run`                                        |
 *   |-----------------|-------------------------------------------------------|
 *   | config          | `$XDG_CONFIG_HOME/opencode/opencode.json` (private)    |
 *   | MCP             | `mcp.servers.<name>` `{type:"local", command:[…]}`     |
 *   | tool names      | `<server>_<tool>` with `codemode: false`               |
 *   | tool gate       | `permissions: [{action, resource, effect}]` list       |
 *   | system prompt   | NO FLAG — delimited inside the one user turn           |
 *   | prompt input    | stdin                                                  |
 *   | output          | `--format json`: NDJSON `step_start` / `text` /        |
 *   |                 | `tool_use` / `step_finish` / `error`, no result event  |
 *   | credential      | env var per provider, or none (free Zen models)        |
 *
 * # The security contract
 *
 * 1. **Private everything.** `HOME` and every `XDG_*` directory live inside the
 *    step's 0700 directory, so the user's global config, plugins, skills,
 *    stored credentials and session database are invisible to the child.
 *    `OPENCODE_DISABLE_PROJECT_CONFIG=1` and an empty placeholder cwd stop a
 *    project `opencode.json` / `AGENTS.md` from becoming instructions.
 *    The executor starts a PRIVATE `opencode serve` (loopback, random port,
 *    random password) under that HOME and runs the turn against it with
 *    `run --server`, so the child never attaches to the user's shared
 *    background service (which runs with the user's config). The server is
 *    warmed until the bridge reports `connected` first; see
 *    `buildOpencodeServeArgs` for why.
 *
 * 2. **Deny by default, and the denial is a tool ERROR, not an interrupt.**
 *    The permission list starts with `{action:"*", effect:"deny"}` and then
 *    allows exactly the bridge (`redbtn.*` makes the tools visible,
 *    `redbtn_*` lets them execute). VERIFIED: a denied built-in call comes
 *    back to the model as `Permission denied: shell` and nothing runs; the
 *    model carries on with the bridge tools. (`ask` is NOT used: headless it
 *    auto-rejects AND interrupts the whole step.)
 *
 * 3. **The two sentinel grants.** OpenCode's free Zen tier refuses any request
 *    whose tool list lacks the built-in `read` and `shell` tools (403 "free
 *    tier can only be used from within OpenCode"; VERIFIED by denying each
 *    built-in in turn — only those two trip it). A tool whose action is denied
 *    for EVERY resource is removed from the list, so each gets one allow rule
 *    for a resource that cannot exist. The tools stay listed; every real call
 *    is still denied (VERIFIED: `echo hi > file` never ran, `/etc/hosts` was
 *    refused).
 *
 * 4. **Child env is an allowlist**, built from nothing: none of the worker's
 *    `MONGODB_URI` / `REDIS_URL` / `INTERNAL_SERVICE_KEY` reach the child. The
 *    only credential it can get is the one provider key the neuron's model
 *    needs, from the neuron's secret (or the host's own OpenCode login, see
 *    below), under that provider's env var name.
 *
 * 5. **`--auto` is never passed.** `buildOpencodeSpawnArgs` is pure so a unit
 *    test asserts its absence.
 *
 * 6. **Nothing is left on disk.** The step directory (private HOME, config with
 *    the bridge nonce, session DB) is removed in `finally`.
 *
 * # Credentials
 *
 *   - Free OpenCode Zen models (`opencode/*-free`, `opencode/big-pickle`) need
 *     none.
 *   - Otherwise the neuron's `secretName` resolves to `apiKey` (the ordinary
 *     redsecrets path) and is exported as the model provider's env var
 *     (`openrouter/...` → `OPENROUTER_API_KEY`, …).
 *   - A secret whose value is the sentinel `keychain` / `host` means "use this
 *     machine's own `opencode auth` login": the key for the model's provider is
 *     read (read-only) from the host's OpenCode database at spawn time and
 *     passed the same way. Nothing is copied into the platform DB. Only
 *     API-key credentials can be reused this way; OAuth logins cannot.
 *
 * @module lib/nodes/universal/executors/opencodeExecutor
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as net from 'net';

import type { NeuronStepConfig } from '../types';
import { renderTemplate, getNestedProperty } from '../templateRenderer';
import { resolveTools, partitionToolRefs } from '../../../tools/tool-resolver';
import {
  startRunToolBridge,
  isForbiddenForBridge,
  BRIDGE_SERVER_NAME,
  type RunToolBridge,
  type RunBridgeToolRef,
  type RunBridgePublisher,
} from '../../../mcp/run-bridge';
import { getRunPublisher } from '../../../run/contextLookup';
import { runControlRegistry } from '../../../run/RunControlRegistry';
import { sanitizeSegment, runDirRoot } from './claudeCodeExecutor';
import { createCliSlotQueue, slotWaitReporter, logSlotAdmission } from './cli-slot';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// =============================================================================
// Constants
// =============================================================================

/** Wall-clock ceiling for one CLI child when the step does not set one. */
export const DEFAULT_TIMEOUT_MS = 1_800_000;

/** Grace between SIGTERM and SIGKILL. */
export const SIGKILL_GRACE_MS = 5_000;

/** How often the executor re-reads the run record while the child runs. */
export const RUN_POLL_INTERVAL_MS = 60_000;

/** Sanity bound on the prompt (it goes over stdin, so this is not an argv cap). */
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

/** Cap on stdout, so a wedged child cannot OOM the worker. */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/** Bytes of stderr kept for the error message on a failure. */
export const STDERR_TAIL_BYTES = 4096;

/** Default model: a free OpenCode Zen model. */
export const DEFAULT_MODEL = 'opencode/big-pickle';

/**
 * Resources for the two sentinel grants (see §3 of the module comment). They
 * must never match a real path or command: the grant exists only so the tool
 * stays in the list the free Zen tier inspects.
 */
export const SENTINEL_READ_RESOURCE = '/nonexistent/redbtn-opencode-sentinel';
export const SENTINEL_SHELL_RESOURCE = 'redbtn-opencode-sentinel-never-a-command';

/** Secret values that mean "use this machine's own opencode login". */
export const HOST_LOGIN_SENTINELS: ReadonlySet<string> = new Set(['keychain', 'host', 'local']);

/**
 * Model-provider prefix → the env var OpenCode reads that provider's key from.
 * VERIFIED for `openrouter`; the rest follow the models.dev env names OpenCode
 * uses. A provider not listed here gets no key (and fails loudly if it needs one).
 */
export const PROVIDER_ENV_KEYS: Readonly<Record<string, string>> = {
  opencode: 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  xai: 'XAI_API_KEY',
  togetherai: 'TOGETHER_AI_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  zai: 'ZHIPU_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
};

/**
 * Fixed preamble. OpenCode names MCP tools `<server>_<tool>` when the server
 * has `codemode: false`, so the model sees `redbtn_read_file`, `redbtn_run_command`, …
 */
export const BRIDGE_PREAMBLE =
  `Your ONLY working tools are the '${BRIDGE_SERVER_NAME}_*' tools (for example ` +
  `${BRIDGE_SERVER_NAME}_read_file, ${BRIDGE_SERVER_NAME}_run_command); they act on the user's ` +
  `machine, in %TREE%. Every built-in tool you appear to have (shell/bash, read, edit, write, ` +
  'glob, grep, web fetch/search, task, todo) is denied by policy and fails without running: never ' +
  `call them. Use ${BRIDGE_SERVER_NAME}_run_command for shell commands and the ` +
  `${BRIDGE_SERVER_NAME}_* file tools for files.`;

/** Statuses after which a run will never make progress again. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'error', 'interrupted']);

// =============================================================================
// Errors
// =============================================================================

/**
 * A step failure with a stable machine-readable `code`. Whether
 * `neuronFallback` hops to `fallbackNeuronId` is decided by
 * `OPENCODE_FALLBACK_CODES` there:
 *
 *   - `opencode_spawn_failed`     — the CLI is not installed here.       hop.
 *   - `opencode_rate_limited`     — provider 429 / quota.                hop.
 *   - `opencode_queue_timeout`    — never got a CLI slot.                hop.
 *   - `opencode_timeout`          — wall clock.                          hop.
 *   - `opencode_failed`           — exited without a usable answer.      hop.
 *   - `opencode_error_result`     — the CLI reported a provider error.   hop.
 *   - `opencode_auth_failed`      — the provider rejected / lacks a key. NO hop.
 *   - `opencode_free_tier_refused`— Zen's free-tier gate refused the
 *                                   request (tool policy tripped it).   NO hop.
 *   - `opencode_no_host_login`    — `keychain` sentinel, but this host
 *                                   has no opencode key for the model.   NO hop.
 *   - `opencode_tool_denied`      — the turn produced nothing but denied
 *                                   built-in tool calls. Security event. NO hop.
 *   - `opencode_prompt_too_large`, `opencode_bad_structured_output`     NO hop.
 */
export class OpencodeCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpencodeCliError';
    this.code = code;
  }
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// =============================================================================
// Worker-wide concurrency
// =============================================================================

export function maxConcurrent(): number {
  const raw = Number.parseInt(process.env.OPENCODE_CLI_MAX_CONCURRENT || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

export function queueWaitMs(timeoutMs: number): number {
  const raw = Number.parseInt(process.env.OPENCODE_CLI_QUEUE_WAIT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : timeoutMs;
}

const slots = createCliSlotQueue({
  provider: 'opencode',
  maxConcurrent,
  queueTimeoutError: (maxWaitMs, max) =>
    new OpencodeCliError(
      'opencode_queue_timeout',
      `waited ${maxWaitMs} ms for one of ${max} opencode slot(s) on this worker and never ` +
        `got one; raise OPENCODE_CLI_MAX_CONCURRENT or add workers`,
    ),
});

/** Test-only: current occupancy of the worker-wide semaphore. */
export function __opencodeSlotsInUse(): number {
  return slots.inUse();
}

// Children are detached (their own process group, so the whole tree — the CLI,
// its private server, the bridge shim — can be signalled). That also means the
// worker's death does not take them with it, so they are tracked and killed on
// the way out.
const livePgids = new Set<number>();
let exitHooksInstalled = false;

function killAllLiveChildren(signal: NodeJS.Signals): void {
  for (const pgid of livePgids) {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* already gone */
    }
  }
  livePgids.clear();
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  process.on('exit', () => killAllLiveChildren('SIGKILL'));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // A host that owns shutdown (redworker's SIGTERM drain) registered its own
      // listener: let it drain in-flight runs. Killing the CLI children here and
      // removing every listener (as this hook used to) SIGTERMed live runs
      // (exit 143) and deleted the host's drain handler on every worker deploy.
      // The `exit` hook still SIGKILLs any survivor once the host exits.
      if (process.listenerCount(signal) > 1) return;
      killAllLiveChildren('SIGTERM');
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/** Test-only: pgids currently registered as live. */
export function __opencodeLiveChildCount(): number {
  return livePgids.size;
}

// =============================================================================
// Model, binary, credentials
// =============================================================================

/** Resolve the canonical `provider/model` id. */
export function resolveOpencodeModel(model?: string): string {
  if (!model || model.trim() === '') return DEFAULT_MODEL;
  const trimmed = model.trim();
  if (
    trimmed === 'muse-spark-1.3' ||
    trimmed === 'muse-spark' ||
    trimmed === 'muse' ||
    trimmed === 'opencode/muse-spark-1.3' ||
    trimmed === 'opencode/muse-spark'
  ) {
    return 'opencode/muse-spark-1.3-contributor-free';
  }
  if (/[\s\0]/.test(trimmed) || trimmed.startsWith('-')) {
    throw new OpencodeCliError('opencode_bad_model', `neuron model ${JSON.stringify(model)} is not a model id`);
  }
  return trimmed.includes('/') ? trimmed : `opencode/${trimmed}`;
}

/** The model's provider prefix (`openrouter/cohere/x` → `openrouter`). */
export function modelProvider(model: string): string {
  const idx = model.indexOf('/');
  return idx > 0 ? model.slice(0, idx) : 'opencode';
}

/** Find the opencode binary. `OPENCODE_CLI_BIN` / `OPENCODE_BIN_PATH` win. */
export function resolveOpencodeBinary(): string {
  for (const envName of ['OPENCODE_CLI_BIN', 'OPENCODE_BIN_PATH']) {
    const value = process.env[envName];
    if (value && fs.existsSync(value)) return value;
  }
  const candidates = [
    path.join(os.homedir(), '.opencode/bin/opencode'),
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
    '/opt/homebrew/bin/opencode',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'opencode';
}

/** Where the host's own OpenCode login lives (read-only). */
export function hostOpencodeDbPath(): string {
  if (process.env.OPENCODE_HOST_DB) return process.env.OPENCODE_HOST_DB;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share');
  return path.join(dataHome, 'opencode', 'opencode.db');
}

/**
 * Read the host's stored API key for `provider` from OpenCode's own database.
 *
 * Read-only, never cached, never logged. Returns '' when there is no usable
 * API-key credential (none stored, an OAuth login, no `node:sqlite`).
 */
export function readHostOpencodeKey(provider: string, dbPath = hostOpencodeDbPath()): string {
  if (!fs.existsSync(dbPath)) return '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          'select value from credential where integration_id = ? and active = 1 ' +
            'order by time_updated desc limit 1',
        )
        .get(provider) as { value?: string } | undefined;
      if (!row?.value) return '';
      const parsed = JSON.parse(row.value);
      return parsed?.type === 'key' && typeof parsed.key === 'string' ? parsed.key : '';
    } finally {
      db.close();
    }
  } catch (err) {
    console.warn(`[Opencode] could not read the host opencode login: ${(err as Error)?.message}`);
    return '';
  }
}

/**
 * Resolve the provider key the child gets, as `{ envName, value }` or null.
 *
 * - no secret: null (free Zen models need none);
 * - a host-login sentinel: the host's own opencode key for the model's provider;
 * - anything else: the secret itself, under the provider's env var.
 */
export function resolveProviderCredential(
  model: string,
  secret: string | undefined,
  readHostKey: (provider: string) => string = readHostOpencodeKey,
): { envName: string; value: string } | null {
  const provider = modelProvider(model);
  const envName = PROVIDER_ENV_KEYS[provider];
  if (!secret) return null;
  if (HOST_LOGIN_SENTINELS.has(secret.trim().toLowerCase())) {
    // A free Zen model needs no key, so a sentinel on such a neuron is not an
    // error — it just resolves to nothing.
    const value = envName ? readHostKey(provider) : '';
    if (!value) {
      if (provider === 'opencode') return null;
      throw new OpencodeCliError(
        'opencode_no_host_login',
        `the neuron's secret is the host-login sentinel, but this machine has no opencode API ` +
          `key for provider '${provider}' (run \`opencode auth login\` for it, or store the key ` +
          `itself as the neuron's secret)`,
      );
    }
    return { envName, value };
  }
  if (!envName) {
    console.warn(
      `[Opencode] neuron has a secret but provider '${provider}' has no known key env var; ` +
        `the secret is not passed`,
    );
    return null;
  }
  return { envName, value: secret };
}

// =============================================================================
// Private HOME, config, env, argv
// =============================================================================

/** The OpenCode config written into the child's private config dir. */
export function buildOpencodeConfig(mcpConfig: Record<string, unknown>): Record<string, unknown> {
  const servers = (mcpConfig as AnyObject)?.mcpServers ?? {};
  const bridge = servers[BRIDGE_SERVER_NAME] ?? {};
  const command = [bridge.command, ...(Array.isArray(bridge.args) ? bridge.args : [])].filter(
    (part) => typeof part === 'string' && part,
  );
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      servers: {
        [BRIDGE_SERVER_NAME]: {
          type: 'local',
          // Direct tools (`redbtn_read_file`), not Code Mode's `execute`
          // indirection: weaker models call direct tools far more reliably.
          codemode: false,
          command,
          environment: { ...(bridge.env ?? {}) },
        },
      },
    },
    permissions: buildOpencodePermissions(),
  };
}

/** The permission list. Order matters: later rules win. See §2/§3. */
export function buildOpencodePermissions(): Array<{ action: string; resource: string; effect: string }> {
  return [
    { action: '*', resource: '*', effect: 'deny' },
    { action: 'read', resource: SENTINEL_READ_RESOURCE, effect: 'allow' },
    { action: 'shell', resource: SENTINEL_SHELL_RESOURCE, effect: 'allow' },
    // Tool VISIBILITY is decided on the tool key (`redbtn.read_file`);
    // EXECUTION asserts the action `redbtn_read_file`. Both are needed.
    { action: `${BRIDGE_SERVER_NAME}.*`, resource: '*', effect: 'allow' },
    { action: `${BRIDGE_SERVER_NAME}_*`, resource: '*', effect: 'allow' },
  ];
}

/** Create the private HOME and write the config (0700 dirs, 0600 file). */
export function buildOpencodeHome(home: string, config: Record<string, unknown>): void {
  for (const rel of ['.config/opencode', '.local/share', '.local/state', '.cache']) {
    fs.mkdirSync(path.join(home, rel), { recursive: true, mode: 0o700 });
  }
  for (const rel of ['', '.config', '.config/opencode', '.local', '.local/share', '.local/state', '.cache']) {
    fs.chmodSync(path.join(home, rel), 0o700);
  }
  const file = path.join(home, '.config/opencode/opencode.json');
  fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** The child's ENTIRE environment. An allowlist, built from nothing. */
export function buildOpencodeChildEnv(params: {
  home: string;
  dir: string;
  credential?: { envName: string; value: string } | null;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = params.parentEnv ?? process.env;
  const env: NodeJS.ProcessEnv = {
    PATH: parent.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: params.home,
    TMPDIR: params.dir,
    XDG_CONFIG_HOME: path.join(params.home, '.config'),
    XDG_DATA_HOME: path.join(params.home, '.local/share'),
    XDG_STATE_HOME: path.join(params.home, '.local/state'),
    XDG_CACHE_HOME: path.join(params.home, '.cache'),
    LANG: parent.LANG || 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_FILEWATCHER: '1',
  };
  if (params.credential?.envName && params.credential.value) {
    env[params.credential.envName] = params.credential.value;
  }
  return env;
}

/**
 * The exact argv. Pure, so the security-relevant shape is unit-tested.
 * Deliberately absent: `--auto` (auto-approves every permission not explicitly
 * denied). The prompt is not here either: it goes over stdin.
 */
export function buildOpencodeSpawnArgs(input: { model: string; serverUrl: string; sessionId?: string }): string[] {
  const args = ['run', '--server', input.serverUrl, '--format', 'json', '--model', input.model];
  if (input.sessionId) args.push('--session', input.sessionId);
  return args;
}

/**
 * argv for the step's PRIVATE server. Loopback only; the password (random per
 * step) arrives as `OPENCODE_SERVER_PASSWORD` in both children's env.
 *
 * Why a separate server instead of `run --standalone`: VERIFIED (opencode
 * 2.0.18) that a standalone run sends its first model request while the MCP
 * servers are still connecting, so the first step often has NO redbtn tools
 * ("I have no redbtn_now tool") and they only appear from the second step on.
 * The CLI reads the whole prompt before it starts its server, so the executor
 * cannot hold the prompt back until the tools are up. Starting `serve` first,
 * waiting until `/api/mcp` reports the bridge `connected`, and only then
 * running the turn against it with `--server` makes the tools present from
 * the first request.
 */
export function buildOpencodeServeArgs(port: number): string[] {
  return ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
}

/** A free loopback TCP port. */
export async function pickFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

/** How long the private server may take to come up with the bridge connected. */
export function mcpReadyTimeoutMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_MCP_READY_TIMEOUT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 45_000;
}

/**
 * Grace after the bridge reports `connected`, before the turn starts.
 *
 * VERIFIED (opencode 2.0.18): `/api/mcp` flips to `connected` slightly BEFORE
 * the server's tool catalog includes the bridge's tools. Starting the turn the
 * moment it flips gave the model no redbtn tools in 2 of 3 runs; a 1 s grace
 * was 5/5 and 3 s 4/4. There is no catalog endpoint to poll instead.
 */
export function mcpSettleMs(): number {
  const raw = Number.parseInt(process.env.OPENCODE_MCP_SETTLE_MS || '', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

/**
 * Poll the private server until the bridge MCP server is `connected`.
 * Resolves on connected; rejects on `failed`/`needs_auth`, on the server
 * exiting, or at the deadline.
 */
export async function waitForBridgeConnected(params: {
  url: string;
  password: string;
  deadlineMs: number;
  exited: () => boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const auth = `Basic ${Buffer.from(`opencode:${params.password}`).toString('base64')}`;
  const deadline = Date.now() + params.deadlineMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    if (params.signal?.aborted) throw abortError('aborted while the opencode server was starting');
    if (params.exited()) throw new OpencodeCliError('opencode_failed', `the opencode server exited while starting (${last})`);
    try {
      const res = await fetch(`${params.url}/api/mcp`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const body = (await res.json()) as AnyObject;
        const entry = Array.isArray(body?.data)
          ? body.data.find((d: AnyObject) => d?.name === BRIDGE_SERVER_NAME)
          : undefined;
        const status = entry?.status?.status;
        if (status === 'connected') return;
        if (status === 'failed' || status === 'needs_auth') {
          throw new OpencodeCliError(
            'opencode_failed',
            `opencode could not connect the ${BRIDGE_SERVER_NAME} bridge: ${JSON.stringify(entry.status).slice(0, 300)}`,
          );
        }
        last = status ? `bridge ${status}` : 'bridge not listed yet';
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (err) {
      if (err instanceof OpencodeCliError || (err as Error)?.name === 'AbortError') throw err;
      last = (err as Error)?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new OpencodeCliError(
    'opencode_failed',
    `the opencode server did not connect the ${BRIDGE_SERVER_NAME} bridge within ${params.deadlineMs} ms (${last})`,
  );
}

// =============================================================================
// The NDJSON stream
// =============================================================================

export interface OpencodeUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  uncached_input_tokens: number;
  reasoning_tokens: number;
  input_token_details: { cache_creation: number; cache_read: number };
}

/**
 * Aggregated state of one `opencode run --format json` stream.
 *
 * `step_finish.part.tokens` reports `input` EXCLUSIVE of cache reads/writes
 * (VERIFIED: a cached second step reports `input: 1085, cache.read: 3057`), and
 * `reasoning` separately from `output`. The mapping adds them back so the usage
 * matches every other provider's "input includes cached reads" convention.
 */
export interface OpencodeStreamState {
  sessionId: string | null;
  /** Every text part, in order (what the user saw streamed). */
  texts: string[];
  /** Text parts since the last `step_start` — the final message. */
  lastStepTexts: string[];
  steps: number;
  toolCalls: number;
  bridgeToolCalls: number;
  denials: Array<{ tool: string; error: string }>;
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost: number;
  error: { type?: string; message?: string; status?: number } | null;
}

export function createOpencodeStreamState(): OpencodeStreamState {
  return {
    sessionId: null,
    texts: [],
    lastStepTexts: [],
    steps: 0,
    toolCalls: 0,
    bridgeToolCalls: 0,
    denials: [],
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    error: null,
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Fold one stdout line into the state. Returns the text of a `text` event (so
 * the caller can stream it), else null. Never throws on a malformed line.
 */
export function handleOpencodeLine(state: OpencodeStreamState, line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let event: AnyObject;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!event || typeof event !== 'object') return null;
  if (typeof event.sessionID === 'string' && !state.sessionId) state.sessionId = event.sessionID;
  const part: AnyObject = event.part && typeof event.part === 'object' ? event.part : {};
  switch (event.type) {
    case 'step_start':
      state.steps += 1;
      state.lastStepTexts = [];
      return null;
    case 'text': {
      const text = typeof part.text === 'string' ? part.text : typeof event.text === 'string' ? event.text : '';
      if (!text) return null;
      state.texts.push(text);
      state.lastStepTexts.push(text);
      return text;
    }
    case 'tool_use': {
      state.toolCalls += 1;
      const tool = typeof part.tool === 'string' ? part.tool : 'unknown';
      if (tool.startsWith(`${BRIDGE_SERVER_NAME}_`)) state.bridgeToolCalls += 1;
      const st = part.state && typeof part.state === 'object' ? part.state : {};
      const error = typeof st.error === 'string' ? st.error : '';
      if (st.status === 'error' && /permission denied|permission\.rejected|declined/i.test(error)) {
        state.denials.push({ tool: tool.slice(0, 64), error: error.slice(0, 200) });
      }
      return null;
    }
    case 'step_finish': {
      const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : {};
      state.tokens.input += num(tokens.input);
      state.tokens.output += num(tokens.output);
      state.tokens.reasoning += num(tokens.reasoning);
      state.tokens.cacheRead += num(tokens.cache?.read);
      state.tokens.cacheWrite += num(tokens.cache?.write);
      state.cost += num(part.cost);
      return null;
    }
    case 'error': {
      const err = event.error && typeof event.error === 'object' ? event.error : {};
      state.error = {
        type: typeof err.type === 'string' ? err.type : undefined,
        message:
          typeof err.message === 'string'
            ? err.message
            : typeof err.data?.message === 'string'
              ? err.data.message
              : JSON.stringify(err).slice(0, 500),
        status: typeof err.status === 'number' ? err.status : undefined,
      };
      return null;
    }
    default:
      return null;
  }
}

export function mapOpencodeUsage(state: OpencodeStreamState): OpencodeUsage {
  const { input, output, reasoning, cacheRead, cacheWrite } = state.tokens;
  const totalInput = input + cacheRead + cacheWrite;
  const totalOutput = output + reasoning;
  return {
    input_tokens: totalInput,
    output_tokens: totalOutput,
    total_tokens: totalInput + totalOutput,
    uncached_input_tokens: input,
    reasoning_tokens: reasoning,
    input_token_details: { cache_creation: cacheWrite, cache_read: cacheRead },
  };
}

/** Join streamed text parts the way they were published. */
export function joinTextParts(parts: string[]): string {
  let out = '';
  for (const part of parts) {
    if (out && !out.endsWith('\n')) out += '\n\n';
    out += part;
  }
  return out;
}

export function looksLikeRateLimit(text: string): boolean {
  if (!text) return false;
  return (
    /\b429\b/.test(text) ||
    /rate[ _-]?limit/i.test(text) ||
    /too many requests/i.test(text) ||
    /quota[_ ]?(exceeded|exhausted)/i.test(text) ||
    /resource[_ ]?exhausted/i.test(text) ||
    /\boverloaded\b/i.test(text)
  );
}

/** Classify the CLI's own `error` event (never the model's prose). */
export function classifyOpencodeError(err: { type?: string; message?: string; status?: number }): OpencodeCliError {
  const message = err.message || err.type || 'unknown error';
  const detail = `${err.type ? `${err.type}: ` : ''}${message}`;
  if (/free tier can only be used/i.test(message)) {
    return new OpencodeCliError(
      'opencode_free_tier_refused',
      `OpenCode Zen's free tier refused the request (${detail}). The free tier requires ` +
        `OpenCode's built-in read and shell tools in the tool list; the executor keeps them ` +
        `listed-but-denied, so this means the permission policy changed or the gate did.`,
    );
  }
  if (err.status === 429 || looksLikeRateLimit(message)) {
    return new OpencodeCliError('opencode_rate_limited', `opencode provider rate limited: ${detail}`);
  }
  if (err.type === 'provider.auth' || err.status === 401 || err.status === 403) {
    return new OpencodeCliError(
      'opencode_auth_failed',
      `the model provider rejected the request (${detail}); set the neuron's secret to the ` +
        `provider's API key, or to 'keychain' to reuse this machine's opencode login`,
    );
  }
  return new OpencodeCliError('opencode_error_result', `opencode reported an error: ${detail}`);
}

export function redactSecret(text: string, secret: string | undefined): string {
  if (!text || !secret || secret.length < 8) return text;
  return text.split(secret).join('[REDACTED]');
}

// =============================================================================
// Prompts
// =============================================================================

function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: AnyObject) =>
        typeof part === 'string' ? part : part?.type === 'text' ? (part.text ?? '') : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return content == null ? '' : String(content);
}

function buildSystemPrompt(config: NeuronStepConfig, state: AnyObject, preamble: string): string {
  const parts: string[] = [];
  if (typeof state?.systemPrefix === 'string' && state.systemPrefix) parts.push(state.systemPrefix);
  parts.push(preamble);
  if (config.systemPrompt) {
    const rendered = renderTemplate(config.systemPrompt, state);
    if (rendered) parts.push(rendered);
  }
  const instructions = state?.data?.workspaceInstructions;
  if (typeof instructions === 'string' && instructions.trim()) parts.push(instructions);
  if (config.structuredOutput?.schema) {
    parts.push(
      'Your FINAL message must be ONLY a JSON value (no prose, no code fence) matching this ' +
        `JSON schema:\n${JSON.stringify(config.structuredOutput.schema)}`,
    );
  }
  return parts.join('\n\n');
}

function buildUserPrompt(config: NeuronStepConfig, state: AnyObject): string {
  const raw = config.userPrompt || (config as AnyObject).prompt || '';
  const match = typeof raw === 'string' ? raw.match(/^\{\{state\.([\w.]+)\}\}$/) : null;
  if (match) {
    const value = getNestedProperty(state, match[1]);
    if (Array.isArray(value)) {
      return value
        .map((msg: AnyObject) => {
          const role = msg?.role || msg?._getType?.() || 'user';
          return `${role}: ${flattenContent(msg?.content)}`;
        })
        .filter((line) => line.trim().length > 2)
        .join('\n\n');
    }
  }
  return renderTemplate(raw, state);
}

function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

/** Where the model is told it works: the session's working dir if bound. */
function resolveTree(state: AnyObject): string {
  const wd = state?.data?.workingDir;
  if (typeof wd === 'string' && wd.trim()) return wd;
  const tree = state?.data?.ws?.tree;
  if (typeof tree === 'string' && tree.trim()) return tree;
  return 'the workspace';
}

// =============================================================================
// The executor
// =============================================================================

export interface RunOpencodeStepOptions {
  config: NeuronStepConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  neuronCfg: AnyObject;
  neuronId: string;
  userId: string | undefined;
  callRunId?: string;
  abortSignal?: AbortSignal;
  emitUsage?: (providerResponse: unknown, modelHint?: string, stepIdOverride?: string) => void;
}

/**
 * Run one `opencode` neuron step. Returns `{ [outputField]: text }` plus
 * `data._cli[stepId]` with the CLI's own accounting, like the other CLI executors.
 */
export async function runOpencodeStep(options: RunOpencodeStepOptions): Promise<Record<string, unknown>> {
  const { config, state, neuronCfg, neuronId, userId, callRunId, abortSignal, emitUsage } = options;

  const stepId = config.outputField;
  const runId = callRunId || state?.runId || state?.data?.runId || 'norun';
  const publisher: AnyObject | undefined = getRunPublisher(state);
  const streamToUser = (config as AnyObject).stream === true;

  const model = resolveOpencodeModel(neuronCfg?.model);
  const secret =
    (typeof neuronCfg?.apiKey === 'string' && neuronCfg.apiKey) || process.env.OPENCODE_NEURON_SECRET || '';
  const credential = resolveProviderCredential(model, secret || undefined);
  const timeoutMs =
    typeof (config as AnyObject).timeoutMs === 'number' && (config as AnyObject).timeoutMs > 0
      ? (config as AnyObject).timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `oc-${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const home = path.join(dir, 'home');
  // Empty on purpose: nothing in it can become instructions (AGENTS.md,
  // opencode.json, .opencode/).
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });

  let bridge: RunToolBridge | null = null;
  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  let unregisterCancel: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let slotHeld = false;
  let server: ReturnType<typeof spawn> | null = null;
  const spawnedPgids: number[] = [];
  const ctl: { killReason: string | null; timedOut: boolean } = { killReason: null, timedOut: false };

  const trackGroup = (pid: number | undefined): void => {
    if (!pid) return;
    installExitHooks();
    livePgids.add(pid);
    spawnedPgids.push(pid);
  };
  // Both children (the private server and the run client) are group leaders;
  // signal both whole groups.
  const signalGroup = (signal: NodeJS.Signals): void => {
    for (const pid of spawnedPgids) {
      try {
        process.kill(-pid, signal);
      } catch {
        /* already gone */
      }
    }
  };
  const requestKill = (reason: string): void => {
    if (ctl.killReason) return;
    ctl.killReason = reason;
    console.warn(`[Opencode] killing CLI child for run ${runId}: ${reason}`);
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), SIGKILL_GRACE_MS);
    killTimer.unref?.();
  };

  try {
    const queueStartedAt = Date.now();
    await slots.acquire(
      abortSignal,
      Math.min(timeoutMs, queueWaitMs(timeoutMs)),
      slotWaitReporter({
        publisher,
        currentNodeId: () => runControlRegistry.get(runId)?.currentNodeId,
        stepId,
        runId,
        logPrefix: 'Opencode',
      }),
    );
    slotHeld = true;
    const queuedMs = Date.now() - queueStartedAt;
    const runTimeoutMs = timeoutMs - queuedMs;
    if (runTimeoutMs <= 0) {
      throw new OpencodeCliError(
        'opencode_queue_timeout',
        `opencode step '${stepId}' spent its entire ${timeoutMs} ms budget queued for a slot`,
      );
    }
    logSlotAdmission('Opencode', stepId, queuedMs);
    if (abortSignal?.aborted) throw abortError(`opencode step '${stepId}' aborted while queued`);
    if (runControlRegistry.wasCancelled(runId)) {
      throw abortError(`opencode step '${stepId}' was cancelled while queued`);
    }

    // ── tools → bridge ─────────────────────────────────────────────────────
    const attached = Array.isArray(config.tools) ? config.tools : [];
    const { clientRefs, hostedCapabilities } = partitionToolRefs(attached);
    if (hostedCapabilities.length > 0) {
      console.warn(
        `[Opencode] ignoring ${hostedCapabilities.length} hosted tool capability/ies ` +
          `(${hostedCapabilities.join(', ')}): provider 'opencode' runs its own loop.`,
      );
    }
    const resolved = await resolveTools(clientRefs, state);
    const servable: RunBridgeToolRef[] = [];
    for (const tool of resolved) {
      if (isForbiddenForBridge(tool.name)) {
        console.warn(`[Opencode] tool '${tool.name}' is forbidden for a bridge caller; dropped`);
        continue;
      }
      servable.push(tool);
    }
    const tree = resolveTree(state);
    bridge = await startRunToolBridge({
      runId,
      state,
      publisher: (publisher as RunBridgePublisher | undefined) ?? null,
      resolvedTools: servable,
      environmentId: typeof state?.data?.environmentId === 'string' ? state.data.environmentId : '',
      workingDir:
        typeof state?.data?.workingDir === 'string' && state.data.workingDir ? state.data.workingDir : undefined,
      abortSignal: abortSignal ?? null,
      neuronStepId: stepId,
      dir,
      maxToolIterations:
        typeof config.maxToolIterations === 'number' && config.maxToolIterations > 0
          ? config.maxToolIterations
          : undefined,
      onCancel: () => requestKill('run cancelled'),
    });

    buildOpencodeHome(home, buildOpencodeConfig(bridge.mcpConfig));

    // ── prompt ─────────────────────────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(config, state, BRIDGE_PREAMBLE.replace('%TREE%', tree));
    const userPrompt = buildUserPrompt(config, state);
    const prompt = `=== SYSTEM INSTRUCTIONS ===\n${systemPrompt}\n=== END SYSTEM INSTRUCTIONS ===\n\n${userPrompt}`;
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new OpencodeCliError(
        'opencode_prompt_too_large',
        `opencode step '${stepId}' built a ${promptBytes} byte prompt (limit ${MAX_PROMPT_BYTES})`,
      );
    }

    const debugLogs = process.env.OPENCODE_CLI_DEBUG === '1';
    const env = buildOpencodeChildEnv({ home, dir, credential });
    env.OPENCODE_SERVER_PASSWORD = crypto.randomBytes(24).toString('hex');
    const bin = resolveOpencodeBinary();

    // ── the private server, warmed until the bridge is connected ───────────
    const port = await pickFreePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    const serveArgs = buildOpencodeServeArgs(port);
    if (debugLogs) serveArgs.push('--print-logs', '--log-level', 'info');
    let serverExited = false;
    let serverStderr = '';
    server = spawn(bin, serveArgs, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    trackGroup(server.pid);
    let serverSpawnError = '';
    server.once('error', (err: Error) => {
      serverSpawnError = err?.message || String(err);
      serverExited = true;
    });
    server.once('exit', () => {
      serverExited = true;
    });
    server.stdout?.resume();
    server.stderr?.setEncoding('utf8');
    server.stderr?.on('data', (chunk: string) => {
      serverStderr = redactSecret(serverStderr + chunk, credential?.value).slice(-STDERR_TAIL_BYTES);
      if (debugLogs) console.log('[Opencode][debug] server', redactSecret(chunk, credential?.value).slice(0, 800));
    });
    const warmStartedAt = Date.now();
    try {
      await waitForBridgeConnected({
        url: serverUrl,
        password: env.OPENCODE_SERVER_PASSWORD,
        deadlineMs: Math.min(mcpReadyTimeoutMs(), runTimeoutMs),
        exited: () => serverExited,
        signal: abortSignal,
      });
    } catch (err) {
      if (serverSpawnError) {
        throw new OpencodeCliError('opencode_spawn_failed', `failed to spawn '${bin}': ${serverSpawnError}`);
      }
      if (err instanceof OpencodeCliError && serverStderr.trim()) {
        err.message += ` — server stderr: ${serverStderr.trim().slice(-600)}`;
      }
      throw err;
    }
    await new Promise((r) => setTimeout(r, mcpSettleMs()));
    const warmMs = Date.now() - warmStartedAt;

    const args = buildOpencodeSpawnArgs({ model, serverUrl });
    if (debugLogs) args.push('--print-logs', '--log-level', 'info');
    console.log('[Opencode] spawning', {
      neuronId,
      userId,
      model,
      credential: credential ? credential.envName : 'none',
      tools: bridge.toolNames.length,
      promptBytes,
      warmMs,
      argv: args,
    });

    child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    child.stdin.on('error', () => {
      /* EPIPE: the child exited before reading the prompt; stderr says why */
    });
    try {
      child.stdin.end(prompt, 'utf8');
    } catch (err) {
      console.warn(`[Opencode] could not write the prompt to stdin: ${(err as Error)?.message}`);
    }
    trackGroup(child.pid);

    // ── cancellation, abort, wall clock, run-record poll ───────────────────
    unregisterCancel = runControlRegistry.registerOnCancel(runId, () => requestKill('run cancelled'));
    if (abortSignal) {
      if (abortSignal.aborted) requestKill('run aborted');
      else {
        onAbort = () => requestKill('run aborted');
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }
    wallTimer = setTimeout(() => {
      ctl.timedOut = true;
      requestKill(`wall-clock timeout after ${runTimeoutMs} ms`);
    }, runTimeoutMs);
    wallTimer.unref?.();
    if (publisher?.getState) {
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            const runState = await publisher.getState();
            if (typeof runState?.status === 'string' && TERMINAL_RUN_STATUSES.has(runState.status)) {
              requestKill(`run is terminal (${runState.status})`);
            }
          } catch {
            /* a transient read must not kill a healthy child */
          }
        })();
      }, RUN_POLL_INTERVAL_MS);
      pollTimer.unref?.();
    }

    // ── stdout: NDJSON, streamed as it arrives ─────────────────────────────
    // Every publish goes through ONE serial chain so text reaches the
    // conversation in the order the model produced it (see the claude-code
    // executor's ORDERING note for the incident that taught this).
    const stream = createOpencodeStreamState();
    let publishChain: Promise<void> = Promise.resolve();
    let published = '';
    const publishText = (text: string): void => {
      if (!streamToUser || !publisher?.chunk) return;
      const piece = published && !published.endsWith('\n') ? `\n\n${text}` : text;
      published += piece;
      publishChain = publishChain.then(async () => {
        try {
          await publisher.chunk(piece);
        } catch (err) {
          console.warn('[Opencode] chunk publish failed:', err);
        }
      });
    };
    // OPENCODE_CLI_DEBUG=1 echoes the CLI's event stream (bounded, redacted)
    // to the worker log: the fastest way to see what the model actually did.
    const debug = process.env.OPENCODE_CLI_DEBUG === '1';
    let stdoutBytes = 0;
    let stdoutOverflowed = false;
    let remainder = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        if (!stdoutOverflowed) requestKill('stdout exceeded its cap');
        stdoutOverflowed = true;
        return;
      }
      const lines = (remainder + chunk).split('\n');
      remainder = lines.pop() ?? '';
      for (const line of lines) {
        if (debug) console.log('[Opencode][debug] stdout', redactSecret(line, credential?.value).slice(0, 800));
        const text = handleOpencodeLine(stream, line);
        if (text) publishText(text);
      }
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = redactSecret(stderrTail + chunk, credential?.value).slice(-STDERR_TAIL_BYTES);
      if (debug) console.log('[Opencode][debug] stderr', redactSecret(chunk, credential?.value).slice(0, 800));
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child!.once('error', (err: NodeJS.ErrnoException) => {
        reject(new OpencodeCliError('opencode_spawn_failed', `failed to spawn '${bin}': ${err?.message ?? String(err)}`));
      });
      child!.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (remainder) {
      const text = handleOpencodeLine(stream, remainder);
      if (text) publishText(text);
    }
    await publishChain;

    // ── metering: whatever was spent, on every path ────────────────────────
    const usage = mapOpencodeUsage(stream);
    if (typeof emitUsage === 'function' && (usage.total_tokens > 0 || stream.steps > 0)) {
      emitUsage({ usage_metadata: usage }, `opencode-cli/${model}`, `${stepId}:cli`);
    }

    // ── denied built-in calls are a security event, never a shrug ──────────
    if (stream.denials.length > 0) {
      console.error(
        `[Opencode][security] run ${runId} step ${stepId}: the CLI attempted ` +
          `${stream.denials.length} built-in tool call(s) the policy denies`,
        stream.denials.slice(0, 10),
      );
      await auditDenials(publisher, stepId, stream.denials);
    }

    // ── outcome ────────────────────────────────────────────────────────────
    const stderrClean = stderrTail.trim();
    if (ctl.timedOut) {
      throw new OpencodeCliError(
        'opencode_timeout',
        `opencode step '${stepId}' exceeded ${runTimeoutMs} ms of run time and was killed`,
      );
    }
    if (stdoutOverflowed) {
      throw new OpencodeCliError('opencode_failed', `opencode wrote more than ${MAX_STDOUT_BYTES} bytes to stdout`);
    }
    if (ctl.killReason) throw abortError(`opencode step '${stepId}' stopped: ${ctl.killReason}`);
    if (stream.error && stream.error.type !== 'aborted') throw classifyOpencodeError(stream.error);

    const finalText = joinTextParts(stream.lastStepTexts.length > 0 ? stream.lastStepTexts : stream.texts);
    if (!finalText.trim()) {
      if (stream.denials.length > 0) {
        throw new OpencodeCliError(
          'opencode_tool_denied',
          `opencode step '${stepId}' produced no output: the CLI reached for ${stream.denials.length} ` +
            `built-in tool(s) the policy denies (${stream.denials.map((d) => d.tool).slice(0, 8).join(', ')}).`,
        );
      }
      if (looksLikeRateLimit(stderrClean)) {
        throw new OpencodeCliError('opencode_rate_limited', `opencode exited without an answer: ${stderrClean}`);
      }
      throw new OpencodeCliError(
        'opencode_failed',
        `opencode exited ${exit.code ?? 'null'}${exit.signal ? ` (${exit.signal})` : ''} without an answer. ` +
          `stderr tail: ${stderrClean || '(empty)'}`,
      );
    }

    // The stream is what the user saw; the final message is the answer. They
    // agree whenever the final message is the stream's tail (it always is for
    // a well-formed turn). If not, the run's final content is REPLACED.
    if (streamToUser && published && !published.trimEnd().endsWith(finalText.trimEnd())) {
      try {
        await publisher?.replaceOutputContent?.(finalText);
      } catch (err) {
        console.warn('[Opencode] final content replacement failed:', err);
      }
    }

    let output: unknown = finalText;
    if (config.structuredOutput) {
      try {
        output = parseStructured(finalText);
      } catch (err) {
        throw new OpencodeCliError(
          'opencode_bad_structured_output',
          `step '${stepId}' declares structuredOutput but the model's final message is not JSON ` +
            `(${(err as Error).message}): ${finalText.slice(0, 200)}`,
        );
      }
    }

    const cli = {
      provider: 'opencode',
      model,
      sessionId: stream.sessionId,
      numSteps: stream.steps,
      toolCalls: stream.toolCalls,
      bridgeToolCalls: stream.bridgeToolCalls,
      permissionDenials: stream.denials.length,
      permissionDenialNames: stream.denials.slice(0, 20).map((d) => d.tool),
      totalCostUsd: stream.cost,
      usage,
      exitCode: exit.code,
      queuedMs,
      warmMs,
    };
    const cliBag: AnyObject = { ...(state?.data?._cli ?? {}), [stepId]: cli };
    if (state?.data && typeof state.data === 'object') state.data._cli = cliBag;
    return { [stepId]: output, 'data._cli': cliBag };
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (killTimer) clearTimeout(killTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (unregisterCancel) unregisterCancel();
    if (onAbort && abortSignal) {
      try {
        abortSignal.removeEventListener('abort', onAbort);
      } catch {
        /* ignore */
      }
    }
    // The private server outlives the run client by design; take both whole
    // groups down before the directory they live in disappears.
    for (const pgid of spawnedPgids) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* already gone */
      }
      livePgids.delete(pgid);
    }
    if (bridge) {
      try {
        await bridge.close({ removeDir: false });
      } catch (err) {
        console.warn('[Opencode] bridge close failed:', err);
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[Opencode] failed to remove step dir ${dir}:`, err);
    }
    try {
      fs.rmdirSync(path.dirname(dir));
    } catch {
      /* not empty or already gone */
    }
    if (slotHeld) slots.release();
  }
}

/** Publish denied built-in calls onto the run record as errored tool calls. */
async function auditDenials(
  publisher: AnyObject | undefined,
  stepId: string,
  denials: Array<{ tool: string; error: string }>,
): Promise<void> {
  if (!publisher?.toolStart || !publisher?.toolError) return;
  for (const [index, denial] of denials.slice(0, 20).entries()) {
    const toolId = `tool_opencode_denied_${Date.now()}_${index}`;
    try {
      await publisher.toolStart(toolId, denial.tool, 'native', {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
        cli: true,
        denied: true,
      });
      await publisher.toolError(toolId, `opencode permission denial: ${denial.tool}`, {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
      });
    } catch (err) {
      console.warn('[Opencode] failed to publish denial audit:', err);
    }
  }
}
