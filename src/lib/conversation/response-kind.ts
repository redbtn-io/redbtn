/**
 * Response kind — marks an assistant turn that is NOT a real model answer.
 *
 * A graph can end a run with text that did not come from the model: a
 * fallback (`errorHandling.onError: 'fallback'` put its `fallbackValue` in the
 * response field), a graph-declared error reply (e.g. red-code's "Red Code
 * stopped before calling the model: ..." written through a
 * `data.directResponse`), or a run failure. Persisted as ordinary assistant
 * turns, those texts were fed back by `get_context_history` and models
 * imitated them word for word (env ids included) long after the cause was
 * fixed.
 *
 * Such turns are persisted with `messages[].metadata.kind = 'error' | 'fallback'`
 * and context loaders leave them out of prompt history by default.
 *
 * How a run's final response gets its kind (first match wins):
 *   1. `state.data.responseKind` set by the graph: `'error'` or `'fallback'`
 *      marks it; `'normal'` explicitly clears any inferred kind.
 *   2. A step error record (`state.data._stepErrors[<field>]`) for the
 *      response field (`data.response` / `response`): the step writing the
 *      response failed and the run carried on with its fallbackValue (or
 *      nothing) -> `'fallback'`. Records are cleared when a later step writing
 *      that field succeeds, so a recovered response is not marked.
 */

export type ResponseKind = 'error' | 'fallback';

/** State field a graph step sets to mark its response (`data.responseKind`). */
export const RESPONSE_KIND_FIELD = 'responseKind';

/** Output fields whose step-error record means the response is a fallback. */
const RESPONSE_FIELDS = ['data.response', 'response'] as const;

export function isResponseKind(value: unknown): value is ResponseKind {
  return value === 'error' || value === 'fallback';
}

/** The kind of a run's final response, from its final `state.data`. */
export function resolveResponseKind(data: unknown): ResponseKind | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const d = data as Record<string, unknown>;
  const declared = typeof d[RESPONSE_KIND_FIELD] === 'string'
    ? (d[RESPONSE_KIND_FIELD] as string).trim().toLowerCase()
    : '';
  if (isResponseKind(declared)) return declared;
  if (declared === 'normal') return undefined;
  const bag = d._stepErrors;
  if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
    for (const field of RESPONSE_FIELDS) {
      if ((bag as Record<string, unknown>)[field]) return 'fallback';
    }
  }
  return undefined;
}

/** The kind stored on a persisted message (`metadata.kind`), if any. */
export function storedMessageKind(message: unknown): ResponseKind | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const meta = (message as Record<string, unknown>).metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const kind = (meta as Record<string, unknown>).kind;
  return isResponseKind(kind) ? kind : undefined;
}

/**
 * The short note that stands in for an error/fallback turn when a context
 * loader is asked to keep its place (`get_context_history` errorTurns:'note').
 * Deliberately carries none of the original text.
 */
export function errorTurnNote(kind: ResponseKind): string {
  return kind === 'fallback'
    ? '[An earlier reply here was an automatic fallback message, not an answer; it is omitted.]'
    : '[An earlier turn here failed before a real answer; its error message is omitted.]';
}
