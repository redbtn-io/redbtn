/**
 * Generate ID — Native Utility Tool
 *
 * Produce a fresh identifier in one of three flavours, with an optional
 * caller-supplied prefix.
 *
 * Spec: TOOL-HANDOFF.md §4.15
 *   - inputs: format? ('uuid' | 'short' | 'numeric', default 'uuid'),
 *             prefix? (string)
 *   - output: { id: string }
 *
 * Implementation:
 *   - 'uuid'    → `crypto.randomUUID()` — RFC 4122 v4 UUID, 36 chars,
 *                 collision-free for any realistic workload.
 *   - 'short'   → 8-character URL-safe ID generated from
 *                 `crypto.randomBytes()` over the standard nanoid alphabet
 *                 (A-Za-z0-9_-). We don't pull in the `nanoid` package —
 *                 8 bytes of entropy worth of bias-free indexing into a
 *                 64-char alphabet is trivial to roll inline and avoids the
 *                 dependency.
 *   - 'numeric' → 12-digit random string (no leading-zero stripping). 12
 *                 digits is the longest run safely representable both as a
 *                 plain string AND as a JS number, and gives ~40 bits of
 *                 entropy — fine for most agent-side correlation IDs.
 *   - Prefix is concatenated verbatim. We do NOT inject a separator (`-`,
 *     `_`, etc.) — callers that want one should include it in their prefix.
 *     This keeps the tool predictable and lets prefixes like
 *     `"req:"` work just as cleanly as `"req-"`.
 */

import { randomUUID, randomBytes } from 'crypto';
import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GenerateIdArgs {
  format?: 'uuid' | 'short' | 'numeric';
  prefix?: string;
}

const DEFAULT_FORMAT: 'uuid' | 'short' | 'numeric' = 'uuid';
const ALLOWED_FORMATS: ReadonlyArray<'uuid' | 'short' | 'numeric'> = [
  'uuid',
  'short',
  'numeric',
];

// Standard nanoid URL-safe alphabet — 64 characters so we can map a single
// byte to one symbol via `byte & 0x3f` with zero modulo bias.
const NANOID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const SHORT_LENGTH = 8;
const NUMERIC_LENGTH = 12;

function validationError(message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

/**
 * Generate `length` characters by mapping each random byte (top 6 bits) into
 * the 64-character nanoid alphabet. Uses a 0x3f mask so there's no modulo
 * bias.
 */
function shortId(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += NANOID_ALPHABET[bytes[i] & 0x3f];
  }
  return out;
}

/**
 * Generate `length` random decimal digits. Each digit costs one random byte;
 * we re-roll any byte ≥ 250 to keep the modulo distribution unbiased
 * (250 = 25 × 10 is the largest multiple of 10 ≤ 256).
 */
function numericId(length: number): string {
  let out = '';
  while (out.length < length) {
    const buf = randomBytes(Math.max(length - out.length, 8));
    for (let i = 0; i < buf.length && out.length < length; i++) {
      const b = buf[i];
      if (b < 250) out += String(b % 10);
    }
  }
  return out;
}

const generateIdTool: NativeToolDefinition = {
  description:
    'Generate a fresh identifier. format="uuid" returns an RFC 4122 v4 UUID; "short" returns an 8-char URL-safe nanoid; "numeric" returns a 12-digit random string. Optional prefix is concatenated verbatim. Use to mint correlation IDs, idempotency keys, ephemeral object names, etc.',
  server: 'utility',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['uuid', 'short', 'numeric'],
        description:
          'ID flavour. "uuid" = 36-char RFC 4122 v4 UUID. "short" = 8-char URL-safe nanoid. "numeric" = 12-digit random string.',
        default: DEFAULT_FORMAT,
      },
      prefix: {
        type: 'string',
        description:
          'Optional string to prepend to the generated ID. No separator is added — include one in the prefix if you want it (e.g. "req-" or "req:").',
      },
    },
    required: [],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<GenerateIdArgs>;

    let format: 'uuid' | 'short' | 'numeric' = DEFAULT_FORMAT;
    if (args.format !== undefined) {
      if (
        typeof args.format !== 'string' ||
        !ALLOWED_FORMATS.includes(args.format as 'uuid' | 'short' | 'numeric')
      ) {
        return validationError(
          `format must be one of: ${ALLOWED_FORMATS.join(', ')}`,
        );
      }
      format = args.format as 'uuid' | 'short' | 'numeric';
    }

    let prefix = '';
    if (args.prefix !== undefined && args.prefix !== null) {
      if (typeof args.prefix !== 'string') {
        return validationError('prefix must be a string when provided');
      }
      prefix = args.prefix;
    }

    try {
      let body: string;
      switch (format) {
        case 'uuid':
          body = randomUUID();
          break;
        case 'short':
          body = shortId(SHORT_LENGTH);
          break;
        case 'numeric':
          body = numericId(NUMERIC_LENGTH);
          break;
      }
      const id = prefix + body;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ id }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `generate_id failed: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default generateIdTool;
module.exports = generateIdTool;
