/**
 * `agy-cli` neuron executor — an Antigravity CLI child, not a chat model.
 *
 * # What this is
 *
 * The sibling of `claudeCodeExecutor`. A neuron whose `provider` is `agy-cli`
 * is not an HTTP model endpoint: it is an `agy -p` process spawned as a child
 * of THIS neuron step, authenticated with George's Antigravity **subscription**
 * rather than a metered Gemini API key. The CLI runs its own agent loop; the
 * only tools it can reach are the run's own tools, served over the per-run
 * Unix-socket MCP bridge (`lib/mcp/run-bridge.ts`) under the run's capability
 * profile — the same bridge the `claude-code` provider uses, unmodified.
 *
 * It exists so that graphs which want a cheap, fast reasoning model can run
 * Gemini 3.8 Flash on a flat-rate subscription instead of paying per token, and
 * fall back to a metered neuron (`fallbackNeuronId`) only when the subscription
 * is capped out.
 *
 * # Why a separate executor and not a flag on the claude-code one
 *
 * The two CLIs agree on the *shape* of the problem and on almost nothing else.
 * Everything below was VERIFIED live against agy 1.1.27 on 2026-09-08; the
 * differences are why this file exists rather than a `if (provider === …)`
 * inside a 2 000-line executor that the platform's default neuron depends on.
 *
 *   | concern        | `claude`                      | `agy`                          |
 *   |----------------|-------------------------------|--------------------------------|
 *   | MCP config     | `--mcp-config <path>`         | NO FLAG — read from `$HOME`    |
 *   | tool gate      | `--tools ""` + `--allowedTools`| the permission engine          |
 *   | tool names     | `mcp__redbtn__<tool>`         | one meta-tool `call_mcp_tool`  |
 *   | system prompt  | `--system-prompt` / stdin     | NO FLAG — folded into the turn |
 *   | prompt input   | argv or stdin                 | NDJSON on stdin, `stream-json` |
 *   | max turns      | `--max-turns`                 | none                           |
 *   | effort         | low…max                       | low/medium/high, model-dependent|
 *   | credential     | an env var                    | a FILE the CLI rewrites        |
 *
 * Each of those is load-bearing below.
 *
 * # The security contract
 *
 * 1. **Child env is an ALLOWLIST**, built from nothing. `MONGODB_URI`,
 *    `REDIS_URL`, `INTERNAL_SERVICE_KEY` and `WEBAPP_URL` never reach the
 *    child — and neither do `GEMINI_API_KEY`, `GOOGLE_API_KEY` or
 *    `GOOGLE_GEMINI_BASE_URL`, which this CLI reads. That last group is not
 *    hygiene: a leaked `GEMINI_API_KEY` would silently move the step onto the
 *    metered API, which is the exact bill this provider exists to avoid.
 *    See `buildAgyChildEnv()`; it is the whole story and is unit-tested.
 *
 * 2. **Deny-by-default is the CLI's own behaviour in print mode, and it is the
 *    gate.** VERIFIED: with no permission grants at all, `agy -p` auto-denies
 *    every tool that needs a permission — `command`, `write_file`, `read_file`,
 *    `read_url`, `mcp` — ends the turn, and reports `denied_actions` in the
 *    result envelope. Nothing ran; no file was created. So the executor grants
 *    exactly ONE thing, `mcp(<bridge>/*)`, and everything else stays denied by
 *    the CLI's own default. VERIFIED with that grant in place: the bridge tool
 *    call succeeds, and `run_command` / `write_to_file` / `view_file` are still
 *    auto-denied with no side effects.
 *
 *    An explicit `deny` list is deliberately NOT used. VERIFIED: an explicit
 *    deny is reported to the model as a refusal it can react to, and the model
 *    then RETRIES — one such run burned 165 673 input and 13 529 output tokens
 *    against the print timeout before giving up. The headless auto-deny ends
 *    the turn immediately (~3 s). Failing fast is both safer and cheaper, so
 *    the allowlist is the only rule and the default does the denying.
 *
 * 3. **`denied_actions` is never swallowed.** It means the CLI reached for a
 *    tool the policy refuses, which is a security event: it is logged, audited
 *    onto the run record, and — when the step produced no output because of it
 *    — fails the step with `agy_tool_denied` rather than returning empty text.
 *
 * 4. **No settings, no rules, no AGENTS.md.** The cwd is an empty per-run
 *    placeholder, because this CLI auto-discovers `GEMINI.md`, `AGENTS.md` and
 *    `.agents/rules/*.md` from the working directory, and nothing from an
 *    untrusted tree may become instructions here. `--disable-slash-commands`
 *    strips the bundled command/skill surface; `--sandbox` adds the CLI's own
 *    terminal restrictions on top of a command permission that is already
 *    denied.
 *
 * 5. **`--dangerously-skip-permissions` is never passed.** It is the CLI's
 *    documented escape from headless deny-by-default and would auto-approve
 *    every built-in tool. `buildAgySpawnArgs` is pure so a unit test can assert
 *    its absence.
 *
 * 6. **Nothing is left on disk.** The per-run directory — which holds the
 *    private `HOME`, the bridge socket, the MCP config and the materialised
 *    OAuth token — is removed in `finally`.
 *
 * # How the prompt reaches the CLI
 *
 * On stdin, as ONE NDJSON message, never as an argument.
 *
 * `agy` has no `--system-prompt` flag, so the system prompt is delimited inside
 * the single turn the CLI is given. The first cut of this provider then passed
 * that turn as the `-p` argv value, which put it under Linux's
 * `MAX_ARG_STRLEN` (128 KiB) and made every prompt over 100 KB a hard failure —
 * a ceiling the Gemini API itself does not have.
 *
 * `--input-format stream-json` removes it. VERIFIED live against agy 1.1.27 on
 * 2026-09-08:
 *
 *   - the CLI is put in print mode with an EMPTY prompt (`-p=`, one token —
 *     `-p` followed by another flag makes it swallow that flag as the prompt,
 *     and a bare `-p` is "flag needs an argument");
 *   - it then reads one NDJSON message per line from stdin:
 *     `{"event":"user","message":{"role":"user","content":"<the whole turn>"}}`
 *     (the key is `event`, NOT `type` — `type` is rejected with
 *     `stream input message is missing the "event" field`);
 *   - one message runs one turn, and closing stdin ends the process;
 *   - `--input-format stream-json` REQUIRES `--output-format stream-json`,
 *     which emits `init`, then a `step_update` per step, then exactly one
 *     `{"event":"result","result":{…}}` whose payload is byte-for-byte the
 *     envelope `--output-format json` used to print — same `status`,
 *     `response`, `error`, `usage`, `denied_actions`, `structured_output`.
 *
 * The remaining ceiling is the CLI's own, and it is NOT an error: past its
 * prompt-token budget `agy` silently truncates the turn and still reports
 * `status: SUCCESS`. VERIFIED: 190 081 bytes of prose arrives whole (the model
 * answers a question buried at the end); 200 056 bytes comes back with "the
 * document was truncated before the end". That is a warning here, not a
 * refusal, because it is the model's budget rather than the transport's.
 *
 * # The credential, and why there is a persistent state directory
 *
 * `claude` takes its subscription token as an environment variable. `agy` does
 * not: it reads `$HOME/.gemini/antigravity-cli/antigravity-oauth-token`, and it
 * REWRITES that file when the token refreshes. A purely per-run `HOME` would
 * therefore throw every refresh away and eventually strand the platform on an
 * expired credential.
 *
 * So the token lives in two places. The secret (`secretName` → `apiKey`, the
 * ordinary redsecrets path, exactly like `claude-code`) is the source of truth
 * on first use; `AGY_STATE_DIR` (default `/var/lib/redbtn/agy`) is a per-worker
 * cache that survives runs and holds whatever the CLI last refreshed. Each run
 * copies the newer of the two into its private `HOME`, and copies the token
 * back out if the CLI changed it, under a directory-mutex so two concurrent
 * steps cannot interleave a write.
 *
 * @module lib/nodes/universal/executors/agyCliExecutor
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { NeuronStepConfig } from '../types';
import { AGY_EFFORT_LEVELS, DEFAULT_AGY_EFFORT } from '../../../types/neuron';
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
// Pure helpers, shared rather than copied. Importing them keeps ONE definition
// of "make this string safe as a path segment" and "derive a stable id from
// (runId, stepId)" in the tree; neither function reads or writes anything the
// `claude-code` executor owns, so sharing them cannot destabilise it.
import { sanitizeSegment, runDirRoot } from './claudeCodeExecutor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// =============================================================================
// Constants
// =============================================================================

/** Wall-clock ceiling for one CLI child when the step does not set one. */
export const DEFAULT_TIMEOUT_MS = 1_800_000;

