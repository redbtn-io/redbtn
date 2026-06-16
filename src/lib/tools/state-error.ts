/**
 * Normalize an upstream global-state API error body into a consistent,
 * agent-friendly envelope so the native `set_global_state` / `state_patch`
 * tools surface failures the same way.
 *
 * Output shape: `{ error: <message string>, status, details? }`.
 *
 * Handles both error shapes the webapp can return:
 *   - real namespace-write 422: `{ error: '<msg>', code, expectedSchema, errors }`
 *   - structured:              `{ error: { message, code }, expectedSchema, validationErrors }`
 *
 * For schema-validation (422) failures, the expected schema + the validation
 * errors are lifted under `details` so a graph can react to the feedback
 * (e.g. fix the value and retry). `error` is always a plain string.
 */
export function formatStateApiError(
  data: unknown,
  status: number,
  statusText: string,
  apiLabel: string,
): Record<string, unknown> {
  const fallback = `${apiLabel} ${status} ${statusText}`;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { error: fallback, status };
  }
  const d = data as Record<string, unknown>;

  const nestedErr =
    d.error && typeof d.error === 'object' && !Array.isArray(d.error)
      ? (d.error as Record<string, unknown>)
      : undefined;

  const message =
    typeof d.error === 'string'
      ? d.error
      : typeof nestedErr?.message === 'string'
        ? (nestedErr.message as string)
        : fallback;

  const validationErrors =
    d.validationErrors !== undefined ? d.validationErrors : d.errors;
  const code = d.code !== undefined ? d.code : nestedErr?.code;

  const details: Record<string, unknown> = {};
  if (d.expectedSchema !== undefined) details.expectedSchema = d.expectedSchema;
  if (validationErrors !== undefined) details.validationErrors = validationErrors;
  if (code !== undefined) details.code = code;

  const body: Record<string, unknown> = { error: message, status };
  if (Object.keys(details).length > 0) body.details = details;
  return body;
}
