/**
 * Neuron step fallback — "try the good one, keep the lights on".
 *
 * # Why this exists
 *
 * The platform default for real work is a subscription-backed CLI neuron: a
 * `claude-code` child spending a flat-rate Claude subscription, or an `agy-cli`
 * child spending a flat-rate Antigravity one. That is the right default and the
 * wrong single point of failure. A CLI is a *process* — it can fail to spawn,
 * fail its startup guard, sit in the worker's concurrency queue until the queue
 * timeout, or hit a subscription rate limit — none of which says anything about
 * the step's prompt. A metered neuron would have answered the same question
 * fine.
 *
 * So a neuron step may name a `fallbackNeuronId`. When the primary fails with
 * an error that a *different* neuron would plausibly survive, the executor
 * re-runs the SAME step once against that neuron and lets the run continue.
 *
 * # What this is NOT
 *
 * It is not a retry (`errorHandling.retry` already does that, against the same
 * neuron) and it is not a catch-all. Re-running a step costs real money and
 * real latency, and silently rerouting a *request* defect just buys the same
 * failure twice while hiding the first one. So the trigger set is a closed,
 * enumerated list of "the primary could not run here" failures, and anything
 * that says "this request is wrong" — a bad schema, an unknown tool, a content
 * refusal, an API 4xx — fails loudly on the primary, as it should.
 *
 * # Ordering against `errorHandling`
 *
 * The fallback sits INSIDE `executeWithErrorHandling`, so `retry` /
 * `onError` / `fallbackValue` only ever see an error once BOTH the primary and
 * the fallback have failed. A `retry: 2` therefore retries the pair, which is
 * the honest reading of "retry this step".
 *
 * # Depth
 *
 * Exactly one hop. The fallback attempt runs with its own `fallbackNeuronId`
 * forced to `null`, so a chain of neurons each naming the next cannot turn a
 * failing step into a tour of the whole registry (or a loop).
 */
/**
 * Interrupt/abort sentinel names, checked by NAME rather than by importing the
 * classes. `functions/run.ts` loads the graph compiler, which loads the node
 * executors, which load this module — importing `isRunInterruptedError` from
 * there would close that cycle. `universalNode.ts` declares its own inline
 * `RunInterruptedError` for the same reason; both files are checking a name on
 * the wire, so a name check here is the same contract with no import.
 */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'RunInterruptedError',
  'AbortError',
]);

/**
 * `claude-code` executor error codes that justify trying a different neuron.
 *
 * Every one of these is a statement about the CLI child or its environment,
 * not about the step:
 *
 *   - `claude_code_spawn_failed`  — the CLI is not installed / not executable
 *                                   on this worker.
 *   - `claude_code_init_failed`   — the `system/init` guard rejected the run.
 *   - `claude_code_rate_limited`  — the subscription is out of headroom.
 *   - `claude_code_queue_timeout` — never got one of this worker's CLI slots.
 *   - `claude_code_auth_401`      — Anthropic rejected the subscription token
 *                                   (an operational fact about the shared
 *                                   platform credential, which is why it is
 *                                   here while a *provider* 401 is not — see
 *                                   `isRetryableElsewhere`).
 *   - `claude_code_timeout`       — wall-clock ceiling hit.
 *   - `claude_code_failed`        — non-zero exit with no `result` event.
 *   - `claude_code_error_result`  — the CLI reported `is_error` / `error_*`.
 *
 * Deliberately ABSENT, and why:
 *
 *   - `claude_code_bad_model`, `claude_code_bad_structured_output`,
 *     `claude_code_schema_too_large` — step-config defects. The fallback
 *     neuron would fail the same way, one model later.
 *   - `claude_code_api_key_leak` — a security guard tripped. Rerouting around
 *     a tripped guard is the one thing that must never happen quietly.
 *   - `claude_code_no_token` — `secretName` did not resolve. That is a broken
 *     neuron document, and a fallback would hide it forever. Operators should
 *     see a subscription neuron with no token.
 */
export const CLAUDE_CODE_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'claude_code_spawn_failed',
  'claude_code_init_failed',
  'claude_code_rate_limited',
  'claude_code_queue_timeout',
  'claude_code_auth_401',
  'claude_code_timeout',
  'claude_code_failed',
  'claude_code_error_result',
]);

