/**
 * Caller trust for native tool calls.
 *
 * # The question this module answers
 *
 * `NativeToolContext.untrustedCaller` means "the arguments of this call were
 * chosen by a language model". `fetch_url` reads it and attaches no internal
 * credential (`Authorization` / `X-User-Id` / `X-Internal-Key`) when it is set,
 * because on the webapp side `X-Internal-Key` + `X-User-Id` resolves as an
 * ADMIN impersonating that user — so a model that picks the URL would
 * otherwise be handing itself the platform service key against any internal
 * API.
 *
 * Deciding the flag is easy for the neuron tool-use loop (always untrusted) and
 * for the stream-parser executors (always untrusted: the args are parsed out of
 * the model's own streamed output). It is NOT easy for a graph `tool` step, and
 * the naive reading — "a graph author wrote the parameters, so they're trusted"
 * — is wrong:
 *
 *   - `toolExecutor` renders every parameter with `renderParameters(config.
 *     parameters, state)`, so a step configured as
 *     `{ toolName:'fetch_url', parameters:{ url:'{{data.answer}}' } }` puts a
 *     fully model-chosen URL into a trusted context.
 *   - `untrustedCaller` does not survive a graph-as-tool boundary: a neuron
 *     calling a published sub-graph re-enters `toolExecutor` with a fresh
 *     state, so any sub-graph that fetches a templated URL was an escalation
 *     path back to the service key.
 *
 * So the rule this module implements is:
 *
 *   **A graph tool step is trusted only while the URL it fetches is the one the
 *   author literally typed.** The moment a URL-bearing parameter is produced by
 *   template interpolation — or the step is running inside a sub-graph a model
 *   invoked as a tool — the call is untrusted and loses internal auth.
 *
 * Non-URL parameters are deliberately NOT considered: a step that POSTs
 * `{{state.summary}}` to a fixed `https://app.redbtn.io/...` endpoint is the
 * common, legitimate, still-trusted case. Only the destination matters.
 *
 * @module lib/tools/caller-trust
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * State key marking "this run (or sub-run) was entered with model-chosen
 * arguments". Set by `tool-resolver`'s graph-as-tool resolver on the state it
 * synthesises for the sub-graph; read by `toolExecutor` for every tool step in
 * that sub-graph, at any nesting depth (`graphExecutor` copies `data` forward).
 */
export const MODEL_DRIVEN_STATE_KEY = '_modelDrivenArgs';

/**
 * Tools whose named parameters are request destinations. The generic name and
 * value heuristics below catch the rest; this map exists so a rename of a
 * parameter that does not *look* like a URL cannot silently drop the check.
 */
export const URL_BEARING_PARAMS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  fetch_url: ['url'],
  scrape_url: ['url'],
  ssh_copy: ['sourceUrl'],
  send_webhook: ['url'],
  download_file: ['url'],
  upload_attachment: ['url'],
});

/** Parameter names that always denote a request destination. */
const URL_NAME_PATTERN = /^(url|uri|href|link|endpoint|origin|base_?url|source_?url|target_?url|webhook_?url|callback_?url|redirect_?url)$/i;

/** A rendered value that is itself an absolute http(s) URL. */
const ABSOLUTE_HTTP_URL = /^\s*https?:\/\//i;

/**
 * True when `key` (with its rendered `value`) addresses where a request goes.
 *
 * Three independent signals, any of which is enough:
 *   1. the tool's entry in {@link URL_BEARING_PARAMS} names it;
 *   2. the parameter name reads as a URL (`url`, `sourceUrl`, `endpoint`, ...);
 *   3. the rendered value is an absolute `http(s)` URL, whatever it is called.
 */
export function isUrlBearingParam(toolName: string, key: string, value?: unknown): boolean {
  const named = URL_BEARING_PARAMS[toolName];
  if (named && named.indexOf(key) >= 0) return true;
  if (URL_NAME_PATTERN.test(key)) return true;
  if (typeof value === 'string' && ABSOLUTE_HTTP_URL.test(value)) return true;
  return false;
}

