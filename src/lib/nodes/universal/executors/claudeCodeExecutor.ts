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

/**
 * `--json-schema` ceiling.
 *
 * Same MAX_ARG_STRLEN constraint as the system prompt, but with no stdin
 * fallback to fold an oversized value into, so this one is a hard error.
 */
export const MAX_JSON_SCHEMA_ARG_BYTES = 100 * 1024;

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

/**
 * How long a step may wait for a slot, before being capped by its own timeout.
 *
 * Defaults to the step's whole budget (wait as long as you were going to live
 * anyway); `CLAUDE_CODE_QUEUE_WAIT_MS` tightens it for an operator who would
 * rather a queued step failed fast than burned its deadline waiting.
 */
export function queueWaitMs(timeoutMs: number): number {
  const raw = Number.parseInt(process.env.CLAUDE_CODE_QUEUE_WAIT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : timeoutMs;
}

/**
 * Wait for a slot, but never past `maxWaitMs`.
 *
 * An unbounded wait is not "patient", it is a queue with no failure mode: with
 * `CLAUDE_CODE_MAX_CONCURRENT=1` (the default) one two-hour child parks every
 * other `claude-code` step behind it until the WORKER's own job race fails
 * them while they are still queued — and this executor would then acquire the
 * slot and spawn a real CLI child, spending subscription quota, for a run that
 * is already terminal. Failing fast with a distinct code is the honest answer:
 * the step could not get a worker, which is an operational fact worth seeing.
 */
async function acquireSlot(abortSignal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
  if (abortSignal?.aborted) throw abortError('Run aborted before claude-code slot acquired');
  if (activeChildren < maxConcurrent()) {
    activeChildren += 1;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const unqueue = () => {
      const idx = waiters.indexOf(admit);
      if (idx >= 0) waiters.splice(idx, 1);
      if (timer) clearTimeout(timer);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      unqueue();
      reject(abortError('Run aborted while queued for a claude-code slot'));
    };
    function admit(): void {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      activeChildren += 1;
      resolve();
    }
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unqueue();
      abortSignal?.removeEventListener('abort', onAbort);
      reject(
        new ClaudeCodeError(
          'claude_code_queue_timeout',
          `waited ${maxWaitMs} ms for one of ${maxConcurrent()} claude-code slot(s) on this ` +
            `worker and never got one; raise CLAUDE_CODE_MAX_CONCURRENT or add workers`,
        ),
      );
    }, maxWaitMs);
    timer.unref?.();
    waiters.push(admit);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

function releaseSlot(): void {
  activeChildren = Math.max(0, activeChildren - 1);
  const next = waiters.shift();
  if (next) next();
}

// =============================================================================
// Live children: surviving the worker's own death
// =============================================================================

/**
 * Process-group ids of CLI children this process started and has not reaped.
 *
 * `detached: true` is what makes the group kill possible, but it also means
 * the CLI is NOT killed when the worker dies — it is reparented to init, still
 * holding `CLAUDE_CODE_OAUTH_TOKEN` in its environment and still spending
 * subscription quota on a run nobody is listening to any more. A worker deploy
 * severs in-flight runs routinely, so this is the common case, not the
 * exotic one.
 */
const livePgids = new Set<number>();

let exitHooksInstalled = false;

/** Group-kill everything still running. Best effort by construction. */
function killAllLiveChildren(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const pgid of livePgids) {
    try {
      process.kill(-pgid, signal);
    } catch {
      /* already gone */
    }
  }
  livePgids.clear();
}

/**
 * Install the worker-death hooks once.
 *
 * `exit` cannot await anything, so the SIGTERM it sends is all the child gets;
 * that is enough, because the CLI exits on a closed stdin anyway and the
 * point here is to not leave a *detached* process holding a token. The signal
 * handlers re-raise so normal shutdown is not swallowed — installing a
 * listener for SIGTERM/SIGINT otherwise silently disables the default
 * terminate behaviour, which would hang the worker on deploy.
 */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on('exit', () => killAllLiveChildren('SIGKILL'));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      killAllLiveChildren('SIGTERM');
      // Restore the default and re-raise, so this hook observes the shutdown
      // without becoming the thing that decides it.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/**
 * Age past which a directory under `runDirRoot()` is considered abandoned.
 *
 * Only ever applied to directories this executor's own naming scheme created.
 */