/** Grace between SIGTERM and SIGKILL. */
export const SIGKILL_GRACE_MS = 10_000;

/** How often the executor re-reads the run record. See the claude-code twin. */
export const RUN_POLL_INTERVAL_MS = 60_000;

/**
 * Ceiling on the prompt.
 *
 * NOT an argv limit. The prompt is written to the child's stdin as one NDJSON
 * message, so Linux's `MAX_ARG_STRLEN` does not apply to it and the 100 KiB cap
 * this provider shipped with is gone — the API it fronts has no such limit.
 *
 * What remains is a sanity bound: a prompt no model could read should be
 * refused before a turn is spent, rather than streamed into a pipe. 4 MiB is
 * comfortably above the largest context any model this CLI drives accepts.
 */
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;

/**
 * Where `agy` starts SILENTLY truncating, so a large prompt gets a log line.
 *
 * VERIFIED live (gemini-3.8-flash, 2026-09-08): a 190 081 byte prompt is read
 * whole — the model answers a question placed after the last byte of a long
 * document. At 200 056 bytes the same prompt comes back "truncated before the
 * end", with `status: SUCCESS` and no error anywhere. The cut is the CLI's own
 * prompt-token budget (~69 k input tokens, including its ~14 k of built-in
 * instructions), not the transport, so it is warned about rather than refused:
 * a smaller model or a longer system prompt moves it.
 */
export const PROMPT_TRUNCATION_WARN_BYTES = 190 * 1024;

/**
 * `--json-schema` ceiling. This one IS still an argv value, so `MAX_ARG_STRLEN`
 * still applies to it and the reasoning that produced 100 KiB still holds.
 */
export const MAX_JSON_SCHEMA_ARG_BYTES = 100 * 1024;

/** Bytes of stderr kept for the error message on a failure. */
export const STDERR_TAIL_BYTES = 2048;

/**
 * Cap on stdout, so a wedged child cannot OOM the worker.
 *
 * `stream-json` writes more than `json` did — an `init` line, then a
 * `step_update` per step carrying that step's text delta — so this holds the
 * whole NDJSON stream, not just one envelope. 32 MiB is still far past any turn
 * a neuron step should produce.
 */
export const MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/**
 * `--effort` levels this CLI accepts.
 *
 * VERIFIED live: `--effort xhigh` is refused with `invalid --effort "xhigh"
 * (valid: low, medium, high)`. This is a strict SUBSET of the Claude Code
 * levels, which is why `agy-cli` cannot simply reuse `CLAUDE_CODE_EFFORT_LEVELS`
 * and why a neuron doc carrying `effort: 'xhigh'` (legal for a `claude-code`
 * neuron, and legal in the shared Mongoose enum) must be degraded here rather
 * than passed through.
 */
export const EFFORT_LEVELS: ReadonlySet<string> = new Set(AGY_EFFORT_LEVELS);

/**
 * How a model relates to `--effort`. VERIFIED for every entry below.
 *
 *   - `required`    — omitting it fails: `--model gemini-3.8-flash requires
 *                     --effort (available: low, medium, high)`.
 *   - `optional`    — the id already names a level; passing one as well is
 *                     accepted and wins.
 *   - `unsupported` — passing it fails: `--effort is not supported for model
 *                     "claude-sonnet-4-6"`.
 *
 * Getting this wrong is not a soft failure: the CLI refuses the whole run at
 * argument-parse time, before a conversation exists, so the step dies with a
 * confusing message two seconds in. That is why it is a table and not a guess.
 */
export type AgyEffortMode = 'required' | 'optional' | 'unsupported';

/**
 * The models `agy models` lists, plus the bare aliases that resolve to them.
 *
 * Read off `agy models` on 1.1.27, 2026-09-08. The bare `gemini-3.x-flash` /
 * `gemini-3.1-pro` aliases are NOT in that listing but are accepted by
 * `--model` and are the ergonomic way to name a model whose effort the neuron
 * sets separately, so they are first-class here.
 *
 * A closed table rather than a pattern because the CLI's own error for an
 * unknown model is a 15-line dump of the whole catalogue, and because a neuron
 * that names a model the CLI cannot run should fail at config-validation time
 * with a readable message instead.
 */
export const AGY_MODELS: ReadonlyMap<string, AgyEffortMode> = new Map<string, AgyEffortMode>([
  ['gemini-3.8-flash', 'required'],
  ['gemini-3.8-flash-high', 'optional'],
  ['gemini-3.8-flash-medium', 'optional'],
  ['gemini-3.8-flash-low', 'optional'],
  ['gemini-3.7-flash', 'required'],
  ['gemini-3.7-flash-high', 'optional'],
  ['gemini-3.7-flash-medium', 'optional'],
  ['gemini-3.7-flash-low', 'optional'],
  ['gemini-3.6-flash', 'required'],
  ['gemini-3.6-flash-high', 'optional'],
  ['gemini-3.6-flash-medium', 'optional'],
  ['gemini-3.6-flash-low', 'optional'],
  ['gemini-3.1-pro', 'required'],
  ['gemini-3.1-pro-high', 'optional'],
  ['gemini-3.1-pro-low', 'optional'],
  ['claude-sonnet-4-6', 'unsupported'],
  ['claude-opus-4-6-thinking', 'unsupported'],
  ['gpt-oss-120b-medium', 'unsupported'],
]);

/** Fallback when an `agy-cli` neuron doc somehow carries no model. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';

/**
 * The ONE permission grant the child gets. See §2 of the module comment.
 *
 * `mcp(<server>/*)` is the CLI's own grant syntax; the server name is the
 * bridge's, so a rename of `BRIDGE_SERVER_NAME` cannot silently un-grant it.
 */
export function bridgeGrant(): string {
  return `mcp(${BRIDGE_SERVER_NAME}/*)`;
}

/**
 * Per-worker directory holding the refreshable OAuth token.
 *
 * Read at call time, not at import time, so a test can point it elsewhere
 * without reloading the module.
 */
export function agyStateDir(): string {
  return process.env.AGY_STATE_DIR || '/var/lib/redbtn/agy';
}

/** Mount point every workspace container uses; the worker cwd mirrors it. */
const WS_ROOT = '/ws';

/** Workspace name used when the run carries no workspace. */
const DEFAULT_WS_NAME = 'workspace';

/**
 * Fixed preamble prepended to every system prompt.
 *
 * Different from the `claude-code` one in the only way that matters: this CLI
 * does not surface MCP tools as top-level functions. VERIFIED — the model is
 * offered a single meta-tool, `call_mcp_tool`, and the bridge's tools are
 * discovered through it (asked to list what it can reach, the model answered
 * "redbtn: now"). Telling it the server name up front is what turns that
 * discovery into a first-turn tool call instead of an exploration.
 */
export const BRIDGE_PREAMBLE =
  `Your only tools are the tools of the '${BRIDGE_SERVER_NAME}' MCP server, reached with ` +
  `call_mcp_tool; they act on the workspace machine at %TREE%. Every built-in tool you ` +
  'appear to have — shell, file read/write, web fetch, browser — is denied by policy and ' +
  'will fail without running. You have no local filesystem, shell, or network.';

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
 * Codes, and whether `neuronFallback` treats them as "a different neuron would
 * have answered" (see `AGY_FALLBACK_CODES` there):
 *
 *   - `agy_no_token`              — no credential resolved.            NO hop.
 *   - `agy_bad_model`             — the neuron names a model the CLI
 *                                   cannot run.                        NO hop.
 *   - `agy_prompt_too_large`      — the prompt is past the sanity
 *                                   bound; no transport would help.     NO hop.
 *   - `agy_schema_too_large`      — same, for `--json-schema`.          NO hop.
 *   - `agy_bad_structured_output` — the CLI returned non-JSON for a
 *                                   step that declared a schema.        NO hop.
 *   - `agy_tool_denied`           — the policy refused a tool and the
 *                                   turn produced nothing. A security
 *                                   event.                              NO hop.
 *   - `agy_auth_required`         — the subscription needs an
 *                                   interactive Google login. Surfaced,
 *                                   never hidden behind a fallback.     NO hop.
 *   - `agy_spawn_failed`          — the CLI is not installed here.     hop.
 *   - `agy_rate_limited`          — the subscription is capped out.    hop.
 *   - `agy_queue_timeout`         — never got one of this worker's
 *                                   CLI slots.                          hop.
 *   - `agy_timeout`               — wall clock or `--print-timeout`.   hop.
 *   - `agy_failed`                — exited without a parseable result. hop.
 *   - `agy_error_result`          — the envelope reported `ERROR`.     hop.
 */
