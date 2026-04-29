/**
 * Query Logs — Native Logs Tool
 *
 * Spec: TOOL-HANDOFF.md §4.12
 *   - inputs: runId? | conversationId?, category?, level?, limit?
 *   - output: { logs: [...] }
 *
 * Reads structured log entries directly from the shared `@redbtn/redlog`
 * store via `LogReader.query`. The tool requires either `runId` or
 * `conversationId` so the query is bounded — no global scans (those are
 * expensive and cross-tenant).
 *
 * Filters:
 *   - level     — minimum severity (debug | info | success | warn | error | fatal)
 *   - category  — exact-match category filter (e.g. 'tool', 'llm')
 *   - limit     — cap entries returned (default 200, max 1000)
 *
 * Returns logs in ascending timestamp order to match the conventions of
 * the existing log viewers.
 *
 * Implementation note: we go direct to `LogReader` instead of round-tripping
 * through the webapp's `/api/v1/logs/...` endpoints because:
 *   1. The webapp only exposes a per-conversation endpoint
 *      (`/api/v1/logs/conversations/:id`) and a per-run endpoint
 *      (`/api/v1/runs/:runId/logs`); both serve the same LogReader.query.
 *   2. There is no webapp endpoint that supports both scopes with one tool
 *      handler — implementing this directly avoids the URL-routing
 *      branch.
 *   3. Worker / engine processes already share the Redis + Mongo connection
 *      strings, so no auth hop is needed; any tool already inside the
 *      engine that has the runId/conversationId in its context has, by
 *      definition, been authorized to be in that run.
 *
 * If running outside an engine context (e.g. from a webapp route), the
 * caller's auth was checked at HTTP boundary; tools never receive a
 * conversationId or runId they aren't entitled to (the universalNode
 * passes those through from the bound run state).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const VALID_LEVELS = ['debug', 'info', 'success', 'warn', 'error', 'fatal'] as const;
type ValidLevel = (typeof VALID_LEVELS)[number];

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

interface QueryLogsArgs {
  runId?: string;
  conversationId?: string;
  category?: string;
  level?: string;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Lazy LogReader singleton — created on first call, reused across invocations.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _reader: any = null;

function getLogReader(): unknown {
  if (_reader) return _reader;

  // Dynamic require so engine builds without redlog still load (it is a
  // peer dep — declared in package.json `peerDependencies`).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const { LogReader } = require('@redbtn/redlog') as { LogReader: any };

  _reader = new LogReader({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/redbtn',
    prefix: 'redlog',
    console: false,
  });

  return _reader;
}

// Allow tests to override the singleton for hermetic unit tests.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setLogReaderForTest(instance: any): void {
  _reader = instance;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __getLogReaderForTest(): any {
  return _reader;
}

const queryLogsTool: NativeToolDefinition = {
  description:
    "Query structured log entries by runId or conversationId. At least one of (runId, conversationId) is required — this is a bounded scope query, not a global scan. Filters: level (minimum severity: debug/info/success/warn/error/fatal), category (exact match), limit (default 200, max 1000). Logs come back in ascending timestamp order matching the conversation and run log viewers.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description:
          'Bind the query to a single run. Internally maps to scope.generationId (the redlog convention).',
      },
      conversationId: {
        type: 'string',
        description: 'Bind the query to a single conversation.',
      },
      category: {
        type: 'string',
        description: "Exact-match category filter (e.g. 'tool', 'llm', 'system').",
      },
      level: {
        type: 'string',
        enum: [...VALID_LEVELS],
        description:
          "Minimum severity to return. 'warn' returns warn + error + fatal; 'info' returns info + success + warn + error + fatal; etc.",
      },
      limit: {
        type: 'integer',
        description: `Maximum number of entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    // At least one of runId | conversationId is required. JSON Schema's
    // anyOf handles this; the handler also validates explicitly so the
    // error message is actionable.
    anyOf: [{ required: ['runId'] }, { required: ['conversationId'] }],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<QueryLogsArgs>;

    // --- Validation -----------------------------------------------------------
    const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
    const conversationId =
      typeof args.conversationId === 'string' ? args.conversationId.trim() : '';

    if (!runId && !conversationId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'At least one of runId or conversationId is required',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    let level: ValidLevel | undefined;
    if (args.level !== undefined) {
      const lvl = String(args.level).toLowerCase();
      if (!(VALID_LEVELS as readonly string[]).includes(lvl)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `level must be one of ${VALID_LEVELS.join(', ')}`,
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }
      level = lvl as ValidLevel;
    }

    const category =
      typeof args.category === 'string' && args.category.length > 0
        ? args.category
        : undefined;

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit)) && Number(args.limit) > 0
        ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(Number(args.limit))))
        : DEFAULT_LIMIT;

    // --- Build scope ---------------------------------------------------------
    // runId maps to generationId (redlog indexing convention — see RunPublisher
    // and the /api/v1/runs/:runId/logs route, both of which use generationId).
    const scope: Record<string, string> = {};
    if (runId) scope.generationId = runId;
    if (conversationId) scope.conversationId = conversationId;

    // --- Query ----------------------------------------------------------------
    let reader: { query: (q: AnyObject) => Promise<AnyObject[]> };
    try {
      reader = getLogReader() as { query: (q: AnyObject) => Promise<AnyObject[]> };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to initialize log reader: ${errorMessage}`,
              code: 'INIT',
            }),
          },
        ],
        isError: true,
      };
    }

    let logs: AnyObject[];
    try {
      logs = await reader.query({
        scope,
        ...(level ? { level } : {}),
        ...(category ? { category } : {}),
        limit,
        order: 'asc',
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Query failed: ${errorMessage}`,
              scope,
            }),
          },
        ],
        isError: true,
      };
    }

    const safeLogs = Array.isArray(logs) ? logs : [];

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            count: safeLogs.length,
            limit,
            scope: {
              runId: runId || null,
              conversationId: conversationId || null,
            },
            level: level ?? null,
            category: category ?? null,
            logs: safeLogs,
          }),
        },
      ],
    };
  },
};

export default queryLogsTool;
// Dual CommonJS export — runtime registry calls `require('./native/query-logs.js')`
// and reads `.default || ...`. The vitest config strips this line for ESM tests.
module.exports = queryLogsTool;