export const STALE_DIR_MAX_AGE_MS = 60 * 60 * 1000;

let sweptStaleDirs = false;

/**
 * Remove step directories left behind by a previous worker process.
 *
 * The `finally` block deletes the step dir on every path this process
 * controls, but a SIGKILLed worker (OOM, `docker kill`, a node reboot)
 * controls nothing — and the CLI may by then have persisted the OAuth token
 * into its `CLAUDE_CONFIG_DIR`, which lives inside that directory. Those
 * survive the worker, so sweep them at first use.
 *
 * Age-gated rather than "delete everything": two workers sharing a `/tmp` (a
 * dev box, two vitest workers) must not delete each other's live step dirs,
 * and nothing legitimate under here is an hour old.
 */
export function sweepStaleRunDirs(force = false): number {
  if (sweptStaleDirs && !force) return 0;
  sweptStaleDirs = true;
  const root = runDirRoot();
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0; // no root yet: nothing to sweep
  }
  const cutoff = Date.now() - STALE_DIR_MAX_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    try {
      if (fs.statSync(full).mtimeMs > cutoff) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* a directory we cannot stat or remove is not ours to worry about */
    }
  }
  if (removed > 0) {
    console.warn(
      `[ClaudeCode] swept ${removed} abandoned run director${removed === 1 ? 'y' : 'ies'} ` +
        `under ${root} (a previous worker died without cleaning up)`,
    );
  }
  return removed;
}

/** Test-only: reset the once-per-process sweep latch. */
export function __resetStaleSweep(): void {
  sweptStaleDirs = false;
}

/** Test-only: pgids currently registered as live. */
export function __liveChildCount(): number {
  return livePgids.size;
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

  // The default, and the only shape a supplied `tree` may take.
  const canonical = `${WS_ROOT}/${name}/tree`;

  // `tree` becomes the child's cwd and is passed to `mkdirSync(recursive)`,
  // so "starts with a slash" is nowhere near enough: `/etc/cron.d` starts with
  // a slash. It must live under the mount point the validated slug already
  // fixed, which also means a `tree` cannot smuggle in a different workspace
  // than the `name` the slug check approved. `..` is refused outright rather
  // than normalised, because a path that needs normalising is not one this
  // ever meant to accept.
  const supplied = typeof ws?.tree === 'string' ? ws.tree : '';
  const prefix = `${WS_ROOT}/${name}/`;
  const acceptable =
    supplied === canonical ||
    (supplied.startsWith(prefix) &&
      !supplied.includes('..') &&
      !supplied.includes('\0') &&
      !supplied.includes('//'));

  if (supplied && !acceptable) {
    console.warn(
      `[ClaudeCode] ignoring workspace tree ${JSON.stringify(supplied)}: ` +
        `it is not under ${prefix}`,
    );
  }
  return { name, tree: acceptable ? supplied : canonical };
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
  /** Empty under `--disable-slash-commands`; 42 entries without it. */
  slash_commands?: string[];
  /** Empty under `--disable-slash-commands`; 16 entries without it. */
  skills?: string[];
  /** Present ONLY when `--restricted` is absent (auto-memory is on). */
  memory_paths?: string[];
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
 * Concatenate the text blocks of an `assistant` event's message.
 *
 * The envelope carries the message's text CUMULATIVELY — everything the model
 * has produced for that message, not a delta — alongside `tool_use` blocks
 * that are not text and never belong in the conversation bubble.
 */
export function assistantMessageText(message: unknown): string {
  const content = (message as AnyObject)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: AnyObject) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .join('');
}