/**
 * True when a configured value is a template — i.e. its final content is
 * decided at run time rather than by the author.
 *
 * `templateRenderer` marks every substitution form with `{{`: a pure
 * `{{state.x}}` reference, a mixed `https://host/{{state.x}}` string, and the
 * `{{ (expr) }}` expression form alike. Nothing else in a config string
 * interpolates.
 */
export function isTemplatedValue(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{');
}

/**
 * Walk the CONFIGURED parameters alongside the RENDERED ones and report the
 * first URL-bearing leaf whose value came from interpolation.
 *
 * Returns the dotted path of that leaf, or `null` when every destination in the
 * step is a literal the author typed.
 *
 * A templated value that did NOT substitute (the variable was missing, so
 * `renderTemplate` handed the `{{...}}` text back unchanged) is not treated as
 * interpolated: nothing from state reached the URL, and the request will fail
 * on its own.
 */
export function findInterpolatedUrlParam(
  toolName: string,
  configParams: unknown,
  renderedParams: unknown,
  path: string[] = [],
): string | null {
  if (!configParams || typeof configParams !== 'object' || Array.isArray(configParams)) {
    return null;
  }
  const cfg = configParams as AnyObject;
  const rendered = (renderedParams && typeof renderedParams === 'object' ? renderedParams : {}) as AnyObject;

  for (const key of Object.keys(cfg)) {
    const configValue = cfg[key];
    const renderedValue = rendered[key];
    const here = [...path, key];

    if (configValue && typeof configValue === 'object' && !Array.isArray(configValue)) {
      const nested = findInterpolatedUrlParam(toolName, configValue, renderedValue, here);
      if (nested) return nested;
      continue;
    }

    if (!isTemplatedValue(configValue)) continue;
    // The template did not resolve — the literal `{{...}}` survived, so no
    // state value reached this parameter.
    if (typeof renderedValue === 'string' && renderedValue === configValue) continue;

    // Check the parameter under BOTH its configured and rendered value: a
    // config of `'{{state.target}}'` looks nothing like a URL until it renders.
    if (isUrlBearingParam(toolName, key, renderedValue) || isUrlBearingParam(toolName, key, configValue)) {
      return here.join('.');
    }
  }
  return null;
}

/** True when this state was entered through a model-invoked graph-as-tool. */
export function isModelDrivenState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const s = state as AnyObject;
  return s[MODEL_DRIVEN_STATE_KEY] === true || s.data?.[MODEL_DRIVEN_STATE_KEY] === true;
}

/**
 * Stamp the taint marker onto a state object destined for a sub-graph the
 * model chose to invoke. Returns a new object; the input is not mutated.
 */
export function markStateModelDriven<T extends AnyObject>(state: T): T {
  return {
    ...state,
    [MODEL_DRIVEN_STATE_KEY]: true,
    data: {
      ...((state as AnyObject).data || {}),
      [MODEL_DRIVEN_STATE_KEY]: true,
    },
  } as T;
}

/** Outcome of {@link resolveToolStepTrust}. */
export interface ToolStepTrust {
  /** Value for `NativeToolContext.untrustedCaller`. */
  untrustedCaller: boolean;
  /** Human-readable cause, for the log line. `null` when trusted. */
  reason: string | null;
}

/**
 * Decide `untrustedCaller` for one graph `tool` step.
 *
 * Untrusted when EITHER the step is running inside a sub-graph a model invoked
 * as a tool, OR a URL-bearing parameter of this step was interpolated from run
 * state. Trusted otherwise — the author typed the destination.
 */
export function resolveToolStepTrust(args: {
  toolName: string;
  configParams: unknown;
  renderedParams: unknown;
  state: unknown;
}): ToolStepTrust {
  if (isModelDrivenState(args.state)) {
    return {
      untrustedCaller: true,
      reason: 'running inside a model-invoked graph-as-tool',
    };
  }
  const param = findInterpolatedUrlParam(args.toolName, args.configParams, args.renderedParams);
  if (param) {
    return {
      untrustedCaller: true,
      reason: `URL-bearing parameter '${param}' was interpolated from run state`,
    };
  }
  return { untrustedCaller: false, reason: null };
}
