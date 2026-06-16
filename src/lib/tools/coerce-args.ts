/**
 * Schema-aware coercion of stringified-JSON tool arguments.
 *
 * ## The problem
 *
 * In the native tool-use loop (`neuronExecutor.runNativeToolUseLoop`) the model
 * produces each tool call's arguments. LangChain parses the outer arguments
 * blob into an object, but some models (especially smaller / local ones) emit a
 * STRUCTURED FIELD as a string — e.g. `{ tags: "[\"a\"]" }` or
 * `{ config: "{\"x\":1}" }` instead of `{ tags: ["a"] }` / `{ config: {x:1} }`.
 * The string is then forwarded verbatim to the tool, which sends it to an API
 * that validates against a JSON Schema → the structured field is rejected
 * (e.g. AJV 422) and the call silently fails.
 *
 * ## The fix
 *
 * Walk the model's args against the tool's own `inputSchema` and parse a string
 * value back into the type the schema requires — but ONLY when it is
 * unambiguously safe, so a legitimate string is never mangled.
 *
 * Coercion rules (conservative by design):
 *   - A string is parsed ONLY when the position's schema declares a `type` that
 *     does NOT include `'string'` (so a `type: 'string'` field whose value is
 *     `"true"` or `"42"` is left exactly as the model sent it), AND
 *   - `JSON.parse` succeeds AND the parsed value's JSON type is in the schema's
 *     allowed set (an integer also satisfies `number`, and vice-versa when the
 *     float is integral). A parse that yields the wrong type is left as-is so
 *     downstream validation still surfaces the real mistake.
 *   - When the schema has no `type` at the position (any-typed `value` params,
 *     `anyOf`/`oneOf`/`$ref`, `additionalProperties` keys) NOTHING is coerced —
 *     there is no safe signal, so it's left for the server (which knows the real
 *     target schema) to handle.
 *
 * The walk recurses into declared object `properties` and array `items`, so a
 * stringified field nested inside an object or array element is handled too.
 *
 * Pure + side-effect free: returns new values, never mutates the input.
 */

/** A (loosely-typed) JSON Schema fragment. */
type JsonSchema = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** The set of JSON-Schema type names allowed at a schema position. */
function allowedTypes(schema: JsonSchema | undefined): Set<string> {
  if (!isPlainObject(schema)) return new Set();
  const t = schema.type;
  if (typeof t === 'string') return new Set([t]);
  if (Array.isArray(t)) {
    return new Set(t.filter((x): x is string => typeof x === 'string'));
  }
  return new Set();
}

/** JSON-Schema type name for a runtime value (`integer` distinguished). */
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'number') {
    return Number.isInteger(v as number) ? 'integer' : 'number';
  }
  return t; // 'string' | 'boolean' | 'object'
}

/** Whether a parsed value satisfies the schema's allowed type set. */
function typeSatisfies(parsed: unknown, allowed: Set<string>): boolean {
  const pt = jsonTypeOf(parsed);
  if (allowed.has(pt)) return true;
  // JSON Schema: an integer is a valid `number`.
  if (pt === 'integer' && allowed.has('number')) return true;
  // An integral float is a valid `integer`.
  if (
    pt === 'number' &&
    allowed.has('integer') &&
    Number.isInteger(parsed as number)
  ) {
    return true;
  }
  return false;
}

/**
 * Recursively coerce stringified structured values in `value` to match
 * `schema`. Returns a new value; never mutates the input.
 */
export function coerceValueToSchema(
  value: unknown,
  schema: JsonSchema | undefined,
): unknown {
  // ── String → maybe parse to the structured/scalar type the schema needs ──
  if (typeof value === 'string') {
    const allowed = allowedTypes(schema);
    // Only act when the schema forbids strings here (else the string is legit).
    if (allowed.size > 0 && !allowed.has('string')) {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          return value; // not JSON — leave it for validation to flag
        }
        if (typeSatisfies(parsed, allowed)) {
          // Recurse so a doubly-stringified nested field is handled too.
          return coerceValueToSchema(parsed, schema);
        }
      }
    }
    return value;
  }

  // ── Object → recurse into each declared property present on the value ──
  if (isPlainObject(value)) {
    const props = isPlainObject(schema?.properties)
      ? (schema!.properties as Record<string, JsonSchema>)
      : undefined;
    if (!props) return value;
    let changed = false;
    const out: Record<string, unknown> = { ...value };
    for (const k of Object.keys(out)) {
      const sub = props[k];
      if (!sub) continue;
      const coerced = coerceValueToSchema(out[k], sub);
      if (coerced !== out[k]) {
        out[k] = coerced;
        changed = true;
      }
    }
    return changed ? out : value;
  }

  // ── Array → recurse into each element using the items schema ──
  if (Array.isArray(value)) {
    const items = isPlainObject(schema?.items)
      ? (schema!.items as JsonSchema)
      : undefined;
    if (!items) return value;
    let changed = false;
    const out = value.map((el) => {
      const coerced = coerceValueToSchema(el, items);
      if (coerced !== el) changed = true;
      return coerced;
    });
    return changed ? out : value;
  }

  return value;
}

/**
 * Coerce a tool's top-level args object against its `inputSchema`. Safe to call
 * with any input; returns the original object reference when nothing changed.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  inputSchema: JsonSchema | undefined,
): Record<string, unknown> {
  if (!isPlainObject(args)) return args;
  const coerced = coerceValueToSchema(args, inputSchema);
  return isPlainObject(coerced) ? coerced : args;
}
