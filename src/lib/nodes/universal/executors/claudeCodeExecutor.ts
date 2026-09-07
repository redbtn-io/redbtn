/**
 * `claude-code` neuron executor — a Claude Code CLI child, not a chat model.
 *
 * # What this is
 *
 * The execution half of the "Opus 5" / "Fable 5.1" subscription neurons. A
 * neuron whose `provider` is `claude-code` is not an HTTP model endpoint: it is
 * a `claude -p` process spawned as a child of THIS neuron step, authenticated
 * with a Claude subscription token (`claude setup-token`, stored in redsecrets
 * and resolved through the ordinary `secretName → getConfig().apiKey` path).
 * The CLI runs its own agent loop; the only tools it can reach are the run's
 * own tools, served over the per-run Unix-socket MCP bridge
 * (`lib/mcp/run-bridge.ts`) under the run's capability profile.
 *
 * # Why not a `BaseChatModel` subclass
 *
 *   - The CLI runs its own loop and never hands back `tool_calls`, so
 *     `bindTools()` cannot be honoured.
 *   - `toolStrategy: 'none'` (which is what the capability matrix returns for
 *     this provider) discards `config.tools` before any model call, so the
 *     allowlist has to be read by this executor itself.
 *   - LangChain's `_streamIterator` reads `chunk.message.id`, i.e. a subclass
 *     must yield `ChatGenerationChunk`, not `AIMessageChunk` — a contract two
 *     earlier designs got wrong.
 *
 * So `neuronExecutor` branches to `runClaudeCodeStep()` before `getModel()`
 * ever runs, and this module wires cancellation, metering and streaming
 * explicitly.
 *
 * # The security contract
 *
 * 1. **Child env is an ALLOWLIST.** `MONGODB_URI`, `REDIS_URL`,
 *    `INTERNAL_SERVICE_KEY` and `WEBAPP_URL` never reach the child. See
 *    `buildChildEnv()` — that function is the whole story and is unit-tested.
 * 2. **No settings, no hooks, no CLAUDE.md.** `--setting-sources ""`, a fresh
 *    `CLAUDE_CONFIG_DIR` inside the step's private dir, `--restricted`, and an
 *    empty placeholder cwd. Hooks are the one Claude Code feature that runs
 *    shell, and nothing from an untrusted tree can reach the worker.
 * 3. **The bridge is the only tool surface**, and the bridge — not the client
 *    flags — is the gate: `--allowedTools` enforces nothing under
 *    `bypassPermissions`, which is the fleet standard.
 * 4. **The `system/init` event is asserted before a turn is spent**: the redbtn
 *    MCP server must be `connected`, every offered tool must be an
 *    `mcp__redbtn__*` name, and `apiKeySource` must be `"none"` (proof that no
 *    `ANTHROPIC_API_KEY` leaked into the child env). Any failure kills the
 *    child and throws.
 * 5. **`permission_denials` is never swallowed** — it means the CLI tried a
 *    tool that was not offered, so it is logged and audited onto the run
 *    record as a denied tool call.
 * 6. **Nothing is left on disk.** The step directory (socket, `mcp.json`,
 *    `CLAUDE_CONFIG_DIR`, `TMPDIR`) is removed in `finally`. The token is only
 *    ever an env value of a process that has exited.
 *
 * Field names and event shapes below were read off the wire on 2026-09-07 and
 * are recorded in `prep-reports/16-phase0-smoke.md` §4 (`system/init` 23 keys,
 * `result/success` 24 keys, `rate_limit_event`, `stream_event` deltas).
 *
 * @module lib/nodes/universal/executors/claudeCodeExecutor
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';

import type { NeuronStepConfig } from '../types';
import { CLAUDE_CODE_EFFORT_LEVELS, DEFAULT_CLAUDE_CODE_EFFORT } from '../../../types/neuron';
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// =============================================================================
// Constants
// =============================================================================

/** Wall-clock ceiling for one CLI child when the step does not set one. */
export const DEFAULT_TIMEOUT_MS = 7_200_000;

/** Grace between SIGTERM and SIGKILL. */
export const SIGKILL_GRACE_MS = 10_000;

/**
 * How often the executor re-reads the run record.
 *
 * The worker races job completion against `timeoutMs + 60 s` and does not
 * itself cancel in that path (`redworker/processors/run.ts:1233-1240`), so a
 * run can go terminal with this child still burning subscription quota. The
 * poll is the belt for that; `registerOnCancel` and `abortSignal` are the
 * braces.
 */
export const RUN_POLL_INTERVAL_MS = 60_000;

/** Default `--max-turns` when the node does not set `maxToolIterations`. */
export const DEFAULT_MAX_TURNS = 50;

/**
 * System prompts longer than this are delivered in-band on stdin instead of as
 * an argv value. Linux caps a single argv string at `MAX_ARG_STRLEN`
 * (128 KiB); 100 KB leaves headroom for the rest of the command line.
 */
export const MAX_SYSTEM_PROMPT_ARG_BYTES = 100 * 1024;

/** Bytes of stderr kept for the error message on a non-zero exit. */
export const STDERR_TAIL_BYTES = 2048;

/** A single stdout line longer than this is dropped rather than parsed. */
const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;

/**
 * `--effort` levels the 2.1.263 CLI accepts.
 *
 * VERIFIED live on 2026-09-07: `claude --help` reads "Effort level for the
 * current session (low, medium, high, xhigh, max)". The list itself lives in
 * `lib/types/neuron.ts` so the Mongoose schema validates writes against the
 * same values this validates reads against.
 */
export const EFFORT_LEVELS: ReadonlySet<string> = new Set(CLAUDE_CODE_EFFORT_LEVELS);

/**
 * Model identifiers the CLI's `--model` accepts.
 *
 * VERIFIED live on 2026-09-07 from `claude --help`: "Provide an alias for the
 * latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name
 * (e.g. 'claude-fable-5')." Both forms were exercised against the real CLI:
 * `--model opus` resolves to `claude-opus-5` in the init event, and
 * `--model claude-fable-5-1` is echoed verbatim and keys `modelUsage`.
 *
 * The shape is validated rather than passed through because it becomes an
 * argv token. `spawn` without a shell means there is no shell injection to
 * worry about, but a value beginning with `-` turns into a flag-shaped
 * argument and a value carrying whitespace or NUL is never a real model, so
 * both are refused with a config error instead of a confusing CLI parse
 * failure two seconds into a subscription turn.
 */
const MODEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

/** Fallback when a `claude-code` neuron doc somehow carries no model. */
export const DEFAULT_MODEL = 'opus';

/**
 * Validate the neuron's `model` for use as a `--model` value.
 *
 * Returns the model to spawn with. Throws `claude_code_bad_model` rather than
 * silently substituting: a neuron doc that names a model the CLI cannot parse
 * is a configuration error, and quietly running a *different* (possibly far
 * more expensive) model than the one the neuron advertises is worse than
 * failing the step.
 */
export function resolveModel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MODEL;
  if (typeof raw !== 'string' || !MODEL_ID_PATTERN.test(raw)) {
    const err = new Error(
      `neuron model ${JSON.stringify(raw)} is not a usable --model value; ` +
        `expected an alias ('opus', 'fable', 'sonnet') or a full id ('claude-opus-5')`,
    );
    (err as AnyObject).code = 'claude_code_bad_model';
    throw err;
  }
  return raw;
}

/**
 * Root of the per-step private directories.
 *
 * Read at call time, not at import time, so a test (or a worker whose `/tmp`
 * is not where the image put it) can point it elsewhere without reloading the
 * module.
 */
export function runDirRoot(): string {
  return process.env.REDBTN_RUN_DIR_ROOT || '/tmp/redbtn-run';
}

/** Mount point every workspace container uses; the worker cwd mirrors it. */
const WS_ROOT = '/ws';

/** Workspace name used when the run carries no workspace (Phase 1). */
const DEFAULT_WS_NAME = 'workspace';

/**
 * Fixed preamble prepended to every system prompt.
 *
 * The CLI has no filesystem, no shell and no network of its own here: `--tools
 * ""` strips every built-in and `--restricted` removes the code-running ones a
 * second time. Telling the model that up front is worth more than letting it
 * discover it by failing, and it is the sentence that points it at the
 * workspace machine rather than at the worker it is running on.
 */
export const BRIDGE_PREAMBLE =
  'Your only tools are the mcp__redbtn__* tools listed; they act on the workspace ' +
  'machine at %TREE%. You have no local filesystem, shell, or network.';

/** Statuses after which a run will never make progress again. */
const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'error',
  'interrupted',
]);

// =============================================================================
// Errors
// =============================================================================

/**
 * A step failure with a stable machine-readable `code`.
 *
 * Codes:
 *   - `claude_code_no_token`      — `secretName` did not resolve to a token.
 *   - `claude_code_spawn_failed`  — the CLI is not installed / not executable.
 *   - `claude_code_init_failed`   — the `system/init` guard rejected the run.
 *   - `claude_code_api_key_leak`  — `apiKeySource` was not `"none"`.
 *   - `claude_code_auth_401`      — Anthropic rejected the token. Rotate
 *                                   `claude-code-oauth`.
 *   - `claude_code_timeout`       — wall-clock ceiling hit.
 *   - `claude_code_failed`        — non-zero exit with no `result` event.
 *   - `claude_code_error_result`  — the CLI reported `is_error` / `error_*`.
 */
export class ClaudeCodeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ClaudeCodeError';
    this.code = code;
  }
}

function abortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// =============================================================================
// Worker-wide concurrency semaphore
// =============================================================================

/**
 * One CLI child is ~624 MB resident once a real context is loaded, plus ~44 MB
 * for the stdio shim node process the CLI spawns for `mcp.json`, against a
 * worker replica capped at 2304 MiB running a 1792 MB heap
 * (`prep-reports/16-phase0-smoke.md` §6). Two children do not fit any of the
 * options on the table, so the default is 1 and the limit is read at acquire
 * time so RedRun can change it without a code change.
 */
let activeChildren = 0;
const waiters: Array<() => void> = [];

