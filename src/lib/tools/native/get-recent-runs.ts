/**
 * Get Recent Runs — Native System Tool
 *
 * Reads the archived `runEvents` collection to expose recent graph-run
 * history as a context source. Mirrors the GET /api/v1/graphs/:graphId/runs
 * webapp endpoint but runs in-process for graphs.
 *
 * The `runEvents` collection is populated unconditionally for every BullMQ
 * graph execution by the run-archiver (60-day TTL). This tool simply
 * surfaces what is already stored — no new auto-save infra.
 *
 * Use cases:
 *   - A graph reads its own (or a sibling graph's) prior outputs as
 *     context for a new run, alongside Global State / conversation
 *     history / Knowledge Library RAG.
 *   - Subagent graphs reading the parent graph's recent decisions.
 *
 * Access model: caller must be the graph owner, an explicit participant,
 * or the graph must be public/system. Mirrors `verifyGraphAccess` on the
 * webapp side. Rejects with isError when forbidden.
 */

import mongoose from 'mongoose';
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetRecentRunsArgs {
  graphId: string;
  limit?: number;
  includeOutput?: boolean;
  status?: 'completed' | 'error' | 'interrupted' | 'running';
  since?: string;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// `interrupted` is the public-facing status for a non-terminal exit; the
// archiver writes `unknown` to the DB for that case. Translate here so
// callers don't need to know the implementation detail.
const STATUS_API_TO_DB: Record<string, string> = {
  completed: 'completed',
  error: 'error',
  interrupted: 'unknown',
  running: 'running',
};

/**
 * Pull the `output` payload off the `run_complete` event, if present.
 * Returns null when the run hasn't completed (still running, errored, or
 * stalled). Iterates in reverse since the terminal event is at the tail.
 */
function extractOutput(events: AnyObject[] | undefined): unknown {
  if (!events || events.length === 0) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'run_complete') {
      return ev?.data?.output ?? null;
    }
  }
  return null;
}

/**
 * Resolve the caller's role on a graph using the same precedence the
 * webapp's `verifyResourceAccess` uses:
 *   1. participants[].userId === userId          → that role
 *   2. graph.userId === userId                    → owner
 *   3. graph.isPublic === true                    → viewer
 *   4. graph.isSystem === true || userId==='system' → viewer
 *   5. otherwise → null (forbidden)
 */
function resolveGraphRole(graph: AnyObject, userId: string): 'owner' | 'member' | 'viewer' | null {
  const participants = graph?.participants as Array<{ userId: string; role: string }> | undefined;
  if (Array.isArray(participants) && participants.length > 0) {
    const p = participants.find(x => x?.userId === userId);
    if (p?.role === 'owner' || p?.role === 'member' || p?.role === 'viewer') {
      return p.role;
    }
  }
  if (graph?.userId && String(graph.userId) === userId) {
    return 'owner';
  }
  if (graph?.isPublic === true) {
    return 'viewer';
  }
  if (graph?.isSystem === true || graph?.userId === 'system') {
    return 'viewer';
  }
  return null;
}

const getRecentRuns: NativeToolDefinition = {
  description:
    'Fetch recent run history for a graph (mine or another, if I have access). Returns metadata + optionally final output state. Use this to read prior run outputs as context for a new run, alongside Global State, conversation history, and Knowledge Library RAG.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'Graph to query.',
      },
      limit: {
        type: 'number',
        description: `Maximum runs to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        default: DEFAULT_LIMIT,
        maximum: MAX_LIMIT,
      },
      includeOutput: {
        type: 'boolean',
        description: 'Include each run\'s final-state output (heavier payload). Default true.',
        default: true,
      },
      status: {
        type: 'string',
        enum: ['completed', 'error', 'interrupted', 'running'],
        description: 'Filter by run status.',
      },
      since: {
        type: 'string',
        format: 'date-time',
        description: 'Only return runs started after this ISO timestamp.',
      },
    },
    required: ['graphId'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as GetRecentRunsArgs;
    const { graphId, status, since } = args;
    const includeOutput = args.includeOutput !== false; // default true
    const requestedLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.floor(args.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    if (!graphId || typeof graphId !== 'string') {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'graphId is required' }) }],
        isError: true,
      };
    }

    if (status && !STATUS_API_TO_DB[status]) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Invalid status: must be one of ${Object.keys(STATUS_API_TO_DB).join(', ')}`,
            }),
          },
        ],
        isError: true,
      };
    }

    let sinceDate: Date | null = null;
    if (since) {
      const d = new Date(since);
      if (Number.isNaN(d.getTime())) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Invalid `since`: must be an ISO date' }) }],
          isError: true,
        };
      }
      sinceDate = d;
    }

    // Resolve caller userId from graph state. Mirrors the convention used
    // by neuronExecutor / graphExecutor — `state.userId` first, fall back
    // to `state.data.userId` for callers that nest under data.
    const callerUserId =
      (context?.state?.userId as string | undefined) ||
      (context?.state?.data?.userId as string | undefined) ||
      null;

    if (!callerUserId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'No userId available in graph state — cannot perform access check',
            }),
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();
    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'get_recent_runs';

    try {
      const db = mongoose.connection.db;
      if (!db) throw new Error('MongoDB connection not available');

      // ── 1. Access check ──────────────────────────────────────────────
      const graphsCol = db.collection('graphs');
      const graph = await graphsCol.findOne({ graphId });
      if (!graph) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Graph not found: ${graphId}` }) }],
          isError: true,
        };
      }

      const role = resolveGraphRole(graph, callerUserId);
      if (!role) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Forbidden: caller does not have access to graph ${graphId}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── 2. Build query ───────────────────────────────────────────────
      const query: AnyObject = { graphId };
      if (status) {
        query.status = STATUS_API_TO_DB[status];
      }
      if (sinceDate) {
        query.startedAt = { $gt: sinceDate };
      }

      // Project only what we need. Pull `events` only when output requested.
      const projection: AnyObject = {
        runId: 1,
        status: 1,
        startedAt: 1,
        completedAt: 1,
        conversationId: 1,
        automationId: 1,
        trigger: 1,
      };
      if (includeOutput) {
        projection.events = 1;
      }

      // ── 3. Fetch ─────────────────────────────────────────────────────
      const runEventsCol = db.collection('runEvents');
      const docs = await runEventsCol
        .find(query, { projection })
        .sort({ startedAt: -1 })
        .limit(requestedLimit)
        .toArray();

      const runs = docs.map((d: AnyObject) => {
        const base: AnyObject = {
          runId: d.runId,
          status: d.status,
          startedAt: d.startedAt,
          completedAt: d.completedAt ?? null,
          conversationId: d.conversationId ?? null,
          automationId: d.automationId ?? null,
          trigger: d.trigger ?? null,
        };
        if (includeOutput) {
          base.output = extractOutput(d.events as AnyObject[] | undefined);
        }
        return base;
      });

      const duration = Date.now() - startTime;
      console.log(
        `[get_recent_runs] graphId=${graphId} status=${status ?? 'any'} returned=${runs.length} duration=${duration}ms role=${role}`
      );

      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[get_recent_runs] ${runs.length} run(s) for graph ${graphId} (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              graphId,
              graphName: graph.name ?? null,
              count: runs.length,
              limit: requestedLimit,
              status: status ?? null,
              since: sinceDate?.toISOString() ?? null,
              includeOutput,
              runs,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[get_recent_runs] Error: ${msg}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: false, error: msg, durationMs: duration }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default getRecentRuns;
module.exports = getRecentRuns;
