/**
 * Get Recent Runs — Native System Tool
 *
 * Reads the archived `runEvents` collection to expose recent run history as
 * a context source. Supports two query modes:
 *
 *   1. Graph mode  ({ graphId })  — runs of a specific graph (the original
 *      mode added in PR #3). Backed by the `{ graphId, userId, startedAt }`
 *      compound index on runEvents.
 *
 *   2. Stream mode ({ streamId }) — runs synthesised from stream parser
 *      output (Discord voice, Zoom, Meet, etc.). Each entry represents one
 *      assistant turn. Backed by the `{ streamId, userId, startedAt }`
 *      compound index on runEvents.
 *
 * Exactly one of graphId / streamId must be provided.
 *
 * The `runEvents` collection is populated:
 *   - For graph runs: unconditionally by the BullMQ run-archiver (60-day TTL).
 *   - For stream turns: by the webapp's stream-turn-archiver, called from
 *     session-manager on each provider `turn_complete`.
 *
 * Use cases:
 *   - A graph reads its own (or a sibling graph's) prior outputs as
 *     context for a new run.
 *   - A graph reads recent assistant turns from a Discord-voice stream
 *     to follow up on what was said in the meeting.
 *   - Subagent graphs reading parent context.
 *
 * Access model: caller must be the resource owner, an explicit participant,
 * or the resource must be public/system. Mirrors `verifyGraphAccess` /
 * `verifyStreamAccess` on the webapp side. Rejects with isError when
 * forbidden.
 */

import mongoose from 'mongoose';
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetRecentRunsArgs {
  graphId?: string;
  streamId?: string;
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
 * Resolve the caller's role on a graph or stream using the same precedence
 * the webapp's `verifyResourceAccess` uses:
 *   1. participants[].userId === userId          → that role
 *   2. resource.userId === userId                → owner
 *   3. resource.isPublic === true                → viewer
 *   4. resource.isSystem === true || userId==='system' → viewer
 *   5. otherwise → null (forbidden)
 */
function resolveRole(resource: AnyObject, userId: string): 'owner' | 'member' | 'viewer' | null {
  const participants = resource?.participants as Array<{ userId: string; role: string }> | undefined;
  if (Array.isArray(participants) && participants.length > 0) {
    const p = participants.find(x => x?.userId === userId);
    if (p?.role === 'owner' || p?.role === 'member' || p?.role === 'viewer') {
      return p.role;
    }
  }
  if (resource?.userId && String(resource.userId) === userId) {
    return 'owner';
  }
  if (resource?.isPublic === true) {
    return 'viewer';
  }
  if (resource?.isSystem === true || resource?.userId === 'system') {
    return 'viewer';
  }
  return null;
}

const getRecentRuns: NativeToolDefinition = {
  description:
    'Fetch recent run history for a graph OR a stream. Returns metadata + optionally final output state. Use this to read prior outputs as context for a new run, alongside Global State, conversation history, and Knowledge Library RAG. Provide exactly one of graphId or streamId — graphId returns BullMQ-archived graph executions, streamId returns assistant turns synthesised from stream parser output (Discord voice, Zoom, etc.).',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'Graph to query. Mutually exclusive with streamId.',
      },
      streamId: {
        type: 'string',
        description: 'Stream to query. Returns assistant turns archived from stream parser output. Mutually exclusive with graphId.',
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
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as GetRecentRunsArgs;
    const { graphId, streamId, status, since } = args;
    const includeOutput = args.includeOutput !== false; // default true
    const requestedLimit =
      typeof args.limit === 'number' && Number.isFinite(args.limit) && args.limit > 0
        ? Math.min(Math.floor(args.limit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    // ── Validate: exactly one of graphId or streamId ───────────────────
    const hasGraphId = typeof graphId === 'string' && graphId.length > 0;
    const hasStreamId = typeof streamId === 'string' && streamId.length > 0;

    if (!hasGraphId && !hasStreamId) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'Exactly one of graphId or streamId is required' }),
        }],
        isError: true,
      };
    }
    if (hasGraphId && hasStreamId) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: 'graphId and streamId are mutually exclusive — provide only one' }),
        }],
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

    // Mode-dependent constants — declared up front so the success log can
    // reference them after the try-block.
    const mode: 'graph' | 'stream' = hasGraphId ? 'graph' : 'stream';
    const targetId = hasGraphId ? graphId! : streamId!;

    try {
      const db = mongoose.connection.db;
      if (!db) throw new Error('MongoDB connection not available');

      // ── 1. Access check ──────────────────────────────────────────────
      // Look up the underlying resource (graph or stream) to verify the
      // caller is allowed to read its run history.
      const collectionName = mode === 'graph' ? 'graphs' : 'streams';
      const idField = mode === 'graph' ? 'graphId' : 'streamId';
      const resourceCol = db.collection(collectionName);
      const resource = await resourceCol.findOne({ [idField]: targetId });
      if (!resource) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `${mode === 'graph' ? 'Graph' : 'Stream'} not found: ${targetId}` }),
          }],
          isError: true,
        };
      }

      const role = resolveRole(resource, callerUserId);
      if (!role) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Forbidden: caller does not have access to ${mode} ${targetId}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── 2. Build query ───────────────────────────────────────────────
      // The compound indexes added to runEvents are:
      //   { graphId: 1, userId: 1, startedAt: -1 }   ← graph mode
      //   { streamId: 1, userId: 1, startedAt: -1 }  ← stream mode
      // Either index is hit naturally by filtering on the lead key here.
      const query: AnyObject = {};
      if (mode === 'graph') {
        query.graphId = targetId;
      } else {
        query.streamId = targetId;
      }
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
        // Stream-mode entries also carry sessionId — surface it so the
        // caller can correlate turns to the originating session.
        sessionId: 1,
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
          sessionId: d.sessionId ?? null,
          trigger: d.trigger ?? null,
        };
        if (includeOutput) {
          base.output = extractOutput(d.events as AnyObject[] | undefined);
        }
        return base;
      });

      const duration = Date.now() - startTime;
      console.log(
        `[get_recent_runs] ${mode}=${targetId} status=${status ?? 'any'} returned=${runs.length} duration=${duration}ms role=${role}`
      );

      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[get_recent_runs] ${runs.length} run(s) for ${mode} ${targetId} (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      const responseBody: AnyObject = {
        count: runs.length,
        limit: requestedLimit,
        status: status ?? null,
        since: sinceDate?.toISOString() ?? null,
        includeOutput,
        runs,
      };
      // Echo back whichever id the caller used + the resource name.
      if (mode === 'graph') {
        responseBody.graphId = targetId;
        responseBody.graphName = resource.name ?? null;
      } else {
        responseBody.streamId = targetId;
        responseBody.streamName = resource.name ?? null;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(responseBody),
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