function maxConcurrent(): number {
  const raw = Number.parseInt(process.env.CLAUDE_CODE_MAX_CONCURRENT || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

async function acquireSlot(abortSignal?: AbortSignal): Promise<void> {
  if (abortSignal?.aborted) throw abortError('Run aborted before claude-code slot acquired');
  if (activeChildren < maxConcurrent()) {
    activeChildren += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const idx = waiters.indexOf(admit);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(abortError('Run aborted while queued for a claude-code slot'));
    };
    function admit(): void {
      if (settled) return;
      settled = true;
      abortSignal?.removeEventListener('abort', onAbort);
      activeChildren += 1;
      resolve();
    }
    waiters.push(admit);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseSlot(): void {
  activeChildren = Math.max(0, activeChildren - 1);
  const next = waiters.shift();
  if (next) next();
}

/** Test-only: current occupancy of the worker-wide semaphore. */
export function __claudeCodeSlotsInUse(): number {
  return activeChildren;
}

// =============================================================================
// Small helpers
// =============================================================================

/**
 * RFC 4122 §4.3 name-based UUID (SHA-1, v5). `uuid` is not a dependency of the
 * engine and this is fifteen lines, so it lives here rather than in the tree.
 *
 * The namespace is fixed, so `(runId, stepId)` maps to one stable session id:
 * a re-dispatched run (orphan recovery restarts the same runId) reuses it
 * instead of littering the config dir with orphan transcripts.
 */
const UUID_NAMESPACE = 'b9a1e0f6-6a1e-5f4a-9d6c-2f1b6a0d3e57';

export function uuidv5(name: string, namespace: string = UUID_NAMESPACE): string {
  const nsHex = namespace.replace(/-/g, '');
  const nsBytes = Buffer.from(nsHex, 'hex');
  const hash = crypto
    .createHash('sha1')
    .update(nsBytes)
    .update(Buffer.from(name, 'utf8'))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Make an arbitrary string safe as ONE path segment. */
export function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = (raw || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_');
  return cleaned.slice(0, 64) || fallback;
}

/**
 * Where the model believes it is working.
 *
 * Phase 2 hands this down as `data.ws` from `workspace_checkout`. Phase 1 has
 * no workspace, so the cwd is a stable placeholder: only the transcript slug
 * (`/ws/<name>/tree` → `-ws-<name>-tree`) depends on it, and keeping it
 * identical to the container's cwd is what lets an in-container CLI agent
 * resume the same session later.
 */
export function resolveWorkspaceMount(state: AnyObject): { name: string; tree: string } {
  const ws = state?.data?.ws;
  const rawName =
    (typeof ws?.name === 'string' && ws.name) ||
    (typeof state?.data?.workspaceName === 'string' && state.data.workspaceName) ||
    '';
  const name = rawName && /^[a-z0-9][a-z0-9-]{1,62}$/.test(rawName) ? rawName : DEFAULT_WS_NAME;
  const tree =
    typeof ws?.tree === 'string' && ws.tree.startsWith('/')
      ? ws.tree
      : `${WS_ROOT}/${name}/tree`;
  return { name, tree };
}

/**
 * The child's ENTIRE environment. An allowlist, built from nothing.
 *
 * Nothing is spread in from `process.env`: the worker's env holds
 * `MONGODB_URI`, `REDIS_URL`, `INTERNAL_SERVICE_KEY` and `WEBAPP_URL`, and a
 * model that can read its own `/proc/self/environ` must find none of them.
 * `TMPDIR` is load-bearing rather than hygiene: the CLI puts its messaging
 * socket at `$TMPDIR/cc-socks/<pid>.sock`, so pointing it inside the step dir
 * is what makes `rm -rf dir` a complete cleanup.
 */
export function buildChildEnv(params: {
  dir: string;
  oauthToken: string;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = params.parentEnv ?? process.env;
  return {
    PATH: parent.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(params.dir, 'home'),
    CLAUDE_CONFIG_DIR: path.join(params.dir, 'home', '.claude'),
    CLAUDE_CODE_OAUTH_TOKEN: params.oauthToken,
    TMPDIR: params.dir,
    LANG: parent.LANG || 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
}

/**
 * Resolve `--effort`, preferring the node's parameters over the neuron doc.
 *
 * The neuron doc is the normal source: `NeuronRegistry.getConfig` now carries
 * `parameters` into `NeuronConfig` (it did not before — the field was declared
 * on neither the Mongoose schema nor the config, so `parameters.effort` could
 * not reach here at all and `--effort` was unpassable).
 *
 * An unknown level is dropped with a warning rather than throwing: unlike
 * `--model`, effort does not change *which* model runs, so degrading to the
 * default is the proportionate response to a stale doc.
 *
 * When nothing names a level, `DEFAULT_CLAUDE_CODE_EFFORT` ('xhigh') applies:
 * these neurons exist to spend a flat-rate subscription on hard work, and a
 * step that wants it cheaper says so.
 */
export function resolveEffort(state: AnyObject, neuronCfg: AnyObject): string | undefined {
  const candidates = [state?.parameters?.effort, neuronCfg?.parameters?.effort];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (EFFORT_LEVELS.has(candidate)) return candidate;
    console.warn(
      `[ClaudeCode] ignoring unknown --effort level "${candidate}" ` +
        `(known: ${[...EFFORT_LEVELS].join(', ')})`,
    );
  }
  return DEFAULT_CLAUDE_CODE_EFFORT;
}

// =============================================================================
// argv
// =============================================================================

export interface SpawnArgsInput {
  model: string;
  effort?: string;
  mcpConfigPath: string;
  sessionId?: string;
  resumeSessionId?: string;
  maxTurns: number;
  /** Omitted when the prompt was folded into stdin (see MAX_SYSTEM_PROMPT_ARG_BYTES). */
  systemPrompt?: string;
  jsonSchema?: string;
}

/**
 * Build the exact argv. Kept pure so the security-relevant shape is asserted in
 * a unit test rather than in a code review.
 *
 * Two flags are here on the strength of the Phase 0 smoke run
 * (`prep-reports/16-phase0-smoke.md` §3, §8.2) rather than the original scope:
 *
 *   - `--restricted` — VERIFIED to coexist with `--permission-mode dontAsk`
 *     (the help text's "refuses bypassPermissions" is about that mode only).
 *     It strips the code-running built-ins a second time and removes
 *     `memory_paths` from the init event, i.e. it turns auto-memory off.
 *   - `--disable-slash-commands` — `--setting-sources ""` does NOT strip the 42
 *     bundled slash commands and 16 bundled skills; they are compiled into the
 *     binary. They cannot execute anything with `tools: []`, but they are
 *     injectable instruction surface and a `Task`-style agent spawn multiplies
 *     turns.
 *
 * `--session-id` is omitted when resuming: the resumed conversation already has
 * an id and passing both is a contradiction.
 */
export function buildSpawnArgs(input: SpawnArgsInput): string[] {
  const args: string[] = ['-p', '-', '--model', input.model];
  if (input.effort) args.push('--effort', input.effort);
  args.push(
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    input.mcpConfigPath,
    '--allowedTools',
    `mcp__${BRIDGE_SERVER_NAME}`,
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--restricted',
    '--disable-slash-commands',
    '--setting-sources',
    '',
  );
  if (input.resumeSessionId) {
    args.push('--resume', input.resumeSessionId);
  } else if (input.sessionId) {
    args.push('--session-id', input.sessionId);
  }
  args.push('--max-turns', String(input.maxTurns));
  if (input.systemPrompt) args.push('--system-prompt', input.systemPrompt);
  if (input.jsonSchema) args.push('--json-schema', input.jsonSchema);
  return args;
}

// =============================================================================
// stream-json
// =============================================================================

export interface ClaudeInitEvent {
  type: 'system';
  subtype: 'init';
  model?: string;
  session_id?: string;
  tools?: string[];
  mcp_servers?: Array<{ name?: string; status?: string }>;
  apiKeySource?: string;
  permissionMode?: string;
  claude_code_version?: string;
}

export interface StreamHandlerState {
  init: ClaudeInitEvent | null;
  text: string;
  thinking: string;
  result: AnyObject | null;
  rateLimit: AnyObject | null;
  requestIds: string[];
  unparsedLines: number;
}

export interface StreamHandlerHooks {
  /** Publish assistant text to the conversation. */
  onText?: (text: string) => void;
  /** Publish thinking text. */
  onThinking?: (text: string) => void;
  /** Called once with the init event, before any turn completes. */
  onInit?: (event: ClaudeInitEvent) => void;
}

/**
 * The stream-json reader. One JSON object per line.
 *
 * Only main-loop text reaches `onText`: `parent_tool_use_id` is non-null for a
 * subagent's stream, and a subagent's chatter is not this step's answer.
 */
export function createStreamHandler(hooks: StreamHandlerHooks = {}): {
  handle: (line: string) => void;
  state: StreamHandlerState;
} {
  const state: StreamHandlerState = {
    init: null,
    text: '',
    thinking: '',
    result: null,
    rateLimit: null,
    requestIds: [],
    unparsedLines: 0,
  };

  function handle(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_STREAM_LINE_BYTES) {
      state.unparsedLines += 1;
      console.warn('[ClaudeCode] dropped an oversized stream-json line');
      return;
    }
    let event: AnyObject;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // The CLI writes non-JSON diagnostics to stderr, so a bad line on stdout
      // is worth counting but is not by itself fatal.
      state.unparsedLines += 1;
      return;
    }
    if (!event || typeof event !== 'object') return;

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init' && !state.init) {
          state.init = event as ClaudeInitEvent;
          hooks.onInit?.(state.init);
        }
        return;

      case 'stream_event': {
        const inner = event.event;
        if (!inner || inner.type !== 'content_block_delta') return;
        const delta = inner.delta;
        if (!delta) return;
        const fromSubagent = event.parent_tool_use_id != null;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (fromSubagent) return;
          state.text += delta.text;
          if (delta.text) hooks.onText?.(delta.text);
        } else if (
          (delta.type === 'thinking_delta' || delta.type === 'signature_delta') &&
          typeof delta.thinking === 'string'
        ) {
          if (fromSubagent) return;
          state.thinking += delta.thinking;
          if (delta.thinking) hooks.onThinking?.(delta.thinking);
        }
        return;
      }

      case 'assistant':
        // Tool events come from the bridge with real tool ids; the assistant
        // envelope is only worth its `request_id`, which is what Anthropic
        // support asks for.
        if (typeof event.request_id === 'string' && state.requestIds.length < 64) {
          state.requestIds.push(event.request_id);
        }
        return;

      case 'rate_limit_event':
        if (event.rate_limit_info) state.rateLimit = event.rate_limit_info;
        return;

      case 'result':
        state.result = event;
        return;

      default:
        return;
    }
  }

  return { handle, state };
}

