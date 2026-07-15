/**
 * Normalize MCP-compatible `isError` envelopes into an Error message.
 *
 * Native tools and remote MCP tools share the same result shape. Error payloads
 * are not constrained to strings, though: web APIs commonly return structured
 * `{ error: { message, code } }` data. Keep formatting defensive so an error
 * result can never turn into a formatter TypeError and hide the actual failure.
 */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
    return value !== null && typeof value === 'object';
}

function errorField(value: unknown): unknown {
    if (!isRecord(value)) return undefined;
    return value.error ?? value.message;
}

function stringifyErrorDetail(detail: unknown): string {
    if (typeof detail === 'string') return detail;
    if (detail instanceof Error) return detail.message || detail.name;

    try {
        const serialized = JSON.stringify(detail);
        if (typeof serialized === 'string') return serialized;
    } catch {
        // Fall through to String(), which is useful for circular envelopes.
    }

    try {
        return String(detail);
    } catch {
        return '[unserializable error detail]';
    }
}

/**
 * Return a bounded, model-readable message for an MCP-compatible error result,
 * or null when the result is not an error envelope.
 */
export function getToolResultErrorMessage(
    result: unknown,
    toolName: string,
    source: 'MCP' | 'Native' | 'Parser' = 'MCP',
): string | null {
    if (!isRecord(result) || result.isError !== true) {
        return null;
    }

    let detail: unknown;
    if (Array.isArray(result.content)) {
        const textBlock = result.content.find(
            (block: unknown) => isRecord(block) && block.type === 'text' && typeof block.text === 'string',
        );
        if (textBlock && typeof textBlock.text === 'string' && textBlock.text) {
            try {
                const parsed: unknown = JSON.parse(textBlock.text);
                detail = errorField(parsed) ?? textBlock.text;
            } catch {
                // A plain-text MCP error is still the most useful diagnostic.
                detail = textBlock.text;
            }
        }
    }

    // Some native adapters return a top-level `{ error | message }`; support
    // that shape before falling back to the complete envelope.
    if (detail === undefined || detail === null || detail === '') {
        detail = errorField(result) ?? result;
    }

    return `${source} tool "${toolName}" returned error: ${stringifyErrorDetail(detail).slice(0, 1000)}`;
}
