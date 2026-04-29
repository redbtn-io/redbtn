/**
 * Write Log — Native Logs Tool
 *
 * Spec: TOOL-HANDOFF.md §4.12
 *   - inputs: level, message, category?, metadata?
 *   - output: { ok: true }
 *
 * Writes a single structured entry into the shared `@redbtn/redlog` store
 * (Redis fan-out + MongoDB persistence). The entry is automatically scoped
 * to the caller's `runId` (as `generationId`, matching the indexing
 * convention used by RunPublisher) and `conversationId` when those values
 * are present on the tool execution context, so the entry shows up in the
 * existing log viewers (`<LogViewer>`, `/api/v1/logs/conversations/:id`,
 * `/api/v1/runs/:runId/logs`) without any manual wiring.
 *
 * Use this when:
 *   - an agent needs to leave a structured breadcrumb for diagnostics,
 *   - an automation wants to mark a milestone with a category,
 *   - a node wants to attach metadata that an upstream tool did not.
 *
 * The level set here matches `@redbtn/redlog`'s LOG_LEVELS:
 *   debug | info | success | warn | error | fatal
 *
 * Implementation note: we go direct to RedLog (no HTTP hop). The package
 * is already a peer dep of the engine and the worker process owns the
 * same Redis + Mongo connection strings, so an in-process write is the
 * cleanest path. There is no `/api/v1/logs` write endpoint — write paths
 * exist only via worker-side RunPublisher today, and this tool gives
 * graphs and agents a parallel, scoped writer.
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

const MAX_MESSAGE_LEN = 8192; // hard cap to keep one bad call from blowing up Redis

interface WriteLogArgs {
  level?: string;
  message?: string;
  category?: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lazy RedLog singleton — created on first call, reused across invocations.
// We mirror webapp/src/lib/redlog.ts so the entry lands in the same Redis
// keyspace + Mongo collection that the readers query.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redlog: any = null;

function getRedLog(): unknown {
  if (_redlog) return _redlog;

  // Dynamic require so engine builds without redlog still load (it is a
  // peer dep — declared in package.json `peerDependencies`).
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
  const { RedLog } = require('@redbtn/redlog') as { RedLog: any };

  _redlog = RedLog.create({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    mongoUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/redbtn',
    prefix: 'redlog',
    namespace: 'tool',
    console: false,
  });

  return _redlog;
}

// Allow tests to override the singleton — keeps unit tests hermetic (no
// real Redis/Mongo connection required).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __setRedLogForTest(instance: any): void {
  _redlog = instance;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function __getRedLogForTest(): any {
  return _redlog;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickString(...vals: Array<unknown>): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

const writeLogTool: NativeToolDefinition = {
  description:
    "Write a single structured log entry into the shared redlog store (Redis + MongoDB). The entry is auto-scoped to the caller's runId and conversationId so it shows up in conversation and run log viewers without extra wiring. Levels: debug, info, success, warn, error, fatal. Use to leave diagnostic breadcrumbs, mark milestones, or attach structured metadata mid-graph.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      level: {
        type: 'string',
        enum: [...VALID_LEVELS],
        description: 'Severity level. One of debug | info | success | warn | error | fatal.',
      },
      message: {
        type: 'string',
        description: `Human-readable message. May contain redlog color tags (e.g. <red>boom</red>). Capped at ${MAX_MESSAGE_LEN} chars.`,
      },
      category: {
        type: 'string',
        description:
          "Optional free-form category (e.g. 'tool', 'llm', 'system', 'milestone'). Used by log viewers for grouping and the category filter on /api/v1/logs/conversations/:id.",
      },
      metadata: {
        type: 'object',
        description:
          'Arbitrary structured metadata (object). Will be JSON-encoded and stored alongside the entry.',
      },
    },
    required: ['level', 'message'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<WriteLogArgs>;

    // --- Validation -----------------------------------------------------------
    const level = typeof args.level === 'string' ? args.level.toLowerCase() : '';
    if (!level || !(VALID_LEVELS as readonly string[]).includes(level)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `level is required and must be one of ${VALID_LEVELS.join(', ')}`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const rawMessage = typeof args.message === 'string' ? args.message : '';
    if (!rawMessage.trim()) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'message is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }
    const message =
      rawMessage.length > MAX_MESSAGE_LEN
        ? rawMessage.slice(0, MAX_MESSAGE_LEN)
        : rawMessage;

    const category = typeof args.category === 'string' ? args.category : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : undefined;

    // --- Scope (auto-derived from context) ------------------------------------
    // Match the convention used by RunPublisher (run-publisher.ts:176): runId
    // is stored under `generationId` so existing readers find it, and
    // conversationId comes from state when present.
    const runId =
      pickString(
        context?.runId,
        (context?.state as AnyObject | undefined)?.runId,
        (context?.state as AnyObject | undefined)?.data?.runId,
      ) ?? undefined;

    const conversationId =
      pickString(
        (context?.state as AnyObject | undefined)?.conversationId,
        (context?.state as AnyObject | undefined)?.data?.conversationId,
      ) ?? undefined;

    const userId =
      pickString(
        (context?.state as AnyObject | undefined)?.userId,
        (context?.state as AnyObject | undefined)?.data?.userId,
      ) ?? undefined;

    const nodeId = pickString(context?.nodeId) ?? undefined;

    const scope: Record<string, string> = {};
    if (conversationId) scope.conversationId = conversationId;
    if (runId) scope.generationId = runId;
    if (userId) scope.userId = userId;
    if (nodeId) scope.nodeId = nodeId;

    // Extra context goes into metadata so it's visible in the log viewer
    // alongside whatever the caller passed.
    const meta: Record<string, unknown> = {
      ...(metadata ?? {}),
      source: 'write_log',
      ...(runId ? { runId } : {}),
      ...(nodeId ? { nodeId } : {}),
      ...(context?.toolId ? { toolId: context.toolId } : {}),
    };

    // --- Write ---------------------------------------------------------------
    let redlog: { log: (p: AnyObject) => Promise<void> };
    try {
      redlog = getRedLog() as { log: (p: AnyObject) => Promise<void> };
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to initialize redlog: ${errorMessage}`,
              code: 'INIT',
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      await redlog.log({
        level: level as ValidLevel,
        message,
        category,
        scope: Object.keys(scope).length ? scope : undefined,
        metadata: meta,
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to write log entry: ${errorMessage}`,
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            level,
            scope: {
              conversationId: conversationId ?? null,
              runId: runId ?? null,
            },
            category: category ?? null,
            messageLength: message.length,
            truncated: rawMessage.length > MAX_MESSAGE_LEN,
          }),
        },
      ],
    };
  },
};

export default writeLogTool;
// Dual CommonJS export — runtime registry calls `require('./native/write-log.js')`
// and reads `.default || ...`. The vitest config strips this line for ESM tests.
module.exports = writeLogTool;