/**
 * Guard the `system/init` event.
 *
 * Runs before the first turn completes, so a failure here costs no tokens. It
 * is the one place that can prove the child got the surface we built for it:
 * the bridge connected, nothing but bridge tools is on offer, and no API key
 * leaked into an env that is supposed to be an allowlist.
 *
 * Returns the reason to fail on, or `null` when the child is safe to run.
 */
export function assertInitEvent(
  init: ClaudeInitEvent | null,
  expectedTools: string[],
): { code: string; message: string } | null {
  if (!init) {
    return { code: 'claude_code_init_failed', message: 'no system/init event was emitted' };
  }

  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers : [];
  const bridge = servers.find((s) => s?.name === BRIDGE_SERVER_NAME);
  if (!bridge) {
    return {
      code: 'claude_code_init_failed',
      message:
        `the '${BRIDGE_SERVER_NAME}' MCP server is absent from the init event ` +
        `(servers: ${servers.map((s) => s?.name ?? '?').join(', ') || 'none'})`,
    };
  }
  if (bridge.status !== 'connected') {
    return {
      code: 'claude_code_init_failed',
      message: `the '${BRIDGE_SERVER_NAME}' MCP server reported status '${bridge.status}'`,
    };
  }

  const offered = Array.isArray(init.tools) ? init.tools : [];
  const prefix = `mcp__${BRIDGE_SERVER_NAME}__`;
  const foreign = offered.filter((name) => typeof name !== 'string' || !name.startsWith(prefix));
  if (foreign.length > 0) {
    return {
      code: 'claude_code_init_failed',
      message:
        `the CLI was offered ${foreign.length} tool(s) outside the bridge: ` +
        `${foreign.slice(0, 10).join(', ')}`,
    };
  }

  // `apiKeySource` is `"none"` for OAuth/subscription auth of any kind
  // (VERIFIED, 16-phase0-smoke.md §4). Anything else means an
  // `ANTHROPIC_API_KEY`-shaped credential reached a child whose env is
  // supposed to be an allowlist — a leak, not a preference.
  if (typeof init.apiKeySource === 'string' && init.apiKeySource !== 'none') {
    return {
      code: 'claude_code_api_key_leak',
      message: `apiKeySource is '${init.apiKeySource}', expected 'none' — an API key reached the child env`,
    };
  }

  const expected = new Set(expectedTools.map((name) => `${prefix}${name}`));
  const missing = [...expected].filter((name) => !offered.includes(name));
  if (missing.length > 0) {
    // Not fatal: the model simply has fewer tools than the node declared, and
    // failing the run for that would turn a registry hiccup into an outage.
    console.warn(
      `[ClaudeCode] init offered ${offered.length}/${expected.size} bridge tools; ` +
        `missing: ${missing.slice(0, 10).join(', ')}`,
    );
  }
  if (init.permissionMode && init.permissionMode !== 'dontAsk') {
    console.warn(`[ClaudeCode] init reported permissionMode '${init.permissionMode}'`);
  }
  return null;
}

/**
 * Map a `result` event's usage onto the metering shape.
 *
 * There is no `total_tokens` anywhere in the payload (VERIFIED,
 * 16-phase0-smoke.md §2) — it is computed. Cache creation and cache reads are
 * folded into `input_tokens` because on a subscription they are input the
 * account paid for: a plain no-tool turn already burns ~3 146 cache-creation
 * tokens of system prompt.
 */