export class AgyCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AgyCliError';
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
 * `agy` is a ~210 MB binary whose resident set is far smaller than the Claude
 * CLI's node process, and a Flash turn is seconds rather than minutes, so the
 * default here is 2 where `claude-code`'s is 1. The limit is read at acquire
 * time so RedRun can change it without a code change.
 */
let activeChildren = 0;
const waiters: Array<() => void> = [];

export function maxConcurrent(): number {
  const raw = Number.parseInt(process.env.AGY_CLI_MAX_CONCURRENT || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2;
}

/** How long a step may wait for a slot. Defaults to its whole budget. */
export function queueWaitMs(timeoutMs: number): number {
  const raw = Number.parseInt(process.env.AGY_CLI_QUEUE_WAIT_MS || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : timeoutMs;
}

/**
 * Wait for a slot, but never past `maxWaitMs`.
 *
 * An unbounded wait is a queue with no failure mode: a queued step would sit
 * until the WORKER's own job race failed it, and this executor would then
 * acquire the slot and spend subscription quota on a run that is already
 * terminal. Failing with a distinct code is the honest answer.
 */
async function acquireSlot(abortSignal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
  if (abortSignal?.aborted) throw abortError('Run aborted before agy-cli slot acquired');
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
      reject(abortError('Run aborted while queued for an agy-cli slot'));
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
        new AgyCliError(
          'agy_queue_timeout',
          `waited ${maxWaitMs} ms for one of ${maxConcurrent()} agy-cli slot(s) on this ` +
            `worker and never got one; raise AGY_CLI_MAX_CONCURRENT or add workers`,
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

/** Test-only: current occupancy of the worker-wide semaphore. */
export function __agySlotsInUse(): number {
  return activeChildren;
}

// =============================================================================
// Live children: surviving the worker's own death
// =============================================================================

/**
 * Process-group ids of CLI children this process started and has not reaped.
 *
 * `detached: true` is what makes the group kill possible, but it also means the
 * CLI is NOT killed when the worker dies — it is reparented to init, still
 * holding a live Google OAuth credential on its private `HOME` and still
 * spending subscription quota on a run nobody is listening to. A worker deploy
 * severs in-flight runs routinely, so this is the common case.
 */
const livePgids = new Set<number>();

let exitHooksInstalled = false;

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

/** Install the worker-death hooks once. Re-raises so shutdown is not swallowed. */
function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  process.on('exit', () => killAllLiveChildren('SIGKILL'));

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      killAllLiveChildren('SIGTERM');
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  }
}

/** Test-only: pgids currently registered as live. */
export function __agyLiveChildCount(): number {
  return livePgids.size;
}

// =============================================================================
// Model and effort
// =============================================================================

/**
 * Validate the neuron's `model` for use as a `--model` value.
 *
 * Throws `agy_bad_model` rather than substituting: quietly running a different
 * model than the one the neuron advertises is worse than failing the step, and
 * on this CLI the "different model" could be Gemini 3.1 Pro, which is the
 * expensive thing this provider exists to stop paying for.
 */
export function resolveAgyModel(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_MODEL;
  if (typeof raw === 'string' && AGY_MODELS.has(raw)) return raw;
  const err = new AgyCliError(
    'agy_bad_model',
    `neuron model ${JSON.stringify(raw)} is not a model the agy CLI can run; ` +
      `known models: ${[...AGY_MODELS.keys()].join(', ')}`,
  );
  throw err;
}

/**
 * Resolve `--effort`, preferring the node's parameters over the neuron doc.
 *
 * Returns `undefined` when no `--effort` may be passed at all.
 *
 * Three rules, in order:
 *   1. A model that does not support effort never gets one, whatever the doc
 *      says. The doc is not wrong to carry `effort` — the same neuron shape is
 *      shared with `claude-code` — it is just not applicable to this model, and
 *      passing it would fail the run at argument-parse time.
 *   2. An unknown level (`xhigh`, `max` — legal for `claude-code`, and legal in
 *      the shared Mongoose enum) is dropped with a warning rather than throwing:
 *      effort does not change WHICH model runs, so degrading is proportionate.
 *   3. When nothing names a usable level and the model requires one, the
 *      default applies. `high` rather than the CLI's own choice: these neurons
 *      exist to spend a flat-rate subscription, and a step that wants it
 *      cheaper says so.
 */
export function resolveAgyEffort(
  state: AnyObject,
  neuronCfg: AnyObject,
  mode: AgyEffortMode,
): string | undefined {
  if (mode === 'unsupported') {
    const named = state?.parameters?.effort ?? neuronCfg?.parameters?.effort;
    if (typeof named === 'string' && named) {
      console.warn(
        `[AgyCli] ignoring --effort "${named}": this model does not accept one`,
      );
    }
    return undefined;
  }
  const candidates = [state?.parameters?.effort, neuronCfg?.parameters?.effort];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate) continue;
    if (EFFORT_LEVELS.has(candidate)) return candidate;
    console.warn(
      `[AgyCli] ignoring unknown --effort level "${candidate}" ` +
        `(agy knows: ${[...EFFORT_LEVELS].join(', ')})`,
    );
  }
  return DEFAULT_AGY_EFFORT;
}

// =============================================================================
// The private HOME
// =============================================================================

/**
 * Where the model believes it is working. Identical rules to the claude-code
 * twin: a validated slug, and a supplied `tree` that must live under the mount
 * the slug already fixed (`/etc/cron.d` starts with a slash too).
 */
export function resolveWorkspaceMount(state: AnyObject): { name: string; tree: string } {
  const ws = state?.data?.ws;
  const rawName =
    (typeof ws?.name === 'string' && ws.name) ||
    (typeof state?.data?.workspaceName === 'string' && state.data.workspaceName) ||
    '';
  const name = rawName && /^[a-z0-9][a-z0-9-]{1,62}$/.test(rawName) ? rawName : DEFAULT_WS_NAME;
  const canonical = `${WS_ROOT}/${name}/tree`;
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
      `[AgyCli] ignoring workspace tree ${JSON.stringify(supplied)}: it is not under ${prefix}`,
    );
  }
  return { name, tree: acceptable ? supplied : canonical };
}

/**
 * The child's ENTIRE environment. An allowlist, built from nothing.
 *
 * Two groups matter, for different reasons:
 *
 *   - The worker's own credentials (`MONGODB_URI`, `REDIS_URL`,
 *     `INTERNAL_SERVICE_KEY`, `WEBAPP_URL`) must not reach a process the model
 *     can read `/proc/self/environ` from. Same rule as `claude-code`.
 *   - `GEMINI_API_KEY`, `GOOGLE_API_KEY` and `GOOGLE_GEMINI_BASE_URL` are read
 *     by THIS CLI. If one leaked in, the step could silently run on the metered
 *     API — the bill this whole provider exists to avoid — while still looking
 *     like a subscription run. Building the env from nothing is what makes that
 *     impossible rather than merely unlikely.
 *
 * `HOME` is the load-bearing entry: it is where the CLI finds its OAuth token,
 * its MCP config and its permission grants, because none of the three has a
 * command-line flag.
 */