/**
 * `agy-cli` executor error codes that justify trying a different neuron.
 *
 * The motivating case for this whole module now has a second provider: an
 * `agy-cli` neuron running Gemini Flash on a flat-rate Antigravity
 * subscription, with a metered `sonnet-5` behind it for when the subscription
 * is capped. `agy_rate_limited` is the code that hop exists for.
 *
 * The same rule as the Claude set decides membership — is this a statement
 * about the CLI child or its environment, or about the step? — but ONE
 * classification differs from its Claude twin, deliberately:
 *
 *   - `claude_code_auth_401` IS a trigger; `agy_auth_required` is NOT.
 *
 * A rejected Claude subscription token is recoverable by the platform on its
 * own schedule and the run may as well finish elsewhere. `agy_auth_required`
 * means the Antigravity CLI is asking a HUMAN to complete a Google OAuth flow:
 * nothing gets better until someone does, every subsequent step pays a fresh
 * child spawn to rediscover it, and a silent fallback would keep the graphs
 * green while the subscription this provider exists to spend quietly stops
 * being used at all. It surfaces.
 *
 * Deliberately ABSENT, and why:
 *
 *   - `agy_auth_required`  — see above. A human has to log in again.
 *   - `agy_tool_denied`    — the permission policy refused a tool and the turn
 *                            produced nothing. A tripped security guard is the
 *                            one thing that must never be routed around
 *                            quietly, exactly like `claude_code_api_key_leak`.
 *   - `agy_no_token`       — a broken neuron document; a fallback would hide it
 *                            forever.
 *   - `agy_bad_model`, `agy_prompt_too_large`, `agy_schema_too_large`,
 *     `agy_bad_structured_output` — step/neuron config defects. The fallback
 *                            neuron fails the same way, one model later.
 */
export const AGY_FALLBACK_CODES: ReadonlySet<string> = new Set([
  'agy_spawn_failed',
  'agy_rate_limited',
  'agy_queue_timeout',
  'agy_timeout',
  'agy_failed',
  'agy_error_result',
]);

/** Node / undici / provider-SDK connection error codes. */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** The classification result. `null` means "do not fall back". */
export type FallbackTriggerCode =
  | string // a claude_code_* code, verbatim
  | 'http_429'
  | 'http_5xx'
  | 'network'
  | 'timeout';

/** Walk `err.cause` (bounded) so a wrapped provider error is still readable. */
function errorChain(err: unknown, max = 5): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < max && cur && typeof cur === 'object'; i++) {
    chain.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (chain.length === 0 && err !== undefined && err !== null) chain.push(err);
  return chain;
}

/** First numeric HTTP status found anywhere on the error chain. */
function httpStatusOf(err: unknown): number | undefined {
  for (const node of errorChain(err)) {
    const e = node as Record<string, any>;
    const candidates = [e?.status, e?.statusCode, e?.response?.status, e?.error?.status];
    for (const c of candidates) {
      const n = typeof c === 'number' ? c : typeof c === 'string' ? Number(c) : NaN;
      if (Number.isFinite(n) && n >= 100 && n < 600) return n;
    }
  }
  return undefined;
}

/** Lower-cased concatenation of every message/name/code on the chain. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  for (const node of errorChain(err)) {
    const e = node as Record<string, any>;
    if (typeof e?.message === 'string') parts.push(e.message);
    if (typeof e?.name === 'string') parts.push(e.name);
    if (typeof e?.code === 'string') parts.push(e.code);
  }
  if (parts.length === 0) parts.push(String(err));
  return parts.join(' | ').toLowerCase();
}

/** Any Node/undici network code on the chain. */
function networkCodeOf(err: unknown): string | undefined {
  for (const node of errorChain(err)) {
    const code = (node as { code?: unknown })?.code;
    if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return code;
  }
  return undefined;
}

/**
 * Classify a step failure: would a DIFFERENT neuron plausibly have answered?
 *
 * Returns the trigger code to record on the run, or `null` for "no fallback".
 *
 * The three hard NOs come first and are absolute:
 *   1. Run interrupt / abort — the user or the platform stopped this run. A
 *      fallback would restart work the run has already been told to abandon.
 *   2. Anything already classified as a `claude-code` or `agy-cli` code that is
 *      not in that provider's trigger set (config defects, a tripped security
 *      guard, a missing token, an expired subscription login).
 *   3. Provider 4xx — a request defect. Includes 401/403: unlike the shared
 *      subscription token, a rejected API key is this neuron's own
 *      configuration being wrong, and quietly billing a second provider does
 *      not fix it.
 */
