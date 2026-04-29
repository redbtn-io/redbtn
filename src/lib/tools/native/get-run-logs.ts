/**
 * Get Run Logs — Native Run Tool
 *
 * Fetches all redlog entries captured during a run via the webapp API
 * (`GET /api/v1/runs/:runId/logs`).
 *
 * Spec: TOOL-HANDOFF.md §4.11
 *   - inputs: runId, limit?, level? ('debug' | 'info' | 'warn' | 'error')
 *   - output: { logs: [...], hasMore }
 *
 * The webapp route returns every log captured by the redlog reader for the
 * given run (indexed by `generationId === runId`) in ascending order. It
 * does NOT page server-side — `limit` and `level` are applied here on the
 * client to keep the agent-facing payload bounded.
 *
 * Default limit is 200; max is 1000. Level acts as a "minimum severity"
 * filter so `level: 'warn'` returns warn + error.
 *
 * Use this for:
 *   - root-causing a failed run by inspecting its log timeline
 *   - audit trails when an automation produces unexpected output
 *   - diagnosing slow nodes (logs include timing metadata)
 *
 * For the live event stream (message_chunk / tool_event / etc.) use the
 * SSE endpoint at `/api/v1/runs/:runId/stream`, not this tool.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetRunLogsArgs {
  runId?: string;
  limit?: number;
  level?: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// Severity ordering — `level` acts as a minimum-severity filter.
// debug < info < warn < error.
const LEVEL_RANK: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  warning: 2,
  error: 3,
  err: 3,
  fatal: 3,
};

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const authToken =
    (context?.state?.authToken as string | undefined) ||
    (context?.state?.data?.authToken as string | undefined);
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

const getRunLogsTool: NativeToolDefinition = {
  description:
    "Fetch redlog entries captured during a single run (debug / info / warn / error). Use for root-causing failures, audit trails, or timing analysis. NOT the live event stream — for streaming chunks/tool events use the SSE endpoint instead. Logs are filtered client-side by `level` (minimum severity) and capped by `limit` (default 200, max 1000); `hasMore` indicates the route returned more entries than the limit.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'The runId of the run to fetch logs for.',
      },
      limit: {
        type: 'integer',
        description: `Maximum number of log entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
      level: {
        type: 'string',
        enum: ['debug', 'info', 'warn', 'error'],
        description:
          "Minimum severity to return. `'warn'` returns warn + error, `'info'` returns info + warn + error, etc.",
      },
    },
    required: ['runId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetRunLogsArgs>;
    const runId = typeof args.runId === 'string' ? args.runId.trim() : '';

    if (!runId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'runId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // Validate level early so an invalid level gives a clear error instead of
    // silently returning an empty array.
    const level = args.level as string | undefined;
    if (level !== undefined && LEVEL_RANK[level] === undefined) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Invalid level: must be one of debug, info, warn, error`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }
    const minRank = level !== undefined ? LEVEL_RANK[level] : -1;

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit))))
        : DEFAULT_LIMIT;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/logs`;

    let response: Response;
    try {
      response = await fetch(url, { headers: buildHeaders(context) });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, runId }) },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      let errBody = '';
      try {
        errBody = await response.text();
      } catch {
        /* ignore */
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Run logs API ${response.status} ${response.statusText}` +
                (errBody ? `: ${errBody.slice(0, 200)}` : ''),
              status: response.status,
              runId,
            }),
          },
        ],
        isError: true,
      };
    }

    let data: AnyObject;
    try {
      data = (await response.json()) as AnyObject;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: `Invalid JSON: ${message}`, runId }) },
        ],
        isError: true,
      };
    }

    const allLogs = Array.isArray(data?.logs) ? (data.logs as AnyObject[]) : [];

    // Apply level filter (severity ≥ minRank). Unknown severities pass through
    // — we'd rather over-include than silently drop a malformed entry.
    const filtered =
      minRank >= 0
        ? allLogs.filter((entry) => {
            const lvl = String(entry?.level ?? '').toLowerCase();
            const rank = LEVEL_RANK[lvl];
            return rank === undefined ? true : rank >= minRank;
          })
        : allLogs;

    const hasMore = filtered.length > limit;
    const logs = hasMore ? filtered.slice(0, limit) : filtered;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            runId,
            count: logs.length,
            totalAvailable: filtered.length,
            limit,
            level: level ?? null,
            hasMore,
            logs,
          }),
        },
      ],
    };
  },
};

export default getRunLogsTool;
module.exports = getRunLogsTool;