/**
 * The stream-json reader. One JSON object per line.
 *
 * Only main-loop text reaches `onText`: `parent_tool_use_id` is non-null for a
 * subagent's stream, and a subagent's chatter is not this step's answer.
 *
 * TWO sources of assistant text, reconciled so neither is lost and nothing is
 * emitted twice:
 *
 *   - `stream_event` / `content_block_delta` — token deltas, present only
 *     while the CLI is emitting partial messages.
 *   - `assistant` — the completed message envelope, whose text is CUMULATIVE
 *     for that message. It is the only source when partial messages are
 *     absent (a resumed turn, a build that stops emitting them, the message
 *     that follows a tool result), which is why the conversation stream used
 *     to lose whole turns while the persisted message was complete
 *     (report 39, defect D1).
 *
 * Per message id: whatever the deltas already emitted is treated as a prefix
 * of the envelope's text and only the remainder is published. A divergent
 * envelope (not an extension of what was streamed) publishes nothing rather
 * than duplicating the turn.
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

  /**
   * Text already emitted for the message currently being assembled, and the
   * same per message id so a repeated envelope is a no-op.
   *
   * `sawDelta` is the source-of-truth switch: once a message has produced a
   * single `content_block_delta`, the deltas ARE that message's stream and its
   * `assistant` envelope contributes nothing. Mixing the two is what let a
   * second writer interleave text into an already-ordered stream.
   */
  let pendingDeltaText = '';
  let sawDelta = false;
  const emittedByMessage = new Map<string, string>();

  function emit(text: string): void {
    if (!text) return;
    state.text += text;
    hooks.onText?.(text);
  }

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
        if (!inner) return;
        if (inner.type === 'message_start') {
          // A new assistant message begins: close the previous message's
          // ledger and start it again from nothing.
          if (event.parent_tool_use_id == null) {
            pendingDeltaText = '';
            sawDelta = false;
          }
          return;
        }
        if (inner.type !== 'content_block_delta') return;
        const delta = inner.delta;
        if (!delta) return;
        const fromSubagent = event.parent_tool_use_id != null;
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          if (fromSubagent) return;
          pendingDeltaText += delta.text;
          sawDelta = true;
          emit(delta.text);
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

      case 'assistant': {
        // `request_id` is what Anthropic support asks for. Tool events come
        // from the bridge with real tool ids, so `tool_use` blocks are ignored
        // here.
        if (typeof event.request_id === 'string' && state.requestIds.length < 64) {
          state.requestIds.push(event.request_id);
        }
        if (event.parent_tool_use_id != null) return; // a subagent's turn
        const message = event.message;
        const messageId = typeof message?.id === 'string' ? message.id : null;
        const hadDeltas = sawDelta;
        const priorFromDeltas = pendingDeltaText;
        pendingDeltaText = '';
        sawDelta = false;
        // ONE source per message. When the message streamed deltas, they are
        // the whole of it — a real capture shows the envelope's text equal to
        // the deltas character for character — and re-deriving anything from
        // the envelope only risks a second writer racing the first.
        if (hadDeltas) {
          if (messageId) {
            if (emittedByMessage.size >= 256) emittedByMessage.clear();
            emittedByMessage.set(messageId, priorFromDeltas);
          }
          return;
        }
        // No deltas for this message: the envelope IS the stream. Emit exactly
        // the suffix beyond what this message id has already contributed, so a
        // repeated or grown envelope never republishes what was shown.
        const prior = messageId ? (emittedByMessage.get(messageId) ?? '') : '';
        const full = assistantMessageText(message);
        let tail = '';
        if (!prior) {
          tail = full;
        } else if (full.startsWith(prior)) {
          tail = full.slice(prior.length);
        } else if (full) {
          console.warn(
            '[ClaudeCode] assistant envelope diverged from what was already emitted; ' +
              'not republishing (run_complete carries the authoritative text)',
          );
        }
        emit(tail);
        if (messageId) {
          if (emittedByMessage.size >= 256) emittedByMessage.clear();
          emittedByMessage.set(messageId, prior + tail);
        }
        return;
      }

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
  // (VERIFIED live on 2.1.263, 2026-09-07: the field is PRESENT in the
  // stream-json init event under a subscription token — it is only the
  // `--output-format json` *result* envelope that omits it). Anything else
  // means an `ANTHROPIC_API_KEY`-shaped credential reached a child whose env
  // is supposed to be an allowlist — a leak, not a preference.
  //
  // Presence is required, not just the value: tolerating an absent field would
  // mean a CLI build that stopped emitting it silently disabled this
  // assertion, which is exactly the failure mode a security check must not
  // have. If a future CLI drops the field this fails loudly and gets looked at.
  if (init.apiKeySource !== 'none') {
    return {
      code: 'claude_code_api_key_leak',
      message:
        `apiKeySource is ${init.apiKeySource === undefined ? 'absent' : `'${init.apiKeySource}'`}, ` +
        `expected 'none' — an API key reached the child env, or this CLI no longer reports the source`,
    };
  }

  // `--restricted` and `--disable-slash-commands` are load-bearing, so verify
  // them off the wire rather than trusting that the flags were accepted.
  // Measured on 2.1.263: with both flags, `slash_commands` and `skills` are
  // `[]` and `memory_paths` is absent entirely; without `--restricted`,
  // `memory_paths` appears (auto-memory reads files the worker never vetted).
  // Bundled commands and skills cannot execute anything while `tools` is
  // empty, but they are injectable instruction surface.
  const slashCommands = Array.isArray(init.slash_commands) ? init.slash_commands : [];
  if (slashCommands.length > 0) {
    return {
      code: 'claude_code_init_failed',
      message:
        `--disable-slash-commands did not take: ${slashCommands.length} slash command(s) are loaded ` +
        `(${slashCommands.slice(0, 5).join(', ')})`,
    };
  }
  const skills = Array.isArray(init.skills) ? init.skills : [];
  if (skills.length > 0) {
    return {
      code: 'claude_code_init_failed',
      message:
        `--disable-slash-commands did not take: ${skills.length} skill(s) are loaded ` +
        `(${skills.slice(0, 5).join(', ')})`,
    };
  }
  if (init.memory_paths !== undefined) {
    return {
      code: 'claude_code_init_failed',
      message:
        '--restricted did not take: the init event reports memory_paths, so auto-memory is on ' +
        'and the CLI will read files outside the step directory',
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
 * Remove the OAuth token from text bound for a log, an error or the archive.
 *
 * Cheap insurance on the one value whose whole security model is "it never
 * leaves the child's environment".
 */
export function redactToken(text: string, token: string): string {
  if (!text || !token || token.length < 8) return text;
  return text.split(token).join('[REDACTED:CLAUDE_CODE_OAUTH_TOKEN]');
}

/** Is this `rate_limit_info` telling us the subscription is capped out? */
export function isRateLimited(rateLimit: AnyObject | null | undefined): boolean {
  if (!rateLimit) return false;
  const status = typeof rateLimit.status === 'string' ? rateLimit.status : '';
  // `allowed` is the healthy value; anything else (`rejected`,
  // `allowed_warning` escalating, …) means the window is closing or closed.
  if (status && status !== 'allowed' && status !== 'allowed_warning') return true;
  // Overage explicitly refused with the primary window exhausted.
  const util = num(rateLimit.unifiedWindows?.five_hour?.utilization);
  return rateLimit.overageStatus === 'rejected' && util >= 1;
}

/** Does this text look like Anthropic refusing on quota rather than auth? */
export function looksLikeRateLimit(text: string): boolean {
  if (!text) return false;
  return (
    /\b429\b/.test(text) ||
    /rate[ _-]?limit/i.test(text) ||
    /usage limit reached/i.test(text) ||
    /\bquota\b[^\n]{0,40}\b(exceeded|exhausted)\b/i.test(text)
  );
}

/** One-line description of the rate-limit window for an operator. */
export function describeRateLimit(rateLimit: AnyObject | null | undefined): string {
  if (!rateLimit) return 'no rate_limit_event was received';
  const parts = [`status=${rateLimit.status ?? 'unknown'}`];
  const five = rateLimit.unifiedWindows?.five_hour?.utilization;
  const seven = rateLimit.unifiedWindows?.seven_day?.utilization;
  if (five !== undefined) parts.push(`5h=${five}`);
  if (seven !== undefined) parts.push(`7d=${seven}`);
  if (rateLimit.resetsAt) parts.push(`resetsAt=${rateLimit.resetsAt}`);
  if (rateLimit.overageStatus) parts.push(`overage=${rateLimit.overageStatus}`);
  return parts.join(' ');
}

/**
 * Does this text look like Anthropic rejecting the token?
 *
 * `apiKeySource` cannot answer this — it reads `"none"` on a perfectly healthy
 * subscription run (16-phase0-smoke.md §8.1), so the detector keys on the CLI's
 * own 401 text and on a bare 401 status instead.
 *
 * Only ever run over STDERR. The model's own text is steerable by untrusted
 * workspace instructions, and a model that can choose the platform's error
 * code can manufacture "rotate the token" pages on demand.
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

  // The CLI is the whole node's turn: stream whenever the node asked for it.
  //
  // This used to skip nodes named `respond`/`responder`, on the theory that
  // `functions/run.ts` already forwards `on_llm_stream` for those two names.
  // It does — but ONLY for a LangChain model, and a `claude-code` neuron never
  // builds one (this executor is dispatched before `getModel()`). So every
  // claude-code chat node — and `responder` is the name the stock chat graphs
  // use — published nothing live, and the run's `on_chain_end` backstop then
  // replayed the finished answer ONE CHARACTER AT A TIME, seconds late and
  // lossy: 1 of 152 characters in the worst observed turn (report 39, D1).
  // Streaming here suppresses that backstop (it checks `output.content`) and
  // makes the claude-code event sequence identical to every other provider's.
  const streamToUser = config.stream === true;

  // ── the step's private directory ─────────────────────────────────────────
  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  // Before creating ours, clear out anything a previously-killed worker left
  // behind — those directories can contain a CLAUDE_CONFIG_DIR the CLI wrote
  // the OAuth token into. Once per process, age-gated.
  sweepStaleRunDirs();
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
  let spawnedPgid: number | null = null;

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
    // The queue wait comes out of the step's own budget: a step cannot
    // usefully wait longer than its own deadline, and time spent queued is
    // time the caller has already granted. `CLAUDE_CODE_QUEUE_WAIT_MS` can cap
    // it tighter (fail fast and let the graph retry elsewhere) but never
    // looser.
    const queueBudgetMs = Math.min(timeoutMs, queueWaitMs(timeoutMs));
    const queueStartedAt = Date.now();
    await acquireSlot(abortSignal, queueBudgetMs);
    slotHeld = true;
    const queuedMs = Date.now() - queueStartedAt;

    // Whatever is left of the wall clock after queueing. A step that spent its
    // whole budget waiting must not now spawn a real CLI child.
    const runTimeoutMs = timeoutMs - queuedMs;
    if (runTimeoutMs <= 0) {
      throw new ClaudeCodeError(
        'claude_code_queue_timeout',
        `claude-code step '${stepId}' spent its entire ${timeoutMs} ms budget queued for a slot`,
      );
    }
    if (queuedMs > 1000) {
      console.warn(`[ClaudeCode] step '${stepId}' waited ${queuedMs} ms for a slot`);
    }

    // Re-check liveness AFTER queueing. The run may have been cancelled, timed
    // out at the worker, or otherwise gone terminal while this step sat in the
    // queue — and the whole point of the check is to not spend subscription
    // quota on an answer nobody will read.
    if (abortSignal?.aborted) {
      throw abortError(`claude-code step '${stepId}' aborted while queued for a slot`);
    }
    // `wasCancelled` consults the tombstone, so it still answers correctly
    // after the run context has been unregistered — which is exactly the state
    // a step that queued through its run's own death finds itself in.
    if (runControlRegistry.wasCancelled(runId)) {
      throw abortError(`claude-code step '${stepId}' was cancelled while queued for a slot`);
    }
    if (queuedMs > 0 && publisher?.getState) {
      try {
        const queuedRunState = await publisher.getState();
        const queuedStatus = queuedRunState?.status;
        if (typeof queuedStatus === 'string' && TERMINAL_RUN_STATUSES.has(queuedStatus)) {
          throw abortError(
            `claude-code step '${stepId}' not started: run went ${queuedStatus} while queued`,
          );
        }
      } catch (err) {
        // A terminal-status abort must propagate; a Redis hiccup must not.
        if ((err as AnyObject)?.name === 'AbortError') throw err;
      }
    }

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

    // `--json-schema` is an argv value like `--system-prompt`, so it is under
    // the same MAX_ARG_STRLEN ceiling. Unlike the system prompt there is no
    // stdin fallback to fold it into, so an oversized schema is a
    // configuration error rather than something to work around silently.
    let jsonSchemaArg: string | undefined;
    if (config.structuredOutput) {
      jsonSchemaArg = JSON.stringify(config.structuredOutput.schema);
      const schemaBytes = Buffer.byteLength(jsonSchemaArg, 'utf8');
      if (schemaBytes > MAX_JSON_SCHEMA_ARG_BYTES) {
        throw new ClaudeCodeError(
          'claude_code_schema_too_large',
          `structuredOutput schema is ${schemaBytes} bytes; the CLI takes it as a single ` +
            `argv value, capped at ${MAX_JSON_SCHEMA_ARG_BYTES}`,
        );
      }
    }

    const args = buildSpawnArgs({
      model,
      effort: resolveEffort(state, neuronCfg),
      mcpConfigPath,
      sessionId: uuidv5(`${runId}:${stepId}`),
      resumeSessionId: resolveResumeSessionId(config, state, stepId),
      maxTurns,
      systemPrompt: systemFitsInArgv ? systemPrompt : undefined,
      jsonSchema: jsonSchemaArg,
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

    // Track the group so a dying worker takes the CLI with it. `detached`
    // otherwise reparents the child to init with the OAuth token still in its
    // environment; a worker deploy severs in-flight runs as a matter of
    // routine, so this path is ordinary, not exotic.
    if (child.pid) {
      installExitHooks();
      livePgids.add(child.pid);
      spawnedPgid = child.pid;
    }

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
      requestKill(`wall-clock timeout after ${runTimeoutMs} ms`);
    }, runTimeoutMs);
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

    // ── ORDERING ───────────────────────────────────────────────────────────
    // `RunPublisher.chunk` awaits a Redis publish (and, on the first chunk of
    // a segment, a `startMessage` round trip) BEFORE it forwards the
    // `content_chunk` to the conversation channel. Firing those calls off in
    // parallel — one per stream-json line, which is what this used to do —
    // makes the conversation's event order the order those awaits happen to
    // resolve in, not the order the model produced the text. Under real Redis
    // latency that reorders adjacent chunks: a live redChat turn came back as
    // an exact PERMUTATION of the right answer ("…standoffish soundal kingdom
    // cr in the animest nossed with the polit…") — same characters, right
    // count, wrong order.
    //
    // So every publish this step makes goes through one serial chain: the next
    // call is not even made until the previous one has resolved. Text and
    // thinking share the chain so their interleaving is preserved too. The
    // chain is awaited before the step finalises, so nothing is still in
    // flight when the run completes.
    let publishChain: Promise<void> = Promise.resolve();
    const enqueuePublish = (publish: () => unknown, label: string): void => {
      publishChain = publishChain.then(async () => {
        try {
          await publish();
        } catch (err) {
          console.warn(`[ClaudeCode] ${label} publish failed:`, err);
        }
      });
    };

    const handler = createStreamHandler({
      onText: streamToUser && publisher?.chunk
        ? (text) => enqueuePublish(() => publisher.chunk(text), 'chunk')
        : undefined,
      onThinking: streamToUser && publisher?.thinkingChunk
        ? (text) => enqueuePublish(() => publisher.thinkingChunk(text), 'thinkingChunk')
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

    // stderr is quoted verbatim into thrown errors, which reach the run
    // record, the archive and an ops DM. The CLI has no business echoing its
    // own token, but "no business" is not a guarantee, and this is the one
    // place a token could ride out of an env allowlist into a log.
    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = redactToken(stderrTail + chunk, oauthToken).slice(-STDERR_TAIL_BYTES);
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
        `claude-code step '${stepId}' exceeded ${runTimeoutMs} ms of run time ` +
          `(of a ${timeoutMs} ms budget) and was killed`,
      );
    }
    if (ctl.killReason && !handler.state.result) {
      throw abortError(`claude-code step '${stepId}' stopped: ${ctl.killReason}`);
    }

    // No init event at all.
    //
    // `onInit` only runs if one actually arrived, so a stream that never emits
    // one skips every assertion above — no tool check, no `apiKeySource`
    // check — and a lone `result` would otherwise be accepted as a clean run.
    // A guard is only a guard if its ABSENCE is a failure too.
    //
    // Checked after the timeout and cancel branches on purpose: those are more
    // specific diagnoses of the same missing stream, and reporting "no init
    // event" for a run the operator cancelled would send them looking in the
    // wrong place.
    if (!handler.state.init) {
      const failure = assertInitEvent(null, expectedTools);
      throw new ClaudeCodeError(
        failure!.code,
        `claude-code init guard rejected the session: ${failure!.message} ` +
          `(exit ${exit.code ?? 'null'}${exit.signal ? `, ${exit.signal}` : ''})`,
      );
    }

    const result = handler.state.result;
    if (!result) {
      const tail = stderrTail.trim();
      if (isRateLimited(handler.state.rateLimit) || looksLikeRateLimit(tail)) {
        throw new ClaudeCodeError(
          'claude_code_rate_limited',
          `the shared Claude subscription is rate limited ` +
            `(${describeRateLimit(handler.state.rateLimit)}); the CLI exited without a result`,
        );
      }
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

    // Everything this step queued has been published, in order, before the
    // run is allowed to finish.
    await publishChain;

    // ── the answer and the stream must agree ───────────────────────────────
    // `result.result` is the authority on the final answer; the stream is what
    // the user has already seen. They normally agree exactly — a real CLI
    // capture has deltas, envelope and `result.result` identical character for
    // character — and when they do, nothing happens here.
    //
    // When they do NOT, the correction is a REPLACEMENT, never a splice. An
    // earlier version spliced the missing tail in as another chunk, which put
    // a second writer on a stream that already had one. `run_complete` carries
    // the run's output content as `finalContent`, and the chat client treats
    // that as the final word on the bubble, so setting it is the whole fix:
    // one event, no interleaving, no partial text competing with the answer.
    //
    // `published.endsWith(finalText)` is the agreement test rather than
    // equality because a tool turn legitimately streams a preamble before the
    // final message ("Let me check the time. " + the answer), and that whole
    // transcript is the correct content for the turn.
    if (streamToUser && typeof finalText === 'string' && finalText) {
      const published = handler.state.text;
      if (!published.endsWith(finalText)) {
        console.warn(
          `[ClaudeCode] step '${stepId}': the stream (${published.length} chars) does not end ` +
            `with the answer (${finalText.length} chars); replacing the run's final content`,
        );
        try {
          await publisher?.replaceOutputContent?.(finalText);
        } catch (err) {
          console.warn('[ClaudeCode] final content replacement failed:', err);
        }
      }
    }
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
      // Match ONLY against stderr, never `result.result`. That field is the
      // model's own text, and the model is steerable by workspace
      // instructions and tool output the platform did not write — so letting
      // it decide the error code lets an untrusted tree fabricate
      // "rotate the token" ops pages at will. stderr comes from the CLI.
      if (looksLikeAuthFailure(stderrTail)) {
        throw new ClaudeCodeError(
          'claude_code_auth_401',
          `Anthropic rejected the subscription token — rotate the 'claude-code-oauth' secret. ` +
            `${stderrTail.trim() || '(no stderr)'}`,
        );
      }
      // A capped-out subscription is an operational condition with its own
      // remedy (wait for the window, or raise the plan) and deserves its own
      // code rather than being buried in the generic failure.
      if (isRateLimited(handler.state.rateLimit) || looksLikeRateLimit(stderrTail)) {
        throw new ClaudeCodeError(
          'claude_code_rate_limited',
          `the shared Claude subscription is rate limited (${describeRateLimit(handler.state.rateLimit)}); ` +
            `claude-code step '${stepId}' could not complete`,
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

    // Structured output is a PARSED OBJECT for every other provider —
    // `withStructuredOutput` returns one, and the Ollama path JSON.parses the
    // content itself (`neuronExecutor.ts:533`, `:749`). Returning the raw
    // string here would make `{{state.data.plan.steps}}` silently resolve to
    // nothing for `claude-code` alone, which is the kind of difference that
    // only shows up in a graph someone already shipped.
    let output: unknown = finalText;
    if (config.structuredOutput && typeof finalText === 'string') {
      try {
        output = JSON.parse(finalText);
      } catch (err) {
        throw new ClaudeCodeError(
          'claude_code_bad_structured_output',
          `step '${stepId}' declares structuredOutput but the CLI returned text that is not ` +
            `JSON (${err instanceof Error ? err.message : String(err)}): ` +
            `${finalText.slice(0, 200)}`,
        );
      }
    }

    // Write in place so later steps of the SAME node can read it, and return
    // the flat key so the value survives the LangGraph reducer.
    const cliBag: AnyObject = { ...(state?.data?._cli ?? {}), [stepId]: cli };
    if (state?.data && typeof state.data === 'object') state.data._cli = cliBag;

    return { [stepId]: output, 'data._cli': cliBag };
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
    // And the run's own directory, which is this step's parent. `rmdir`
    // (not `rm -rf`) on purpose: it succeeds only when the directory is
    // empty, so the LAST step of a run tidies up and a concurrent sibling
    // step's directory is never taken out from under it.
    try {
      fs.rmdirSync(path.dirname(dir));
    } catch {
      /* not empty (a sibling step is still running), or already gone */
    }
    if (spawnedPgid !== null) livePgids.delete(spawnedPgid);
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