export function buildAgyChildEnv(params: {
  home: string;
  dir: string;
  parentEnv?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const parent = params.parentEnv ?? process.env;
  return {
    PATH: parent.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: params.home,
    TMPDIR: params.dir,
    XDG_CONFIG_HOME: path.join(params.home, '.config'),
    XDG_CACHE_HOME: path.join(params.home, '.cache'),
    LANG: parent.LANG || 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
}

/**
 * The files the CLI reads out of `HOME`, and the exact paths it reads them at.
 *
 * All four locations were established empirically, and two of them are not
 * where an obvious reading of the layout would put them:
 *
 *   - The MCP config the CLI actually loads is `.gemini/config/mcp_config.json`.
 *     There is ALSO a `.gemini/antigravity-cli/mcp_config.json`; writing the
 *     servers there has no effect (`agy mcp list` reports none). Confirmed by
 *     running `agy mcp add` and diffing the tree.
 *   - Permission grants are `userSettings.globalPermissionGrants` inside
 *     `.gemini/config/config.json`. Not `settings.json`, not `permissions`, and
 *     not the `.gemini/policies/*.toml` files — those belong to the older
 *     Gemini CLI and this binary ignores them. Confirmed from the CLI's own log
 *     line, which reports `stored shared config permissions: allow=N deny=N
 *     ask=N from <that path>` once the key is right and `permissions=<nil>`
 *     while it is not.
 */
export const AGY_HOME_PATHS = {
  token: '.gemini/antigravity-cli/antigravity-oauth-token',
  installationId: '.gemini/antigravity-cli/installation_id',
  mcpConfig: '.gemini/config/mcp_config.json',
  config: '.gemini/config/config.json',
  settings: '.gemini/settings.json',
} as const;

/**
 * Build the child's private `HOME`.
 *
 * Every directory is 0700 and every file 0600. The mode is not decoration: a
 * 0600 DIRECTORY breaks the CLI outright (it cannot create the log, brain and
 * conversation subdirectories it makes on first run), which is a failure mode
 * worth one comment rather than an afternoon.
 */
export function buildAgyHome(params: {
  home: string;
  token: string;
  installationId?: string;
  mcpConfig: Record<string, unknown>;
  grants?: string[];
}): void {
  const { home, token, installationId, mcpConfig } = params;
  const grants = params.grants ?? [bridgeGrant()];

  for (const rel of ['.gemini', '.gemini/antigravity-cli', '.gemini/config', '.config', '.cache']) {
    fs.mkdirSync(path.join(home, rel), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(home, rel), 0o700);
  }

  const write = (rel: string, body: string) => {
    const full = path.join(home, rel);
    fs.writeFileSync(full, body, { mode: 0o600 });
    fs.chmodSync(full, 0o600);
  };

  write(AGY_HOME_PATHS.token, token);
  // The installation id is optional — VERIFIED, the CLI generates one when it
  // is absent and the run succeeds. It is written when known anyway, so a
  // worker does not register a brand-new install on the account every run.
  if (installationId) write(AGY_HOME_PATHS.installationId, installationId);

  // The bridge's `mcpConfig` is written VERBATIM. It is the same object the
  // claude-code executor writes to `mcp.json`, and this CLI accepts it as-is:
  // VERIFIED that the `"type": "stdio"` key is tolerated and that the `env`
  // map (which carries the bridge nonce) is delivered to the server process.
  write(AGY_HOME_PATHS.mcpConfig, JSON.stringify(mcpConfig, null, 2));

  // The permission grants. `deny` and `ask` are deliberately EMPTY — see §2 of
  // the module comment: the CLI's headless auto-deny is both the safer and the
  // cheaper refusal, and an explicit deny makes the model retry.
  write(
    AGY_HOME_PATHS.config,
    JSON.stringify(
      { userSettings: { globalPermissionGrants: { allow: grants, deny: [], ask: [] } } },
      null,
      2,
    ),
  );

  // Not strictly required (VERIFIED: the CLI runs with no settings.json at
  // all), but naming the auth type keeps a future default flip from silently
  // choosing an API-key path for a subscription neuron.
  write(
    AGY_HOME_PATHS.settings,
    JSON.stringify(
      {
        security: { auth: { selectedType: 'oauth-personal' } },
        general: { defaultApprovalMode: 'default' },
        model: { name: '' },
      },
      null,
      2,
    ),
  );
}

// =============================================================================
// The persistent token cache
// =============================================================================

/** How long a state-directory lock may be held before it is treated as stale. */
export const STATE_LOCK_STALE_MS = 60_000;

/**
 * Run `fn` while holding a mutex on the state directory.
 *
 * `fs.mkdirSync` is the mutex: directory creation is atomic on every filesystem
 * the worker runs on, and Node has no `flock`. A lock older than
 * `STATE_LOCK_STALE_MS` is broken rather than waited on, because the process
 * that took it may have been SIGKILLed (an OOM, a deploy) and a token cache
 * that can deadlock is worse than one that can race.
 */
export async function withStateLock<T>(dir: string, fn: () => T | Promise<T>): Promise<T> {
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // it vanished between the two calls; try again
      }
      if (age > STATE_LOCK_STALE_MS) {
        console.warn(`[AgyCli] breaking a stale ${Math.round(age / 1000)}s lock at ${lock}`);
        try {
          fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          /* someone else broke it first */
        }
        continue;
      }
      if (Date.now() > deadline) {
        // Not fatal: the caller's fallback is to use the secret's own copy of
        // the token, which is correct, just not the freshest.
        throw new Error(`could not lock ${dir} within 5s`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.rmSync(lock, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * The token to start this run with.
 *
 * The secret is the source of truth for WHICH account is in play; the state
 * directory holds whatever the CLI last refreshed for that account. So the
 * cached copy is used only when it is a refresh OF THE SAME credential —
 * `sameAccount` compares the secret against the value the cache was seeded
 * from. Without that check, rotating the secret to a different account would be
 * silently undone by a stale cache on every worker.
 */
export function readCachedToken(dir: string, secretToken: string): string {
  try {
    const seed = fs.readFileSync(path.join(dir, 'seed.sha256'), 'utf8').trim();
    if (seed !== sha256(secretToken)) return secretToken; // the secret was rotated
    const cached = fs.readFileSync(path.join(dir, 'antigravity-oauth-token'), 'utf8');
    return cached.trim() ? cached : secretToken;
  } catch {
    return secretToken;
  }
}

/** Record `token` as the current cached credential for `secretToken`'s account. */
export function writeCachedToken(dir: string, secretToken: string, token: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const tmp = path.join(dir, `.tmp-${crypto.randomBytes(4).toString('hex')}`);
  fs.writeFileSync(tmp, token, { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, 'antigravity-oauth-token'));
  fs.writeFileSync(path.join(dir, 'seed.sha256'), sha256(secretToken), { mode: 0o600 });
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

// =============================================================================
// argv
// =============================================================================

export interface AgySpawnArgsInput {
  model: string;
  effort?: string;
  printTimeoutMs: number;
  jsonSchema?: string;
  conversationId?: string;
}

/**
 * Build the exact argv. Kept pure so the security-relevant shape is asserted in
 * a unit test rather than in a code review.
 *
 * There is no `prompt` here on purpose: the turn goes over stdin as one NDJSON
 * message (`buildAgyStdinMessage`), which is what removes the `MAX_ARG_STRLEN`
 * ceiling. See "How the prompt reaches the CLI" in the module comment.
 *
 * Notes on the flags that are here on purpose:
 *
 *   - `-p=` is ONE token: print mode with an empty inline prompt. `-p` followed
 *     by another flag makes the CLI take that flag as the prompt ("`-p` took
 *     `--input-format` as its prompt"), and a bare trailing `-p` is refused
 *     with "flag needs an argument". The prompt itself arrives on stdin.
 *   - `--input-format stream-json` is the whole point: one NDJSON message per
 *     line on stdin, one turn each. It REQUIRES `--output-format stream-json`.
 *   - `--output-format stream-json` emits `init`, a `step_update` per step, and
 *     exactly one `result` event whose payload is the same envelope
 *     `--output-format json` printed — response, usage, `denied_actions` and
 *     (with a schema) `structured_output`. The per-step deltas are ignored
 *     here; they are where live streaming would be added.
 *   - `--disable-slash-commands` strips the bundled slash-command and skill
 *     expansion. They cannot execute anything under the permission policy, but
 *     they are injectable instruction surface.
 *   - `--sandbox` turns on the CLI's own terminal restrictions. Belt on top of
 *     a `command` permission that is already denied by default.
 *   - `--print-timeout` is the CLI's own ceiling and is set INSIDE the step's
 *     wall clock, so the CLI reports a clean timeout envelope before the
 *     executor has to kill anything.
 *
 * And the flag that is deliberately absent: `--dangerously-skip-permissions`,
 * which would auto-approve every built-in tool. See §5 of the module comment.
 */
export function buildAgySpawnArgs(input: AgySpawnArgsInput): string[] {
  const args: string[] = ['-p=', '--model', input.model];
  if (input.effort) args.push('--effort', input.effort);
  args.push(
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--disable-slash-commands',
    '--sandbox',
    '--print-timeout',
    `${Math.max(1, Math.floor(input.printTimeoutMs / 1000))}s`,
  );
  if (input.conversationId) args.push('--conversation', input.conversationId);
  if (input.jsonSchema) args.push('--json-schema', input.jsonSchema);
  return args;
}

/**
 * The single NDJSON line written to the child's stdin, newline-terminated.
 *
 * VERIFIED against agy 1.1.27: the discriminator is `event`, not `type` — a
 * `{"type":"user",…}` message is rejected with `stream input message is missing
 * the "event" field` — and `message.content` may be a string, which is what a
 * single delimited turn wants. One line is one turn; the executor closes stdin
 * straight afterwards, which is what makes the CLI exit rather than wait for a
 * second turn.
 */
export function buildAgyStdinMessage(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { role: 'user', content: prompt } })}\n`;
}

// =============================================================================
// The result envelope
// =============================================================================

/**
 * The result payload, identical under `--output-format json` (one bare object)
 * and `--output-format stream-json` (the `result` event's `result` field).
 *
 * Recorded off the wire on 2026-09-08, on both output formats. `denied_actions`
 * and `structured_output` are present only when they apply; `error` only when
 * `status` is `ERROR`.
 */
export interface AgyEnvelope {
  conversation_id?: string;
  status?: 'SUCCESS' | 'ERROR' | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AnyObject;
  denied_actions?: Array<{ action?: string; display_name?: string }>;
  structured_output?: unknown;
  json_schema?: unknown;
}

/**
 * Pull the result payload out of one parsed stdout line, or `null` if that line
 * is not the result.
 *
 * Two shapes are accepted, because the executor is not the only caller of the
 * CLI: `stream-json` wraps the payload as `{"event":"result","result":{…}}`,
 * and the older `--output-format json` prints the payload bare. An `init` or
 * `step_update` event is explicitly NOT a result — without that check the
 * scan below would stop at the first well-formed object it met.
 */
function unwrapAgyResult(parsed: unknown): AgyEnvelope | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as AnyObject;
  if (typeof obj.event === 'string') {
    if (obj.event !== 'result') return null;
    const payload = obj.result;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as AgyEnvelope)
      : null;
  }
  return 'status' in obj ? (obj as AgyEnvelope) : null;
}

/**
 * Find the result envelope in whatever the CLI wrote to stdout.
 *
 * Under `--output-format stream-json` stdout is NDJSON — one `init`, a
 * `step_update` per step, then one `result` — so the scan runs backwards and
 * takes the last line that unwraps to a result. It is parsed defensively
 * anyway: a stray banner line, or a `step_update` carrying a huge text delta,
 * would otherwise turn a completed, paid-for turn into "no result".
 */
export function parseAgyEnvelope(stdout: string): AgyEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // A single pretty-printed object (the legacy `--output-format json` shape)
  // spans several lines, so it has to be tried whole before the line scan.
  try {
    const whole = unwrapAgyResult(JSON.parse(trimmed));
    if (whole) return whole;
  } catch {
    /* fall through to the line scan */
  }
  const lines = trimmed.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const found = unwrapAgyResult(JSON.parse(line));
      if (found) return found;
    } catch {
      /* not this line */
    }
  }
  return null;
}

/**
 * The metering shape the CLI's usage is mapped onto.
 *
 * This CLI reports its cache reads OUTSIDE the input total: a turn with
 * `input_tokens: 5551, cache_read_tokens: 8130` reports `total_tokens: 5555`,
 * i.e. `input + output` with the cache read excluded. Every other provider in
 * the engine — and `claude-code` — reports `input_tokens` as the TOTAL input
 * INCLUDING cached reads, and `extractCacheUsage` subtracts to get the uncached
 * residue.
 *
 * So the mapping ADDS the cache read back in rather than passing the number
 * through. Getting this wrong would under-report input on every cached turn and
 * make an agy step look cheaper than an identical Gemini API step, which is
 * exactly the comparison this provider exists to inform.
 *
 * `thinking_tokens` are reported separately by the CLI and are already inside
 * `output_tokens` (a turn with `output_tokens: 776, thinking_tokens: 656`
 * returned a short answer), so they are recorded but never added.
 */
export interface AgyUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  uncached_input_tokens: number;
  thinking_tokens: number;
  input_token_details: { cache_creation: number; cache_read: number };
}

export function mapAgyUsage(usage: AnyObject | undefined): AgyUsage {
  const u = usage || {};
  const uncached = num(u.input_tokens);
  const cacheRead = num(u.cache_read_tokens);
  const output = num(u.output_tokens);
  const input = uncached + cacheRead;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    uncached_input_tokens: uncached,
    thinking_tokens: num(u.thinking_tokens),
    input_token_details: { cache_creation: 0, cache_read: cacheRead },
  };
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** Remove the OAuth token from text bound for a log, an error or the archive. */
export function redactToken(text: string, token: string): string {
  if (!text || !token || token.length < 8) return text;
  return text.split(token).join('[REDACTED:AGY_OAUTH_TOKEN]');
}

/**
 * The CLI's own startup noise, which is not a diagnostic.
 *
 * Every glog line before `google.Init` is prefixed `ERROR: logging before
 * google.Init:` regardless of its real level, so an INFO line about settings
 * arrives looking like a failure. Stripping it keeps a healthy run from
 * printing "ERROR" into the worker log; the raw tail is still what a real
 * failure reports, because these lines are dropped from the tail only while
 * something else remains.
 */
export function stripGlogNoise(text: string): string {
  if (!text) return text;
  const kept = text
    .split('\n')
    .filter((line) => !/^ERROR: logging before google\.Init:/.test(line.trim()));
  const joined = kept.join('\n').trim();
  return joined || text.trim();
}

/**
 * Does this text look like the subscription being capped rather than broken?
 *
 * Deliberately broader than the claude-code twin because this CLI surfaces the
 * upstream Google status verbatim: `RESOURCE_EXHAUSTED` and `QUOTA_EXCEEDED`
 * are the shapes the Gemini backends use, and neither reads as `rate limit`.
 * Narrow enough that a model's own prose about content cannot match — it is
 * only ever run over `envelope.error` and stderr, never over `response`.
 */
export function looksLikeRateLimit(text: string): boolean {
  if (!text) return false;
  return (
    /\b429\b/.test(text) ||
    /rate[ _-]?limit/i.test(text) ||
    /resource[_ ]?exhausted/i.test(text) ||
    /quota[_ ]?exceeded/i.test(text) ||
    /\bquota\b[^\n]{0,40}\b(exceeded|exhausted|reached)\b/i.test(text) ||
    /usage limit reached/i.test(text) ||
    /too many requests/i.test(text) ||
    /\b(over)?capacity\b/i.test(text) ||
    /model is overloaded/i.test(text)
  );
}

/**
 * Does this text mean the subscription needs a human to log in again?
 *
 * VERIFIED behaviour with a corrupt token: the CLI prints `Authentication
 * required. Please visit the URL to log in:` and an `accounts.google.com` URL
 * to STDERR, then BLOCKS for its 60 s login window before returning
 * `{"status":"ERROR","error":"authentication failed or timed out"}`.
 *
 * That 60 s stall is the reason this matcher runs over stderr AS IT ARRIVES,
 * not only over the final envelope: the prompt is recognisable on the first
 * line, so the child can be killed immediately instead of parking a worker slot
 * for a minute on a credential that will not come back.
 */
export function looksLikeAuthPrompt(text: string): boolean {
  if (!text) return false;
  return (
    /Authentication required\. Please visit the URL/i.test(text) ||
    /accounts\.google\.com\/o\/oauth2\/auth/i.test(text) ||
    /paste the authorization code here/i.test(text) ||
    /authentication (failed or timed out|timed out)/i.test(text) ||
    /\bre-?authenticate\b/i.test(text)
  );
}

// =============================================================================
// The executor
// =============================================================================

export interface RunAgyCliStepOptions {
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
 * Run one `agy-cli` neuron step.
 *
 * Returns the same `{ [outputField]: text }` shape every other neuron path
 * returns, plus `data._cli[stepId]` with the CLI's own accounting.
 */
export async function runAgyCliStep(
  options: RunAgyCliStepOptions,
): Promise<Record<string, unknown>> {
  const { config, state, neuronCfg, neuronId, userId, callRunId, abortSignal, emitUsage } = options;

  const stepId = config.outputField;
  const runId = callRunId || state?.runId || state?.data?.runId || 'norun';
  const publisher: AnyObject | undefined = getRunPublisher(state);

  // The credential comes from redsecrets through the ordinary
  // `secretName → getConfig().apiKey` path, exactly like `claude-code`.
  // `AGY_OAUTH_TOKEN` is the worker-level fallback, so a fleet can be brought
  // up before any neuron document names a secret. Never from `appConfig.env`
  // in cleartext when a secret reference is available.
  const secretToken =
    (typeof neuronCfg?.apiKey === 'string' && neuronCfg.apiKey) ||
    process.env.AGY_OAUTH_TOKEN ||
    '';
  if (!secretToken) {
    throw new AgyCliError(
      'agy_no_token',
      `Neuron '${neuronId}' is provider 'agy-cli' but no subscription token resolved. ` +
        `Set secretName (the fleet convention is 'AGY_OAUTH_TOKEN', matching ` +
        `'CLAUDE_CODE_OAUTH') on the neuron and store the contents of ` +
        `~/.gemini/antigravity-cli/antigravity-oauth-token in the vault, or set ` +
        `AGY_OAUTH_TOKEN on the worker.`,
    );
  }
  const installationId = process.env.AGY_INSTALLATION_ID || undefined;

  const model = resolveAgyModel(neuronCfg?.model);
  const effortMode = AGY_MODELS.get(model) ?? 'required';
  const effort = resolveAgyEffort(state, neuronCfg, effortMode);
  const mount = resolveWorkspaceMount(state);
  const timeoutMs =
    typeof (config as AnyObject).timeoutMs === 'number' && (config as AnyObject).timeoutMs > 0
      ? (config as AnyObject).timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `agy-${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const home = path.join(dir, 'home');

  const cwd = ensureCwd(mount.tree, dir);

  let bridge: RunToolBridge | null = null;
  // `stdio: ['pipe', 'pipe', 'pipe']`: the prompt is one NDJSON message written
  // to stdin. It is written and stdin is CLOSED immediately, which matters for
  // two separate reasons — one message plus EOF is what makes the CLI run
  // exactly one turn and exit, and an EOF on stdin is what stops the CLI's
  // interactive login ("paste the authorization code here") from parking a
  // worker slot waiting for a human who is not there.
  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  let unregisterCancel: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let slotHeld = false;
  let spawnedPgid: number | null = null;

  const ctl: { killReason: string | null; timedOut: boolean; authPrompt: boolean } = {
    killReason: null,
    timedOut: false,
    authPrompt: false,
  };

  /**
   * Signal the child's whole PROCESS GROUP, not just the child.
   *
   * The CLI is not a leaf: it spawns the stdio shim for the bridge, and can
   * spawn a language server and a browser runtime of its own. `child.kill()`
   * signals only `agy` itself, leaving those holding the bridge socket and the
   * OAuth token. `spawn(..., { detached: true })` makes the child a group
   * leader (pgid == pid), which is what makes `process.kill(-pid, …)` safe —
   * without it the child shares the WORKER's group and a negative pid would
   * signal the worker. The two facts belong together.
   */
  const signalGroup = (signal: NodeJS.Signals): void => {
    const pid = child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, signal);
    } catch {
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
    console.warn(`[AgyCli] killing CLI child for run ${runId}: ${reason}`);
    signalGroup('SIGTERM');
    killTimer = setTimeout(() => signalGroup('SIGKILL'), SIGKILL_GRACE_MS);
    killTimer.unref?.();
  };

  try {
    const queueBudgetMs = Math.min(timeoutMs, queueWaitMs(timeoutMs));
    const queueStartedAt = Date.now();
    await acquireSlot(abortSignal, queueBudgetMs);
    slotHeld = true;
    const queuedMs = Date.now() - queueStartedAt;

    const runTimeoutMs = timeoutMs - queuedMs;
    if (runTimeoutMs <= 0) {
      throw new AgyCliError(
        'agy_queue_timeout',
        `agy-cli step '${stepId}' spent its entire ${timeoutMs} ms budget queued for a slot`,
      );
    }
    if (queuedMs > 1000) {
      console.warn(`[AgyCli] step '${stepId}' waited ${queuedMs} ms for a slot`);
    }

    // Re-check liveness AFTER queueing: the whole point is to not spend
    // subscription quota on an answer nobody will read.
    if (abortSignal?.aborted) {
      throw abortError(`agy-cli step '${stepId}' aborted while queued for a slot`);
    }
    if (runControlRegistry.wasCancelled(runId)) {
      throw abortError(`agy-cli step '${stepId}' was cancelled while queued for a slot`);
    }
    if (queuedMs > 0 && publisher?.getState) {
      try {
        const queuedRunState = await publisher.getState();
        const queuedStatus = queuedRunState?.status;
        if (typeof queuedStatus === 'string' && TERMINAL_RUN_STATUSES.has(queuedStatus)) {
          throw abortError(
            `agy-cli step '${stepId}' not started: run went ${queuedStatus} while queued`,
          );
        }
      } catch (err) {
        if ((err as AnyObject)?.name === 'AbortError') throw err;
      }
    }

    // ── tools → bridge ─────────────────────────────────────────────────────
    const attached = Array.isArray(config.tools) ? config.tools : [];
    const { clientRefs, hostedCapabilities } = partitionToolRefs(attached);
    if (hostedCapabilities.length > 0) {
      console.warn(
        `[AgyCli] ignoring ${hostedCapabilities.length} hosted tool capability/ies ` +
          `(${hostedCapabilities.join(', ')}): provider 'agy-cli' executes its own loop.`,
      );
    }
    const resolved = await resolveTools(clientRefs, state);
    const servable: RunBridgeToolRef[] = [];
    for (const tool of resolved) {
      if (isForbiddenForBridge(tool.name)) {
        console.warn(`[AgyCli] tool '${tool.name}' is forbidden for a bridge caller; dropped`);
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
      maxToolIterations:
        typeof config.maxToolIterations === 'number' && config.maxToolIterations > 0
          ? config.maxToolIterations
          : undefined,
      onCancel: () => requestKill('run cancelled'),
    });

    // ── the private HOME ───────────────────────────────────────────────────
    // The token starts as the newer of (the secret, whatever this worker last
    // saw the CLI refresh). A lock failure is not fatal: the secret's own copy
    // is always a correct credential, just possibly not the freshest.
    const stateDir = agyStateDir();
    let startingToken = secretToken;
    try {
      startingToken = await withStateLock(ensureStateDir(stateDir), () =>
        readCachedToken(stateDir, secretToken),
      );
    } catch (err) {
      console.warn(
        `[AgyCli] could not read the cached token (${(err as Error)?.message}); using the secret`,
      );
    }
    buildAgyHome({
      home,
      token: startingToken,
      installationId,
      mcpConfig: bridge.mcpConfig,
    });

    // ── prompts ────────────────────────────────────────────────────────────
    // This CLI has no `--system-prompt` and does not read stdin, so the system
    // prompt is delimited INSIDE the single argv prompt. The delimiters are the
    // same ones the claude-code executor uses for its oversized-prompt path, so
    // a graph moved between the two providers sees the same text.
    const preamble = BRIDGE_PREAMBLE.replace('%TREE%', mount.tree);
    const systemPrompt = buildSystemPrompt(config, state, preamble);
    const userPrompt = buildUserPrompt(config, state);
    const prompt = `=== SYSTEM INSTRUCTIONS ===\n${systemPrompt}\n=== END SYSTEM INSTRUCTIONS ===\n\n${userPrompt}`;

    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new AgyCliError(
        'agy_prompt_too_large',
        `agy-cli step '${stepId}' built a ${promptBytes} byte prompt; the executor writes the ` +
          `prompt to the CLI's stdin and so has no argv ceiling, but refuses anything over ` +
          `${MAX_PROMPT_BYTES} bytes because no model this CLI drives could read it. ` +
          `Shorten the prompt.`,
      );
    }
    if (promptBytes > PROMPT_TRUNCATION_WARN_BYTES) {
      // Not an error: past its own prompt-token budget the CLI truncates the
      // turn and still reports `status: SUCCESS`, so the only honest thing the
      // executor can do is say so where an operator will see it.
      console.warn(
        `[AgyCli] step '${stepId}' prompt is ${promptBytes} bytes, over the ` +
          `~${PROMPT_TRUNCATION_WARN_BYTES} bytes at which agy has been observed silently ` +
          `truncating a turn (and still reporting SUCCESS). The tail may not be read.`,
      );
    }

    let jsonSchemaArg: string | undefined;
    if (config.structuredOutput) {
      jsonSchemaArg = JSON.stringify(config.structuredOutput.schema);
      const schemaBytes = Buffer.byteLength(jsonSchemaArg, 'utf8');
      if (schemaBytes > MAX_JSON_SCHEMA_ARG_BYTES) {
        throw new AgyCliError(
          'agy_schema_too_large',
          `structuredOutput schema is ${schemaBytes} bytes; the CLI takes it as a single ` +
            `argv value, capped at ${MAX_JSON_SCHEMA_ARG_BYTES}`,
        );
      }
    }

    // The CLI's own ceiling sits INSIDE the step's, so a slow turn comes back
    // as a clean `status: ERROR` envelope with the usage it did spend, rather
    // than as a killed process the executor has to guess about. 5s of headroom
    // is enough for it to serialise that envelope.
    const printTimeoutMs = Math.max(1000, runTimeoutMs - 5000);

    const args = buildAgySpawnArgs({
      model,
      effort,
      printTimeoutMs,
      jsonSchema: jsonSchemaArg,
      conversationId: resolveResumeConversationId(config, state, stepId),
    });

    const env = buildAgyChildEnv({ home, dir });
    const bin = process.env.AGY_CLI_BIN || 'agy';

    console.log('[AgyCli] spawning', {
      neuronId,
      userId,
      model,
      effort,
      cwd,
      timeoutMs,
      tools: bridge.toolNames.length,
      promptBytes,
      // The token is a file inside the private HOME and never an argument; the
      // prompt is not an argument either any more, and the schema can be
      // enormous, so it is elided.
      argv: redactArgvForLog(args),
    });

    child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });

    // ── the prompt, then EOF ───────────────────────────────────────────────
    // Never awaited, and errors are swallowed: a child that dies before it
    // drains the pipe (a bad credential, a refused model) gives EPIPE here,
    // and that is a diagnosis the envelope and stderr make far better than an
    // unhandled 'error' on a stream would. The turn's real outcome is decided
    // below, off the CLI's own result.
    child.stdin.on('error', () => {
      /* EPIPE: the child exited before it read the turn */
    });
    try {
      child.stdin.end(buildAgyStdinMessage(prompt));
    } catch (err) {
      console.warn(`[AgyCli] could not write the prompt to stdin: ${(err as Error)?.message}`);
    }

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

    // ── stdout / stderr ────────────────────────────────────────────────────
    let stdout = '';
    let stdoutOverflowed = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > MAX_STDOUT_BYTES) {
        stdoutOverflowed = true;
        return;
      }
      stdout += chunk;
    });

    let stderrTail = '';
    let stderrSeen = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = redactToken(stderrTail + chunk, startingToken).slice(-STDERR_TAIL_BYTES);
      // Kill on the login prompt the moment it appears. The CLI otherwise
      // blocks for its whole 60 s interactive window on a credential that
      // cannot come back without a human, holding a worker slot the whole time.
      if (!ctl.authPrompt) {
        stderrSeen = (stderrSeen + chunk).slice(-4096);
        if (looksLikeAuthPrompt(stderrSeen)) {
          ctl.authPrompt = true;
          requestKill('the CLI asked for an interactive Google login');
        }
      }
    });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child!.once('error', (err: NodeJS.ErrnoException) => {
          reject(
            new AgyCliError(
              'agy_spawn_failed',
              `failed to spawn '${bin}': ${err?.message ?? String(err)}`,
            ),
          );
        });
        child!.once('close', (code, signal) => resolve({ code, signal }));
      },
    );

    // ── the refreshed token, back to the cache ─────────────────────────────
    // Done before any throw below, because a run that FAILED may still have
    // refreshed the credential on its way in, and throwing that away would make
    // the next run fail the same way.
    await persistRefreshedToken(home, stateDir, secretToken, startingToken);

    // ── outcome ────────────────────────────────────────────────────────────
    const envelope = parseAgyEnvelope(stdout);
    const stderrClean = stripGlogNoise(stderrTail).trim();

    // The interactive-login kill wins over everything: it is the most specific
    // diagnosis of the failure and has its own remedy (rotate the secret).
    if (ctl.authPrompt) {
      throw new AgyCliError(
        'agy_auth_required',
        `the Antigravity subscription needs an interactive Google login — rotate the ` +
          `'AGY_OAUTH_TOKEN' secret from a machine where 'agy' is logged in ` +
          `(see RUNBOOK-agy.md). ${stderrClean || '(no stderr)'}`,
      );
    }
    if (ctl.timedOut) {
      throw new AgyCliError(
        'agy_timeout',
        `agy-cli step '${stepId}' exceeded ${runTimeoutMs} ms of run time ` +
          `(of a ${timeoutMs} ms budget) and was killed`,
      );
    }
    if (ctl.killReason && !envelope) {
      throw abortError(`agy-cli step '${stepId}' stopped: ${ctl.killReason}`);
    }
    if (stdoutOverflowed) {
      throw new AgyCliError(
        'agy_failed',
        `agy-cli step '${stepId}' wrote more than ${MAX_STDOUT_BYTES} bytes to stdout`,
      );
    }

    if (!envelope) {
      if (looksLikeAuthPrompt(stderrClean)) {
        throw new AgyCliError(
          'agy_auth_required',
          `the Antigravity subscription needs an interactive Google login — rotate the ` +
            `'AGY_OAUTH_TOKEN' secret. ${stderrClean}`,
        );
      }
      if (looksLikeRateLimit(stderrClean)) {
        throw new AgyCliError(
          'agy_rate_limited',
          `the Antigravity subscription is rate limited; the CLI exited without a result. ` +
            `${stderrClean}`,
        );
      }
      throw new AgyCliError(
        'agy_failed',
        `agy exited ${exit.code ?? 'null'}${exit.signal ? ` (${exit.signal})` : ''} ` +
          `without a JSON result envelope. stderr tail: ${stderrClean || '(empty)'}`,
      );
    }

    const usage = mapAgyUsage(envelope.usage);
    const denials = Array.isArray(envelope.denied_actions) ? envelope.denied_actions : [];

    // Meter what was actually spent, on every path — a denied or errored turn
    // still burned subscription tokens, and the whole point of metering a
    // free-at-point-of-use provider is to see what it would have cost.
    emitUsage({ usage_metadata: usage }, `agy-cli/${model}`, `${stepId}:cli`);

    // ── denials are a security event, never a shrug ────────────────────────
    if (denials.length > 0) {
      console.error(
        `[AgyCli][security] run ${runId} step ${stepId}: the CLI attempted ` +
          `${denials.length} action(s) the permission policy denies`,
        denials.slice(0, 10),
      );
      await auditDenials(publisher, stepId, denials);
    }

    const finalText = typeof envelope.response === 'string' ? envelope.response : '';
    const isError = envelope.status !== 'SUCCESS';

    if (isError) {
      const detail = stripGlogNoise(envelope.error || '').trim() || stderrClean || '(no detail)';
      // Matched ONLY against the CLI's own `error` field and stderr, never
      // against `response`. `response` is the model's text, and a model that
      // can choose the platform's error code can manufacture "rotate the
      // token" ops pages from a poisoned tool result.
      if (looksLikeAuthPrompt(detail)) {
        throw new AgyCliError(
          'agy_auth_required',
          `the Antigravity subscription needs an interactive Google login — rotate the ` +
            `'AGY_OAUTH_TOKEN' secret. ${detail}`,
        );
      }
      if (looksLikeRateLimit(detail)) {
        throw new AgyCliError(
          'agy_rate_limited',
          `the Antigravity subscription is rate limited; agy-cli step '${stepId}' could not ` +
            `complete. ${detail}`,
        );
      }
      // The CLI's own `--print-timeout` fired. Reported as a timeout rather
      // than a generic failure so the fallback path and an operator read it
      // the same way a wall-clock kill is read.
      if (/timeout waiting for response|print[- ]timeout/i.test(detail)) {
        throw new AgyCliError(
          'agy_timeout',
          `agy-cli step '${stepId}' hit the CLI's own ${Math.round(printTimeoutMs / 1000)}s ` +
            `print timeout. ${detail}`,
        );
      }
      throw new AgyCliError(
        'agy_error_result',
        `agy-cli step '${stepId}' failed: ${detail}`,
      );
    }

    // A turn that produced nothing BECAUSE the policy refused a tool is not an
    // empty answer, it is a blocked one. Returning '' here would write an empty
    // string into the graph's state and let the run continue as though the step
    // had succeeded, which is exactly how a denied tool call becomes invisible.
    if (!finalText.trim() && denials.length > 0) {
      const names = denials
        .map((d) => d?.display_name || d?.action || 'unknown')
        .slice(0, 8)
        .join(', ');
      throw new AgyCliError(
        'agy_tool_denied',
        `agy-cli step '${stepId}' produced no output: the CLI reached for ${denials.length} ` +
          `action(s) the permission policy denies (${names}) and the turn ended. Only ` +
          `${bridgeGrant()} is granted; every built-in tool is denied by design.`,
      );
    }

    // ── the answer ─────────────────────────────────────────────────────────
    // Structured output is a PARSED OBJECT for every other provider, so it must
    // be one here too or `{{state.data.plan.steps}}` silently resolves to
    // nothing for this provider alone. The CLI hands back a parsed
    // `structured_output` when `--json-schema` was passed; `response` is
    // preferred only as a fallback, because the response text has been observed
    // carrying the CLI's own `toolAction`/`toolSummary` keys alongside the
    // schema's, while `structured_output` carries exactly the schema.
    let output: unknown = finalText;
    if (config.structuredOutput) {
      if (envelope.structured_output && typeof envelope.structured_output === 'object') {
        output = envelope.structured_output;
      } else {
        try {
          output = JSON.parse(finalText);
        } catch (err) {
          throw new AgyCliError(
            'agy_bad_structured_output',
            `step '${stepId}' declares structuredOutput but the CLI returned neither a ` +
              `structured_output object nor JSON text ` +
              `(${err instanceof Error ? err.message : String(err)}): ${finalText.slice(0, 200)}`,
          );
        }
      }
    }

    const cli = {
      provider: 'agy-cli',
      model,
      effort: effort ?? null,
      conversationId: envelope.conversation_id ?? null,
      numTurns: num(envelope.num_turns),
      durationMs: Math.round(num(envelope.duration_seconds) * 1000),
      // Subscription-backed: there is no per-token charge to record.
      totalCostUsdEstimate: 0,
      permissionDenials: denials.length,
      permissionDenialNames: denials.slice(0, 20).map((d) => d?.display_name || d?.action || null),
      usage,
      exitCode: exit.code,
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
    if (bridge) {
      try {
        await bridge.close({ removeDir: false });
      } catch (err) {
        console.warn('[AgyCli] bridge close failed:', err);
      }
    }
    // The private HOME — which holds a live OAuth token — lives under `dir`,
    // so this removal is the security-relevant one, not just tidiness.
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[AgyCli] failed to remove step dir ${dir}:`, err);
    }
    // `rmdir` (not `rm -rf`) on the run directory: it succeeds only when empty,
    // so the LAST step of a run tidies up and a concurrent sibling's directory
    // is never taken out from under it.
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

/** Create the state directory, returning it. Best effort; 0700 exactly. */
function ensureStateDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* someone else owns it; the read below will tell us if that matters */
  }
  return dir;
}

/**
 * Copy the token back out of the private HOME if the CLI refreshed it.
 *
 * Never throws: a cache that cannot be written is a run that is slightly less
 * efficient next time, not a run that failed.
 */
async function persistRefreshedToken(
  home: string,
  stateDir: string,
  secretToken: string,
  startingToken: string,
): Promise<void> {
  let current = '';
  try {
    current = fs.readFileSync(path.join(home, AGY_HOME_PATHS.token), 'utf8');
  } catch {
    return; // the CLI never got far enough to have one
  }
  if (!current.trim() || current === startingToken) return;
  try {
    await withStateLock(ensureStateDir(stateDir), () =>
      writeCachedToken(stateDir, secretToken, current),
    );
    console.log('[AgyCli] the CLI refreshed its OAuth token; cached it for the next run');
  } catch (err) {
    console.warn(`[AgyCli] could not cache the refreshed token: ${(err as Error)?.message}`);
  }
}

/**
 * Best-effort placeholder cwd, empty on purpose.
 *
 * This CLI auto-discovers `GEMINI.md`, `AGENTS.md` and `.agents/rules/*.md`
 * from the working directory, so an empty directory is not hygiene here — it is
 * the only thing stopping an untrusted tree from writing the system prompt.
 */
function ensureCwd(tree: string, dir: string): string {
  try {
    fs.mkdirSync(tree, { recursive: true });
    return tree;
  } catch (err) {
    const fallback = path.join(dir, tree.replace(/^\//, ''));
    console.warn(
      `[AgyCli] could not create placeholder cwd ${tree} (${(err as Error)?.message}); ` +
        `using ${fallback}`,
    );
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

/**
 * System prompt: node prefix, then the bridge preamble, then the step's own
 * prompt, then the workspace's own instructions. Same order and same sources as
 * the claude-code twin, so a step moved between providers reads identically.
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
 * User prompt. A `userPrompt` that is a bare reference to a messages array is
 * serialised as `role: content` turns — the CLI takes one prompt, not a list.
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
 * A conversation to resume, when the node asked for it and a previous execution
 * of this step recorded one. The CLI's flag is `--conversation <id>`; the id is
 * validated as a UUID before it becomes an argv token, because it comes back
 * out of graph state.
 */
function resolveResumeConversationId(
  config: NeuronStepConfig,
  state: AnyObject,
  stepId: string,
): string | undefined {
  if ((config as AnyObject).resume !== true) return undefined;
  const prior = state?.data?._cli?.[stepId]?.conversationId;
  if (typeof prior !== 'string') return undefined;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(prior)
    ? prior
    : undefined;
}

/**
 * Publish `denied_actions` onto the run record the same way the bridge
 * publishes its own denials: a started-then-errored tool call.
 */
async function auditDenials(
  publisher: AnyObject | undefined,
  stepId: string,
  denials: Array<{ action?: string; display_name?: string }>,
): Promise<void> {
  if (!publisher?.toolStart || !publisher?.toolError) return;
  for (const [index, denial] of denials.slice(0, 20).entries()) {
    const name = String(denial?.display_name || denial?.action || 'unknown').slice(0, 64);
    const toolId = `tool_agy_denied_${Date.now()}_${index}`;
    try {
      await publisher.toolStart(toolId, name, 'native', {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
        cli: true,
        denied: true,
      });
      await publisher.toolError(toolId, `agy-cli permission denial: ${name}`, {
        triggeredBy: 'neuron',
        neuronStepId: stepId,
      });
    } catch (err) {
      console.warn('[AgyCli] failed to publish denial audit:', err);
    }
  }
}

/**
 * argv for a log line. The token is never an argument and the prompt is not one
 * either (it goes over stdin), but the JSON schema can be enormous, so it is
 * elided rather than logged.
 */
export function redactArgvForLog(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    out.push(args[i]);
    if (args[i] === '--json-schema') {
      const value = args[i + 1] ?? '';
      out.push(`<${Buffer.byteLength(value, 'utf8')} bytes>`);
      i += 1;
    }
  }
  return out;
}