export function classifyFallbackTrigger(err: unknown): FallbackTriggerCode | null {
  // (1) Interrupt / abort — never.
  for (const node of errorChain(err)) {
    const name = (node as { name?: unknown })?.name;
    if (typeof name === 'string' && ABORT_ERROR_NAMES.has(name)) return null;
  }

  // (2) The CLI providers: closed, enumerated sets. A `claude_code_*` or
  // `agy_*` code that is not in its set is a decision, not an oversight —
  // never fall through to the generic heuristics below for it. That matters
  // most for the codes deliberately excluded: `agy_auth_required`'s message
  // mentions a login and `agy_rate_limited`'s mentions a rate limit, so a
  // text-matching fallthrough would classify BOTH as `http_429` and hop around
  // the one that must not be hopped around.
  for (const node of errorChain(err)) {
    const code = (node as { code?: unknown })?.code;
    if (typeof code === 'string' && code.startsWith('claude_code_')) {
      return CLAUDE_CODE_FALLBACK_CODES.has(code) ? code : null;
    }
    if (typeof code === 'string' && code.startsWith('agy_')) {
      return AGY_FALLBACK_CODES.has(code) ? code : null;
    }
  }

  const status = httpStatusOf(err);
  const text = errorText(err);

  // (3) Provider 4xx — request defects, refusals, bad schemas, bad keys.
  // 429 is the one 4xx that is about capacity rather than the request.
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return status === 429 ? 'http_429' : null;
  }

  if (typeof status === 'number' && status >= 500 && status < 600) return 'http_5xx';

  // No usable status — fall back to text. Provider SDKs are inconsistent about
  // surfacing `status`, and Google's genai client in particular stringifies it
  // into the message. Keep these patterns narrow enough that a *refusal*
  // (which reads as prose about the content) can never match.
  if (/\b429\b|too many requests|rate.?limit|quota exceeded|resource_exhausted/.test(text)) {
    return 'http_429';
  }
  if (/\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|gateway timeout|overloaded|unavailable/.test(text)) {
    return 'http_5xx';
  }

  const netCode = networkCodeOf(err);
  if (netCode) return 'network';
  if (/fetch failed|socket hang up|network error|connection error|econnreset|enotfound/.test(text)) {
    return 'network';
  }

  // Timeouts: the provider's, ours (stream-start / inactivity watchdogs), or
  // the transport's.
  if (/timed out|timeout|etimedout|stream stalled|did not start/.test(text)) return 'timeout';

  return null;
}

/** Back-compat/readability alias — true when a fallback should be attempted. */
export function isRetryableElsewhere(err: unknown): boolean {
  return classifyFallbackTrigger(err) !== null;
}

/**
 * What gets written to `state.data._fallback[stepId]`.
 *
 * Deliberately small and stable: this is read by humans debugging a run and by
 * anything that wants to know which neuron actually answered.
 */
export interface FallbackRecord {
  /** Neuron the step was configured to use. */
  from: string;
  /** Neuron that was tried instead. */
  to: string;
  /** The primary's error message, truncated. */
  reason: string;
  /** The classification code that authorised the hop. */
  code: string;
}

/** Keep a run record readable — a stack-shaped message helps nobody here. */
export function truncateReason(message: string, max = 500): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Resolve the fallback neuron id for a step.
 *
 * Precedence, highest first:
 *
 *   1. `config.fallbackNeuronId === null` — explicitly DISABLED. Stops here;
 *      the node parameter is not consulted, because "off" that a graph-level
 *      default could override would not be off.
 *   2. `config.fallbackNeuronId` as a literal id, or as a template
 *      (`"{{parameters.fallbackNeuronId}}"`, `"{{state.data.x}}"`) resolved by
 *      the caller-supplied `resolveTemplate`. A template that resolves to
 *      nothing falls through to (3) rather than being used as a garbage id —
 *      same rule `neuronId` already follows.
 *   3. `state.parameters.fallbackNeuronId` — the graph-level path. A node's
 *      `parameters` come from the graph node's `config.parameters`, so a graph
 *      can give every step in a node a fallback without touching step configs.
 *      `null` there disables too.
 *
 * @param resolveTemplate the executor's `resolveConfigValue`, injected so this
 *        module stays free of the executor's runtime import graph (and stays
 *        unit-testable on its own).
 */
export function resolveFallbackNeuronId(
  config: { fallbackNeuronId?: string | null },
  state: any,
  resolveTemplate: (value: any, state: any) => any,
): string | undefined {
  const hasOwn =
    config != null && Object.prototype.hasOwnProperty.call(config, 'fallbackNeuronId');

  if (hasOwn) {
    const raw = config.fallbackNeuronId;
    if (raw === null) return undefined; // (1) explicitly off
    if (raw !== undefined) {
      const resolved = resolveTemplate(raw, state);
      if (resolved === null) return undefined;
      const usable = usableId(resolved);
      if (usable) return usable; // (2)
    }
  }

  const fromParams = state?.parameters?.fallbackNeuronId; // (3)
  if (fromParams === null) return undefined;
  return usableId(fromParams);
}

/** A neuron id is usable when it is a non-empty string with no live template. */
function usableId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('{{')) return undefined;
  return trimmed;
}