export function mapResultUsage(usage: AnyObject | undefined): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const u = usage || {};
  const input =
    num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);
  const output = num(u.output_tokens);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

/** Map one `modelUsage` entry (camelCase on the wire) onto the same shape. */
export function mapModelUsageEntry(entry: AnyObject | undefined): {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
} {
  const e = entry || {};
  const input =
    num(e.inputTokens) + num(e.cacheCreationInputTokens) + num(e.cacheReadInputTokens);
  const output = num(e.outputTokens);
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Does this text look like Anthropic rejecting the token?
 *
 * `apiKeySource` cannot answer this — it reads `"none"` on a perfectly healthy
 * subscription run (16-phase0-smoke.md §8.1), so the detector keys on the CLI's
 * own 401 text and on a bare 401 status instead.
 */
export function looksLikeAuthFailure(text: string): boolean {
  if (!text) return false;
  return (
    /OAuth\s+401/i.test(text) ||
    /CLAUDE_CODE_OAUTH_TOKEN/.test(text) ||
    /\b401\b[^\n]{0,80}(unauthorized|authentication|invalid.{0,10}(api key|token))/i.test(text) ||
    /(invalid|expired|revoked)[^\n]{0,40}\b(oauth\s+)?token\b/i.test(text)
  );
}

// =============================================================================
// The executor
// =============================================================================

export interface RunClaudeCodeStepOptions {
  config: NeuronStepConfig;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  /** Neuron config as resolved by `NeuronRegistry.getConfig` (carries apiKey). */
  neuronCfg: AnyObject;
  neuronId: string;
  userId: string | undefined;
  callRunId: string | undefined;
  abortSignal: AbortSignal | undefined;
  emitUsage: (providerResponse: unknown, modelHint?: string, stepIdOverride?: string) => void;
}

/**
 * Run one `claude-code` neuron step.
 *
 * Returns the same `{ [outputField]: text }` shape every other neuron path
 * returns, plus `data._cli[stepId]` with the CLI's own accounting (session id,
 * turns, durations, cost estimate, stop reason, denials, rate-limit window).
 */
export async function runClaudeCodeStep(
  options: RunClaudeCodeStepOptions,
): Promise<Record<string, unknown>> {
  const { config, state, neuronCfg, neuronId, userId, callRunId, abortSignal, emitUsage } = options;

  const stepId = config.outputField;
  const runId = callRunId || state?.runId || state?.data?.runId || 'norun';
  const publisher: AnyObject | undefined = getRunPublisher(state);

  // The OAuth token comes from redsecrets through the ordinary
  // `secretName → getConfig().apiKey` path. Never from `appConfig.env` (which
  // `redrun_workspace_get` returns in cleartext) and never from an image layer.
  const oauthToken = typeof neuronCfg?.apiKey === 'string' ? neuronCfg.apiKey : '';
  if (!oauthToken) {
    throw new ClaudeCodeError(
      'claude_code_no_token',
      `Neuron '${neuronId}' is provider 'claude-code' but no subscription token resolved. ` +
        `Set secretName (e.g. 'claude-code-oauth') on the neuron and store the ` +
        `\`claude setup-token\` output in the vault.`,
    );
  }

  const model = resolveModel(neuronCfg?.model);
  const mount = resolveWorkspaceMount(state);
  const maxTurns =
    typeof config.maxToolIterations === 'number' && config.maxToolIterations > 0
      ? config.maxToolIterations
      : DEFAULT_MAX_TURNS;
  const timeoutMs =
    typeof (config as AnyObject).timeoutMs === 'number' && (config as AnyObject).timeoutMs > 0
      ? (config as AnyObject).timeoutMs
      : DEFAULT_TIMEOUT_MS;

  // The CLI is the whole node's turn: stream only when the node asked for it,
  // and never from a node named respond/responder — `functions/run.ts:1005`
  // forwards `on_llm_stream` for exactly those two names, so publishing here
  // as well would double up in the conversation.
  const nodeName = resolveNodeName(state);
  const streamToUser =
    config.stream === true && nodeName !== 'respond' && nodeName !== 'responder';

  // ── the step's private directory ─────────────────────────────────────────
  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.mkdirSync(path.join(dir, 'home', '.claude'), { recursive: true, mode: 0o700 });

  // Placeholder cwd. Empty on purpose: nothing from an untrusted tree — no
  // CLAUDE.md, no `.claude/settings.json`, no hooks — can be discovered from
  // it, and the transcript slug it produces (`-ws-<name>-tree`) is the same one
  // an in-container agent produces, which is what makes a session resumable
  // across machines later.
  const cwd = ensureCwd(mount.tree, dir);

  let bridge: RunToolBridge | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let unregisterCancel: (() => void) | null = null;
  let reader: readline.Interface | null = null;
  let onAbort: (() => void) | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let slotHeld = false;

  /**
   * Mutable outcome flags.
   *
   * These are written from timers, event handlers and the cancel registry, so
   * they live on an object: a `let` assigned only inside a closure keeps its
   * declaration-time narrowing at the read sites below, which is exactly how
   * a guard silently becomes dead code.
   */
  const ctl: {
    killReason: string | null;
    initFailure: { code: string; message: string } | null;
    timedOut: boolean;
  } = { killReason: null, initFailure: null, timedOut: false };

  /**
   * Signal the child's whole PROCESS GROUP, not just the child.
   *
   * The CLI is not a leaf: it spawns the stdio shim for the bridge, and any
   * other MCP server it is configured with. `child.kill()` signals only the
   * `claude` process itself, so a CLI that dies without reaping its own
   * children — or one wedged enough to ignore SIGTERM — leaves them behind
   * holding the bridge socket and, worse, still burning subscription quota
   * against a run the platform has already given up on.
   *
   * `spawn(..., { detached: true })` makes the child a process-group leader
   * (pgid == pid), which is what makes `process.kill(-pid, …)` safe: without
   * it the child shares the WORKER's group and a negative pid would signal
   * the worker itself. The two facts belong together — do not remove
   * `detached` without removing this.
   */
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // ESRCH: the group is already gone, or (on a platform without process
      // groups) never existed. Fall back to the direct child.
      try {
        child?.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  /** Idempotent SIGTERM → 10 s → SIGKILL, both to the whole group. */
  const requestKill = (reason: string): void => {
    if (ctl.killReason) return;
    ctl.killReason = reason;
    console.warn(`[ClaudeCode] killing CLI child for run ${runId}: ${reason}`);
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), SIGKILL_GRACE_MS);
    killTimer.unref?.();
  };

  try {
    await acquireSlot(abortSignal);
    slotHeld = true;

    // ── tools → bridge ─────────────────────────────────────────────────────
    const attached = Array.isArray(config.tools) ? config.tools : [];
    const { clientRefs, hostedCapabilities } = partitionToolRefs(attached);
    if (hostedCapabilities.length > 0) {
      // Hosted tools are PROVIDER-executed. There is no provider request here
      // to attach them to — the CLI owns the loop — so saying so is better
      // than dropping them silently.
      console.warn(
        `[ClaudeCode] ignoring ${hostedCapabilities.length} hosted tool capability/ies ` +
          `(${hostedCapabilities.join(', ')}): provider 'claude-code' executes its own loop.`,
      );
    }
    const resolved = await resolveTools(clientRefs, state);
    const servable: RunBridgeToolRef[] = [];
    for (const tool of resolved) {
      if (isForbiddenForBridge(tool.name)) {
        console.warn(`[ClaudeCode] tool '${tool.name}' is forbidden for a bridge caller; dropped`);
        continue;
      }
      servable.push(tool);
    }

    bridge = await startRunToolBridge({
      runId,
      state,
      publisher: (publisher as RunBridgePublisher | undefined) ?? null,
      resolvedTools: servable,
      environmentId:
        typeof state?.data?.environmentId === 'string' ? state.data.environmentId : '',
      workingDir:
        typeof state?.data?.workingDir === 'string' && state.data.workingDir
          ? state.data.workingDir
          : mount.tree,
      abortSignal: abortSignal ?? null,
      neuronStepId: stepId,
      dir,
      maxToolIterations: maxTurns,
      onCancel: () => requestKill('run cancelled'),
    });

    const mcpConfigPath = path.join(dir, 'mcp.json');
    fs.writeFileSync(mcpConfigPath, JSON.stringify(bridge.mcpConfig, null, 2), { mode: 0o600 });
    fs.chmodSync(mcpConfigPath, 0o600);

    // ── prompts ────────────────────────────────────────────────────────────
    const preamble = BRIDGE_PREAMBLE.replace('%TREE%', mount.tree);
    const systemPrompt = buildSystemPrompt(config, state, preamble);
    const userPrompt = buildUserPrompt(config, state);

    const systemFitsInArgv =
      Buffer.byteLength(systemPrompt, 'utf8') <= MAX_SYSTEM_PROMPT_ARG_BYTES;
    const stdinPayload = systemFitsInArgv
      ? userPrompt
      : `=== SYSTEM INSTRUCTIONS ===\n${systemPrompt}\n=== END SYSTEM INSTRUCTIONS ===\n\n${userPrompt}`;
    if (!systemFitsInArgv) {
      console.warn(
        `[ClaudeCode] system prompt is ${Buffer.byteLength(systemPrompt, 'utf8')} bytes; ` +
          'folding it into stdin (MAX_ARG_STRLEN).',
      );
    }

    const args = buildSpawnArgs({
      model,
      effort: resolveEffort(state, neuronCfg),
      mcpConfigPath,
      sessionId: uuidv5(`${runId}:${stepId}`),
      resumeSessionId: resolveResumeSessionId(config, state, stepId),
      maxTurns,
      systemPrompt: systemFitsInArgv ? systemPrompt : undefined,
      jsonSchema: config.structuredOutput
        ? JSON.stringify(config.structuredOutput.schema)
        : undefined,
    });

    const env = buildChildEnv({ dir, oauthToken });
    const bin = process.env.CLAUDE_CODE_BIN || 'claude';

    console.log('[ClaudeCode] spawning', {
      neuronId,
      userId,
      model,
      cwd,
      maxTurns,
      timeoutMs,
      tools: bridge.toolNames.length,
      // The token is an env value and never an argument, so argv is loggable.
      argv: redactArgvForLog(args),
    });

    // `detached: true` puts the CLI in its own process group so `signalGroup`
    // can take down the shim and any other grandchild with it. See the comment
    // there — the two are a pair.
    child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

    // ── cancellation, abort, wall clock, run-record poll ───────────────────
    unregisterCancel = runControlRegistry.registerOnCancel(runId, () =>
      requestKill('run cancelled'),
    );
    if (abortSignal) {
      if (abortSignal.aborted) {
        requestKill('run aborted');
      } else {
        onAbort = () => requestKill('run aborted');
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }
    }
    wallTimer = setTimeout(() => {
      ctl.timedOut = true;
      requestKill(`wall-clock timeout after ${timeoutMs} ms`);
    }, timeoutMs);
    wallTimer.unref?.();
    if (publisher?.getState) {
      pollTimer = setInterval(() => {
        void (async () => {
          try {
            const runState = await publisher.getState();
            const status = runState?.status;
            if (typeof status === 'string' && TERMINAL_RUN_STATUSES.has(status)) {
              requestKill(`run is terminal (${status})`);
            }
          } catch {
            /* a transient Redis read must not kill a healthy child */
          }
        })();
      }, RUN_POLL_INTERVAL_MS);
      pollTimer.unref?.();
    }

    // ── stdin ──────────────────────────────────────────────────────────────
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code !== 'EPIPE') console.warn('[ClaudeCode] stdin error:', err?.message ?? err);
    });
    child.stdin.end(stdinPayload);

    // ── stdout / stderr ────────────────────────────────────────────────────
    const expectedTools = bridge.toolNames;
    const handler = createStreamHandler({
      onText: streamToUser && publisher?.chunk
        ? (text) => {
            void Promise.resolve(publisher.chunk(text)).catch((err: unknown) =>
              console.warn('[ClaudeCode] chunk publish failed:', err),
            );
          }
        : undefined,
      onThinking: streamToUser && publisher?.thinkingChunk
        ? (text) => {
            void Promise.resolve(publisher.thinkingChunk(text)).catch((err: unknown) =>
              console.warn('[ClaudeCode] thinkingChunk publish failed:', err),
            );
          }
        : undefined,
      onInit: (init) => {
        const failure = assertInitEvent(init, expectedTools);
        if (failure) {
          ctl.initFailure = failure;
          // Before a turn is spent: kill first, complain after.
          requestKill(`init assertion failed: ${failure.message}`);
        } else {
          console.log('[ClaudeCode] init OK', {
            model: init.model,
            sessionId: init.session_id,
            tools: init.tools?.length ?? 0,
            version: init.claude_code_version,
          });
        }
      },
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader = rl;
    const readerDone = new Promise<void>((resolve) => rl.once('close', () => resolve()));
    rl.on('line', (line) => {
      try {
        handler.handle(line);
      } catch (err) {
        console.warn('[ClaudeCode] stream handler threw:', err);
      }
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child!.once('error', (err: NodeJS.ErrnoException) => {
          reject(
            new ClaudeCodeError(
              'claude_code_spawn_failed',
              `failed to spawn '${bin}': ${err?.message ?? String(err)}`,
            ),
          );
        });
        child!.once('close', (code, signal) => resolve({ code, signal }));
      },
    );
    // The child's `close` fires after its stdio has closed, but wait for the
    // reader as well: the last line of the stream is the `result` event, and
    // dropping it would turn a completed run into "no result event".
    await readerDone;

    // ── outcome ────────────────────────────────────────────────────────────
    // The init guard wins over everything: it fired before a turn completed.
    if (ctl.initFailure) {
      throw new ClaudeCodeError(
        ctl.initFailure.code,
        `claude-code init guard rejected the session: ${ctl.initFailure.message}`,
      );
    }
    if (ctl.timedOut) {
      throw new ClaudeCodeError(
        'claude_code_timeout',
        `claude-code step '${stepId}' exceeded ${timeoutMs} ms and was killed`,
      );
    }
    if (ctl.killReason && !handler.state.result) {
      throw abortError(`claude-code step '${stepId}' stopped: ${ctl.killReason}`);
    }

    const result = handler.state.result;
    if (!result) {
      const tail = stderrTail.trim();
      if (looksLikeAuthFailure(tail)) {
        throw new ClaudeCodeError(
          'claude_code_auth_401',
          `Anthropic rejected the subscription token — rotate the 'claude-code-oauth' secret. ${tail}`,
        );
      }
      throw new ClaudeCodeError(
        'claude_code_failed',
        `claude exited ${exit.code ?? 'null'}${exit.signal ? ` (${exit.signal})` : ''} ` +
          `without a result event. stderr tail: ${tail || '(empty)'}`,
      );
    }

    const finalText = typeof result.result === 'string' ? result.result : handler.state.text;
    const softMaxTurns = result.subtype === 'error_max_turns';
    const isError =
      result.is_error === true ||
      (typeof result.subtype === 'string' && result.subtype.startsWith('error_'));

    // ── metering ───────────────────────────────────────────────────────────
    const usedModel =
      handler.state.init?.model ||
      (typeof result.modelUsage === 'object' && result.modelUsage
        ? Object.keys(result.modelUsage)[0]
        : undefined) ||
      model;
    const usage = mapResultUsage(result.usage);
    emitUsage({ usage_metadata: usage }, `claude-code/${usedModel}`, `${stepId}:cli`);
    if (result.modelUsage && typeof result.modelUsage === 'object') {
      for (const [entryModel, entry] of Object.entries(result.modelUsage as AnyObject)) {
        if (entryModel === usedModel) continue;
        emitUsage(
          { usage_metadata: mapModelUsageEntry(entry as AnyObject) },
          `claude-code/${entryModel}`,
          `${stepId}:cli:${entryModel}`,
        );
      }
    }

    // ── denials are a security event, never a shrug ────────────────────────
    const denials: unknown[] = Array.isArray(result.permission_denials)
      ? result.permission_denials
      : [];
    if (denials.length > 0) {
      console.error(
        `[ClaudeCode][security] run ${runId} step ${stepId}: the CLI attempted ` +
          `${denials.length} tool call(s) it was not offered`,
        denials.slice(0, 10),
      );
      await auditDenials(publisher, stepId, denials);
    }

    // ── the run record ─────────────────────────────────────────────────────
    const cli = {
      provider: 'claude-code',
      model: usedModel,
      sessionId: result.session_id ?? handler.state.init?.session_id ?? null,
      numTurns: num(result.num_turns),
      durationMs: num(result.duration_ms),
      durationApiMs: num(result.duration_api_ms),
      // API-EQUIVALENT ESTIMATE. Recorded so a subscription run can be
      // compared against what the API would have charged; never billed.
      totalCostUsdEstimate: num(result.total_cost_usd),
      stopReason: result.stop_reason ?? null,
      terminalReason: result.terminal_reason ?? null,
      subagentsSpawned: num(result.subagent_stats?.spawned),
      permissionDenials: denials.length,
      permissionDenialNames: denials
        .slice(0, 20)
        .map((d) => (typeof d === 'object' && d ? (d as AnyObject).tool_name : d)),
      usage,
      rateLimit: handler.state.rateLimit
        ? {
            status: handler.state.rateLimit.status ?? null,
            fiveHourUtilization:
              handler.state.rateLimit.unifiedWindows?.five_hour?.utilization ?? null,
            sevenDayUtilization:
              handler.state.rateLimit.unifiedWindows?.seven_day?.utilization ?? null,
            resetsAt: handler.state.rateLimit.resetsAt ?? null,
            overageStatus: handler.state.rateLimit.overageStatus ?? null,
          }
        : null,
      requestIds: handler.state.requestIds.slice(0, 8),
      exitCode: exit.code,
      truncated: softMaxTurns || undefined,
    };
    if (handler.state.rateLimit) {
      console.log('[ClaudeCode] rate limit window', cli.rateLimit);
    }

    if (isError && !softMaxTurns) {
      const detail =
        (typeof result.result === 'string' && result.result) || stderrTail.trim() || '(no detail)';
      if (looksLikeAuthFailure(detail)) {
        throw new ClaudeCodeError(
          'claude_code_auth_401',
          `Anthropic rejected the subscription token — rotate the 'claude-code-oauth' secret. ${detail}`,
        );
      }
      throw new ClaudeCodeError(
        'claude_code_error_result',
        `claude-code step '${stepId}' failed (${result.subtype ?? 'error'}): ${detail}`,
      );
    }
    if (softMaxTurns) {
      console.warn(
        `[ClaudeCode] step '${stepId}' hit --max-turns ${maxTurns}; returning partial output`,
      );
    }

    // Write in place so later steps of the SAME node can read it, and return
    // the flat key so the value survives the LangGraph reducer.
    const cliBag: AnyObject = { ...(state?.data?._cli ?? {}), [stepId]: cli };
    if (state?.data && typeof state.data === 'object') state.data._cli = cliBag;

    return { [stepId]: finalText, 'data._cli': cliBag };
  } finally {
    if (reader) {
      try {
        reader.close();
      } catch {
        /* already closed */
      }
    }
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
    if (bridge) {
      try {
        await bridge.close({ removeDir: false });
      } catch (err) {
        console.warn('[ClaudeCode] bridge close failed:', err);
      }
    }
    // Belt for the bridge's own removal: the socket, `mcp.json`, the config
    // dir, the transcript and the CLI's `$TMPDIR` all live under `dir`.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[ClaudeCode] failed to remove step dir ${dir}:`, err);
    }
    if (slotHeld) releaseSlot();
  }
}

