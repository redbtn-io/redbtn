/**
 * Now — Native Utility Tool
 *
 * Return the current time in a requested timezone and format.
 * Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.15
 *   - inputs: timezone? (string, default 'UTC'),
 *             format?  ('iso' | 'unix' | 'human', default 'iso')
 *   - output: { time: string, timezone: string, unix: number }
 *
 * Implementation:
 *   - All three formats are derived from a single `new Date()` snapshot so
 *     the `unix` field is always consistent with whatever string is in `time`.
 *   - `iso`     → standard ISO-8601 UTC string from `Date.toISOString()`.
 *   - `unix`    → seconds since epoch as a string (the `unix` field on the
 *                 result object always carries the numeric form too — the
 *                 string in `time` is just for display).
 *   - `human`   → timezone-aware locale string built with
 *                 `Intl.DateTimeFormat`. Defaults to en-US, full date + 24h
 *                 time + timezone abbreviation, so the output is consistent
 *                 across machines regardless of the host locale.
 *   - Validates the supplied IANA timezone via `Intl.DateTimeFormat`; an
 *     invalid timezone throws RangeError, which we surface as a VALIDATION
 *     error.
 *   - Empty/whitespace timezone strings fall back to 'UTC' rather than
 *     erroring — matches the documented default behaviour.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface NowArgs {
  timezone?: string;
  format?: 'iso' | 'unix' | 'human';
}

const DEFAULT_TIMEZONE = 'UTC';
const DEFAULT_FORMAT: 'iso' | 'unix' | 'human' = 'iso';
const ALLOWED_FORMATS: ReadonlyArray<'iso' | 'unix' | 'human'> = [
  'iso',
  'unix',
  'human',
];

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
 * Validate the supplied IANA timezone via Intl. Empty/undefined → 'UTC'.
 * Throws (caught by the handler) when the timezone is unknown.
 */
function resolveTimezone(input: unknown): string {
  if (input === undefined || input === null) return DEFAULT_TIMEZONE;
  if (typeof input !== 'string') {
    throw new Error('timezone must be a string when provided');
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) return DEFAULT_TIMEZONE;
  // Probe the timezone — RangeError on unknown zone identifiers.
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid timezone "${trimmed}": ${msg}`);
  }
  return trimmed;
}

/**
 * Build a human-readable string for `now` in the given timezone. We use a
 * fixed en-US locale with explicit options so the output is stable across
 * hosts. The timezone short name is appended via the `timeZoneName` option.
 */
function formatHuman(date: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return fmt.format(date);
}

const nowTool: NativeToolDefinition = {
  description:
    'Return the current time in a requested timezone and format. Use to stamp logs, schedule branches on time-of-day, or include the current moment in prompts. Defaults: timezone="UTC", format="iso".',
  server: 'utility',
  inputSchema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description:
          'IANA timezone identifier (e.g. "UTC", "America/New_York", "Asia/Tokyo"). Defaults to "UTC".',
        default: DEFAULT_TIMEZONE,
      },
      format: {
        type: 'string',
        enum: ['iso', 'unix', 'human'],
        description:
          'Output format for the `time` field. "iso" = ISO-8601 UTC, "unix" = seconds since epoch, "human" = locale-formatted string in the requested timezone. Defaults to "iso".',
        default: DEFAULT_FORMAT,
      },
    },
    required: [],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<NowArgs>;

    let timezone: string;
    try {
      timezone = resolveTimezone(args.timezone);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return validationError(message);
    }

    let format: 'iso' | 'unix' | 'human' = DEFAULT_FORMAT;
    if (args.format !== undefined) {
      if (
        typeof args.format !== 'string' ||
        !ALLOWED_FORMATS.includes(args.format as 'iso' | 'unix' | 'human')
      ) {
        return validationError(
          `format must be one of: ${ALLOWED_FORMATS.join(', ')}`,
        );
      }
      format = args.format as 'iso' | 'unix' | 'human';
    }

    try {
      const date = new Date();
      const unix = Math.floor(date.getTime() / 1000);

      let time: string;
      if (format === 'iso') {
        time = date.toISOString();
      } else if (format === 'unix') {
        time = String(unix);
      } else {
        time = formatHuman(date, timezone);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ time, timezone, unix }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `now failed: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default nowTool;
module.exports = nowTool;
