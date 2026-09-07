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
 *   - A template does not have to render to a STRING. `invoke_tool` takes
 *     `{ toolName:'fetch_url', args:'{{state.data.answer}}' }`, and a
 *     neuron-written `state.data.answer = { url:'https://app.redbtn.io/...' }`
 *     hides the whole destination inside an object, under a key that reads as
 *     nothing. See {@link canHideDestination}.
 *   - `untrustedCaller` does not survive a graph-as-tool boundary: a neuron
 *     calling a published sub-graph re-enters `toolExecutor` with a fresh
 *     state, so any sub-graph that fetches a templated URL was an escalation
 *     path back to the service key. There are TWO such boundaries —
 *     `tool-resolver.resolveGraph` and the `invoke_graph` native tool — and
 *     the marker below has to cross both.
 *
 * So the rule this module implements is:
 *
 *   **A graph tool step is trusted only while the URL it fetches is the one the
 *   author literally typed.** The moment a URL-bearing parameter is produced by
 *   template interpolation — or a templated parameter renders to something that
 *   could contain a URL — or the step is running inside a sub-graph a model
 *   invoked as a tool, the call is untrusted and loses internal auth.
 *
 * Non-URL SCALAR parameters are deliberately NOT considered: a step that POSTs
 * `{{state.summary}}` to a fixed `https://app.redbtn.io/...` endpoint is the
 * common, legitimate, still-trusted case. Only the destination matters — and a
 * non-scalar render is treated as a possible destination, because it cannot be
 * ruled out as one.
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
  invoke_function: ['url'],
  // `audioUrl` does NOT match URL_NAME_PATTERN — the generic name heuristic
  // anchors on whole names like `url`/`sourceUrl`, and a prefixed one slips
  // past it. This entry is the reason a templated `audioUrl` is classified as
  // a destination at all.
  transcribe_audio: ['audioUrl'],
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
 * True when a RENDERED template result is opaque to {@link isUrlBearingParam}
 * — i.e. it can hide a request destination that the value heuristic cannot
 * see.
 *
 * `isUrlBearingParam`'s value test is `typeof value === 'string'`. Anything
 * that is not a scalar therefore carries an unbounded amount of structure past
 * it, and structure is exactly what a destination hides in:
 *
 * ```
 * { toolName:'invoke_tool',
 *   parameters:{ toolName:'fetch_url', args:'{{state.data.answer}}' } }
 * ```
 *
 * with a neuron-written `state.data.answer = { url:'https://app.redbtn.io/...' }`
 * renders `args` to an OBJECT. The key is called `args`, which reads as
 * nothing; the config value is `'{{state.data.answer}}'`, which reads as
 * nothing; and `invoke_tool` then hands that object to `fetch_url` verbatim.
 * That is the original vulnerability reached through the new control, so the
 * rule is deny-by-default: a templated leaf that rendered to a non-scalar is
 * model-controlled for URL purposes whatever it is called.
 *
 * Scalars stay legible and stay trusted — a `{{state.count}}` that renders to
 * `7`, a flag that renders to `false`, a `{{state.summary}}` that renders to
 * prose. `undefined` counts as opaque, which is also what an unresolved PURE
 * template renders to (see {@link findInterpolatedUrlParam}).
 */
export function canHideDestination(value: unknown): boolean {
  if (value === null) return false;
  const t = typeof value;
  return t !== 'string' && t !== 'number' && t !== 'boolean';
}

/**
 * Walk the CONFIGURED parameters alongside the RENDERED ones and report the
 * first URL-bearing leaf whose value came from interpolation.
 *
 * Returns the dotted path of that leaf, or `null` when every destination in the
 * step is a literal the author typed.
 *
 * Objects AND arrays are walked: a destination nested under
 * `{ options:{ sourceUrl:'{{x}}' } }` or `{ urls:['{{x}}'] }` is no less a
 * destination. An array element inherits its container's key for the
 * name-based test, so `{ sourceUrl:['{{x}}'] }` is still recognised by name;
 * the reported path keeps the index (`sourceUrl.0`).
 *
 * A templated value that did NOT substitute is not treated as interpolated:
 * nothing from state reached the URL, and the request fails on its own. That
 * only covers the MIXED form (`https://host/{{state.missing}}`), where
 * `renderTemplate` hands the `{{...}}` text back unchanged. A PURE
 * `{{state.missing}}` renders to `undefined` (`resolveValue` falls through to
 * `new Function`), which is indistinguishable here from a resolved value, so it
 * is reported as interpolated — the safe direction, and the request has no URL
 * to send anyway.
 */