// =============================================================================
// Executor-local helpers
// =============================================================================

/**
 * Best-effort placeholder cwd.
 *
 * `/ws` is created and chowned by the worker image, but a dev box, a test and
 * a read-only rootfs are all real, so a failure falls back inside the step dir
 * rather than failing the step. Only the transcript slug depends on the path.
 */
function ensureCwd(tree: string, dir: string): string {
  try {
    fs.mkdirSync(tree, { recursive: true });
    return tree;
  } catch (err) {
    const fallback = path.join(dir, tree.replace(/^\//, ''));
    console.warn(
      `[ClaudeCode] could not create placeholder cwd ${tree} (${(err as Error)?.message}); ` +
        `using ${fallback}`,
    );
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/** The compiled graph node key, which is what `functions/run.ts` gates on. */
function resolveNodeName(state: AnyObject): string {
  return (
    state?.nodeConfig?.graphNodeId ||
    state?.nodeConfig?.nodeId ||
    state?.nodeId ||
    state?.data?.currentNodeId ||
    ''
  );
}

/**
 * System prompt: node prefix, then the bridge preamble, then the step's own
 * prompt, then the workspace's own instructions (AGENTS.md / CLAUDE.md, read
 * into `data.workspaceInstructions` by a setup step — auto-discovery is
 * deliberately impossible here, because the cwd is an empty placeholder).
 *
 * Keep this byte-stable across the steps of a run: an identical system prompt
 * was 19× cheaper on the second call (3 146 cached tokens, 16-phase0-smoke.md
 * §2), and interpolating a timestamp or a run id would throw that away.
 */
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
  return parts.join('\n\n');
}

/**
 * User prompt. A `userPrompt` that is a bare reference to a messages array
 * (`{{state.data.messages}}`) is serialised as `role: content` turns — the CLI
 * takes one prompt on stdin, not a message list.
 */
function buildUserPrompt(config: NeuronStepConfig, state: AnyObject): string {
  const match = config.userPrompt?.match(/^\{\{state\.([\w.]+)\}\}$/);
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
  return renderTemplate(config.userPrompt, state);
}

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

/**
 * A session id to resume, when the node asked for it and a previous execution
 * of this step recorded one. Transcript round-trip into a workspace container
 * is a later phase; this covers the in-run case (a loop, an error retry) where
 * the config dir is gone but the session id is still in state.
 */
function resolveResumeSessionId(
  config: NeuronStepConfig,
  state: AnyObject,
  stepId: string,
): string | undefined {
  if ((config as AnyObject).resume !== true) return undefined;
  const prior = state?.data?._cli?.[stepId]?.sessionId;
  return typeof prior === 'string' && prior ? prior : undefined;
}

/**
 * Publish `permission_denials` onto the run record the same way the bridge
 * publishes its own denials: a started-then-errored tool call. A denial means
 * the CLI reached for a tool that was never offered, which is exactly the
 * signal that must not live only in a worker log line.
 */
async function auditDenials(
  publisher: AnyObject | undefined,
  stepId: string,
  denials: unknown[],
): Promise<void> {
  if (!publisher?.toolStart || !publisher?.toolError) return;
  for (const [index, denial] of denials.slice(0, 20).entries()) {
    const d = (typeof denial === 'object' && denial ? denial : {}) as AnyObject;
    const name = typeof d.tool_name === 'string' ? d.tool_name.slice(0, 64) : 'unknown';
    const toolId = `tool_cli_denied_${Date.now()}_${index}`;
    try {
      await publisher.toolStart(toolId, name, 'native', {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
        cli: true,
        denied: true,
      });
      await publisher.toolError(toolId, `claude-code permission denial: ${name}`, {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
      });
    } catch (err) {
      console.warn('[ClaudeCode] failed to publish denial audit:', err);
    }
  }
}

/**
 * argv for a log line. The token is never an argument, but the system prompt
 * and the JSON schema can be enormous, so they are elided rather than logged.
 */
function redactArgvForLog(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    out.push(args[i]);
    if (args[i] === '--system-prompt' || args[i] === '--json-schema') {
      const value = args[i + 1] ?? '';
      out.push(`<${Buffer.byteLength(value, 'utf8')} bytes>`);
      i += 1;
    }
  }
  return out;
}