export function findInterpolatedUrlParam(
  toolName: string,
  configParams: unknown,
  renderedParams: unknown,
  path: string[] = [],
  keyHint = '',
): string | null {
  if (!configParams || typeof configParams !== 'object') return null;

  const cfgIsArray = Array.isArray(configParams);
  const cfg = configParams as AnyObject;
  const renderedIsUsable =
    renderedParams !== null &&
    typeof renderedParams === 'object' &&
    Array.isArray(renderedParams) === cfgIsArray;
  const rendered = (renderedIsUsable ? renderedParams : {}) as AnyObject;

  for (const key of Object.keys(cfg)) {
    const configValue = cfg[key];
    const renderedValue = rendered[key];
    const here = [...path, key];
    // Inside an array the key is an index and says nothing; keep the
    // container's name so `{ sourceUrl:['{{x}}'] }` is still URL-bearing.
    const nameHere = cfgIsArray ? keyHint || key : key;

    if (configValue && typeof configValue === 'object') {
      const nested = findInterpolatedUrlParam(toolName, configValue, renderedValue, here, nameHere);
      if (nested) return nested;
      continue;
    }

    if (!isTemplatedValue(configValue)) continue;
    // The template did not resolve — the literal `{{...}}` survived, so no
    // state value reached this parameter.
    if (typeof renderedValue === 'string' && renderedValue === configValue) continue;

    // SECURITY: a template that rendered to anything but a scalar is opaque to
    // the value heuristic below, so it is treated as a destination outright.
    // See {@link canHideDestination} — this is the `invoke_tool` +
    // `args:'{{state.data.answer}}'` hole.
    if (canHideDestination(renderedValue)) return here.join('.');

    // Check the parameter under BOTH its configured and rendered value: a
    // config of `'{{state.target}}'` looks nothing like a URL until it renders.
    if (
      isUrlBearingParam(toolName, nameHere, renderedValue) ||
      isUrlBearingParam(toolName, nameHere, configValue)
    ) {
      return here.join('.');
    }
  }
  return null;
}

/**
 * True when this state was entered through a model-invoked graph-as-tool.
 *
 * Three places carry the marker, because three different mechanisms start a
 * sub-run and each preserves a different slice of state:
 *
 *   - `state[MODEL_DRIVEN_STATE_KEY]` — `tool-resolver.resolveGraph` (a neuron
 *     invoking a published graph as a tool) via {@link markStateModelDriven};
 *   - `state.data[MODEL_DRIVEN_STATE_KEY]` — the same marker after
 *     `graphExecutor` rebuilt the top-level state and copied `data` forward;
 *   - `state.data.input[MODEL_DRIVEN_STATE_KEY]` — the `invoke_graph` native
 *     tool, which does not synthesise a state at all: it calls `run()` with an
 *     `input`, and `buildInitialState` only exposes that input at
 *     `state.data.input`. Reading it here is what makes an `invoke_graph`
 *     child run inherit the taint. The marker is stamped AFTER the
 *     model-supplied input is spread, so a model can only ever add the taint,
 *     never clear it.
 */
export function isModelDrivenState(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false;
  const s = state as AnyObject;
  return (
    s[MODEL_DRIVEN_STATE_KEY] === true ||
    s.data?.[MODEL_DRIVEN_STATE_KEY] === true ||
    s.data?.input?.[MODEL_DRIVEN_STATE_KEY] === true ||
    s.input?.[MODEL_DRIVEN_STATE_KEY] === true
  );
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
 * as a tool (through `tool-resolver.resolveGraph` or `invoke_graph`), OR a
 * URL-bearing parameter of this step was interpolated from run state — which
 * includes any templated parameter that rendered to a non-scalar, because a
 * destination can hide inside one. Trusted otherwise: the author typed the
 * destination.
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
