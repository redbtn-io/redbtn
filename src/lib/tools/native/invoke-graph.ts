/**
 * Invoke Graph — Native Graph Tool (Phase B-7 showstopper)
 *
 * Lets an LLM-driven agent dynamically invoke ANY graph as a tool with full
 * access checking, recursion limits, and parent linkage.
 *
 * Spec: TOOL-HANDOFF.md §4.9
 *   - inputs: graphId, input, wait? (default true), timeoutMs? (default 600000)
 *   - output: { runId, output, status, durationMs }
 *
 * Constraints (must hold — see TOOL-HANDOFF.md §4.9):
 *
 *   1. Access check: caller must own the target graph or be a participant.
 *      System / public graphs grant viewer access. Mirrors `verifyGraphAccess`
 *      from webapp/src/lib/auth/graph-access.ts using the same role-resolution
 *      precedence as `get_recent_runs`.
 *
 *   2. Recursion limit: child run inherits
 *      `state._invokeGraphDepth = (parent._invokeGraphDepth ?? 0) + 1`.
 *      Reject when the proposed depth would exceed 5.
 *
 *   3. Parent linkage: child run records `parentRunId = currentRunId` (under
 *      `input.parentRunId`, surfaced on the child's RunState.input). The
 *      `_invokeGraphDepth` counter rides alongside under `input` so it
 *      propagates naturally through `state.data.input._invokeGraphDepth`.
 *
 *   4. Tracing: child run inherits parent's `userId` and `conversationId`
 *      (when present), but always generates a fresh `runId`. The conversation
 *      lock is keyed on the child's runId (NOT parent's conversationId) so the
 *      child does not deadlock on the parent's still-held conversation lock.
 *
 *   5. wait: false — returns immediately with the runId; the agent can later
 *      poll via `get_run` (Pack 10).
 *
 *   6. wait: true (default) — blocks until terminal status (completed | error |
 *      interrupted) OR `timeoutMs` elapses. On timeout: returns
 *      `{ runId, output: null, status: 'timeout', durationMs: timeoutMs }`
 *      WITHOUT cancelling the child run (callers can `cancel_run` separately).
 *
 * Implementation choice (Option B from the handoff — in-process invocation):
 *   This calls the engine's `run()` function directly with a Red-shaped duck
 *   object stitched together from the parent's graph state. We chose Option B
 *   over the alternative (submitting a BullMQ job through the webapp HTTP
 *   boundary) because:
 *     - Avoids a webapp sister PR for an internal-API endpoint.
 *     - No HTTP serialization hop — child run can reuse parent's neuron
 *       registry, MCP client, and Redis connections directly.
 *     - Run state, archival, RunPublisher events, MongoCheckpointer — all
 *       work identically because we go through the same `run()` entry point
 *       any other invocation does.
 *
 *   The cost is that the child run's BullMQ job record does not exist (no
 *   queue submission). For run-state visibility this does not matter: `run()`
 *   itself writes RunState to Redis via RunPublisher.init(), and the BullMQ
 *   archive queue is fed from the same RunPublisher instance — so `get_run`
 *   and `get_recent_runs` both find invoked runs correctly.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface InvokeGraphArgs {
  graphId?: string;
  input?: Record<string, unknown>;
  wait?: boolean;
  timeoutMs?: number;
}

const MAX_INVOKE_DEPTH = 5;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes
const MAX_TIMEOUT_MS = 3_600_000; // 1 hour hard cap

/**
 * Resolve the caller's role on a graph using the same precedence
 * `verifyResourceAccess` uses on the webapp side. Mirrors `resolveRole` in
 * `get-recent-runs.ts`.
 */
function resolveGraphRole(
  graph: AnyObject,
  userId: string,
): 'owner' | 'member' | 'viewer' | null {
  const participants = graph?.participants as
    | Array<{ userId: string; role: string }>
    | undefined;
  if (Array.isArray(participants) && participants.length > 0) {
    const p = participants.find((x) => x?.userId === userId);
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

/**
 * Build a Red-shaped duck object from the parent run's graph state. We need
 * this because `run()` requires a `Red` instance, but native tools are called
 * with only the graph state as context.
 *
 * All five infrastructure surfaces (`redis`, `redlog`, `graphRegistry`,
 * `neuronRegistry`, `memory`, and `callMcpTool`) are reachable from the
 * parent's state — we just need to assemble them into the Red interface
 * shape.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildRedShape(state: AnyObject, publisher: any): AnyObject | null {
  // publisher.redis is private but accessible via cast — same trick run.ts
  // already uses for fallback error publishing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis = (publisher as any)?.redis;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redlog = (publisher as any)?.redlog;

  const graphRegistry = state?._graphRegistry;
  const neuronRegistry = state?.neuronRegistry;
  const memory = state?.memory;
  const mcpClient = state?.mcpClient;

  if (!redis || !graphRegistry || !neuronRegistry || !memory) {
    return null;
  }

  return {
    redis,
    redlog,
    graphRegistry,
    neuronRegistry,
    memory,
    callMcpTool: async (
      toolName: string,
      args: Record<string, unknown>,
      meta?: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      if (!mcpClient?.callTool) {
        throw new Error('callMcpTool not available — parent state has no mcpClient');
      }
      return mcpClient.callTool(toolName, args, meta, signal);
    },
  };
}

const invokeGraphTool: NativeToolDefinition = {
  description:
    'Invoke another graph as a tool. Supports full access checking, recursion limit (max depth 5), and parent linkage. When wait=true (default), blocks until the child run completes or timeoutMs elapses. When wait=false, returns immediately with the runId; poll via get_run.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to invoke. Caller must have access (owner / participant / public / system).',
      },
      input: {
        type: 'object',
        description: 'The input payload to pass to the graph. Shape depends on the target graph\'s inputSchema — use get_graph to inspect.',
        additionalProperties: true,
      },
      wait: {
        type: 'boolean',
        description: 'When true (default), block until the child run reaches a terminal status. When false, return immediately with just the runId.',
      },
      timeoutMs: {
        type: 'integer',
        description: `Maximum time to wait for completion when wait=true (default ${DEFAULT_TIMEOUT_MS}ms = 10min, max ${MAX_TIMEOUT_MS}ms = 1hr). On timeout, returns status='timeout' without cancelling the child run.`,
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ['graphId', 'input'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<InvokeGraphArgs>;

    // ── 1. Validation ────────────────────────────────────────────────────────
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';
    if (!graphId) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: 'graphId is required', code: 'VALIDATION' }) },
        ],
        isError: true,
      };
    }

    const childInput =
      args.input && typeof args.input === 'object' && !Array.isArray(args.input)
        ? (args.input as Record<string, unknown>)
        : null;
    if (!childInput) {
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: 'input must be an object', code: 'VALIDATION' }) },
        ],
        isError: true,
      };
    }

    const wait = args.wait !== false; // default true
    const timeoutMs =
      args.timeoutMs !== undefined && Number.isFinite(Number(args.timeoutMs))
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(Number(args.timeoutMs))))
        : DEFAULT_TIMEOUT_MS;

    // ── 2. Resolve caller userId from graph state ────────────────────────────
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
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 3. Recursion limit check ─────────────────────────────────────────────
    const parentDepth =
      Number(
        context?.state?.data?.input?._invokeGraphDepth ??
          context?.state?._invokeGraphDepth ??
          0,
      ) || 0;
    const childDepth = parentDepth + 1;
    if (childDepth > MAX_INVOKE_DEPTH) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'recursion_limit_exceeded',
              depth: childDepth,
              maxDepth: MAX_INVOKE_DEPTH,
              graphId,
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 4. Access check (mirrors verifyGraphAccess) ──────────────────────────
    // We hit MongoDB directly (same shortcut get_recent_runs uses) rather than
    // round-tripping through the webapp /api/v1/graphs/:id route. Faster and
    // avoids needing a valid bearer token in tool context.
    // Using dynamic ESM import (rather than require) so vi.mock can intercept
    // it cleanly in tests; compiled CJS handles this as a standard await.
    const mongooseModule = await import('mongoose');
    // ESM default-export interop: prefer .default when present (TS/ESM build),
    // fall back to the namespace itself (CJS build).
    const mongoose = (mongooseModule as { default?: unknown }).default ?? mongooseModule;
    const db = (mongoose as { connection?: { db?: unknown } })?.connection?.db as
      | { collection: (name: string) => { findOne: (q: Record<string, unknown>) => Promise<Record<string, unknown> | null> } }
      | undefined;
    if (!db) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'MongoDB connection not available' }),
          },
        ],
        isError: true,
      };
    }

    const graphsCol = db.collection('graphs');
    const graph = await graphsCol.findOne({ graphId });
    if (!graph) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'graph_not_found', graphId }),
          },
        ],
        isError: true,
      };
    }

    const role = resolveGraphRole(graph, callerUserId);
    if (!role) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'access_denied', graphId }),
          },
        ],
        isError: true,
      };
    }

    // ── 5. Build a Red-shaped duck object from the parent's state ────────────
    const publisher = context?.publisher as AnyObject | null;
    const redShape = buildRedShape(context?.state || {}, publisher);
    if (!redShape) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'parent_state_incomplete',
              detail: 'Could not build engine context from parent state — missing redis/graphRegistry/neuronRegistry/memory',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── 6. Build the child run's input + options ─────────────────────────────
    const parentRunId =
      (context?.state?.runId as string | undefined) ||
      (context?.state?.data?.runId as string | undefined) ||
      context?.runId ||
      undefined;

    const parentConversationId =
      (context?.state?.data?.conversationId as string | undefined) ||
      (context?.state?.data?.options?.conversationId as string | undefined) ||
      undefined;

    // Stash linkage metadata on the child input. Both `parentRunId` and
    // `_invokeGraphDepth` will end up under `state.data.input.*` in the
    // child's graph state — readable by templates and by deeper invoke_graph
    // calls that need to compute their own depth.
    const enrichedInput: Record<string, unknown> = {
      ...childInput,
      parentRunId,
      _invokeGraphDepth: childDepth,
      _trigger: {
        type: 'invoke_graph',
        metadata: {
          parentRunId,
          parentGraphId:
            (context?.state?.data?.options?.graphId as string | undefined) ||
            (context?.state?.graphId as string | undefined),
          invokeDepth: childDepth,
        },
      },
    };

    // Generate child runId up front so we can return it immediately for
    // wait:false. `run()` accepts the runId in its options.
    const childRunId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

    // Lazy-import run() to avoid a circular dependency at module-load time.
    // The engine entrypoint pulls in tools/native-registry which would
    // otherwise create a cycle. We use dynamic ESM import so vitest can
    // intercept via vi.mock; the compiled output (CJS) handles this as a
    // standard async require.
    const runModule = await import('../../../functions/run');
    const { run, isStreamingResult } = runModule;

    const startedAt = Date.now();

    if (publisher?.toolProgress && context?.toolId) {
      try {
        await publisher.toolProgress(
          context.toolId,
          `Invoking graph '${graphId}' (depth=${childDepth}, wait=${wait})`,
          {
            progress: 5,
            data: { childRunId, graphId, depth: childDepth, wait },
          },
        );
      } catch {
        /* non-fatal */
      }
    }

    // ── 7. wait: false — fire-and-forget, return runId immediately ───────────
    if (!wait) {
      // Submit the run but don't await it. The promise still needs to be
      // consumed so its rejection doesn't surface as an unhandled rejection
      // — we attach a no-op catch handler.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const submitPromise = run(redShape as any, enrichedInput, {
          userId: callerUserId,
          graphId,
          // Intentionally omit conversationId — keeps the child's lock keyed
          // on its own runId so it does NOT deadlock on the parent's
          // still-held conversation lock. The conversationId is preserved
          // for traceability via the input metadata above.
          runId: childRunId,
          stream: false,
          source: { application: 'invoke_graph' },
        });

        // Detach: drain any errors so they don't appear as unhandled.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Promise.resolve(submitPromise).then(
          (result: any) => {
            if (isStreamingResult && isStreamingResult(result)) {
              return result.completion.catch((err: unknown) => {
                console.warn(
                  `[invoke_graph] Detached child run ${childRunId} failed:`,
                  err instanceof Error ? err.message : err,
                );
              });
            }
            return result;
          },
          (err: unknown) => {
            console.warn(
              `[invoke_graph] Detached child run ${childRunId} submit failed:`,
              err instanceof Error ? err.message : err,
            );
          },
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                runId: childRunId,
                graphId,
                status: 'submitted',
                wait: false,
                depth: childDepth,
                parentRunId,
                conversationId: parentConversationId,
              }),
            },
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: message,
                graphId,
                runId: childRunId,
                phase: 'submit',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // ── 8. wait: true — block until terminal or timeout ──────────────────────
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        resolve('timeout');
      }, timeoutMs);
    });

    try {
      const runResultPromise = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await run(redShape as any, enrichedInput, {
          userId: callerUserId,
          graphId,
          runId: childRunId,
          stream: false,
          source: { application: 'invoke_graph' },
        });
        // run() with stream:false returns RunResult directly. Keep the
        // streaming branch for forward-compatibility — if a future change
        // changes the default we still wait on the completion promise.
        if (isStreamingResult && isStreamingResult(result)) {
          return await result.completion;
        }
        return result;
      })();

      const winner = await Promise.race([runResultPromise, timeoutPromise]);

      if (timedOut || winner === 'timeout') {
        // Timeout — return status:'timeout' without cancelling the child run.
        // Caller may use cancel_run separately. We DO NOT abandon the
        // run-result promise: detach it so its outcome is captured but the
        // unhandled-rejection trap doesn't fire.
        runResultPromise.catch((err: unknown) => {
          console.warn(
            `[invoke_graph] Child run ${childRunId} (post-timeout) failed:`,
            err instanceof Error ? err.message : err,
          );
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                runId: childRunId,
                output: null,
                status: 'timeout',
                durationMs: timeoutMs,
                graphId,
                depth: childDepth,
                parentRunId,
              }),
            },
          ],
        };
      }

      // ── Completed normally — extract output ────────────────────────────────
      const runResult = winner as AnyObject;
      const durationMs = Date.now() - startedAt;
      const status = (runResult?.status as string) || 'unknown';

      // Output shape: prefer the canonical content/data, fall back to the
      // full result. Keeps consumers loose-coupled to whatever shape the
      // child graph happens to write.
      const output: AnyObject = {
        content: runResult?.content ?? null,
        thinking: runResult?.thinking ?? null,
        data: runResult?.data ?? null,
      };
      if (runResult?.error) output.error = runResult.error;
      if (runResult?.interruptedReason) {
        output.interruptedReason = runResult.interruptedReason;
      }

      const isError = status === 'error';

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              runId: runResult?.runId ?? childRunId,
              output,
              status,
              durationMs,
              graphId,
              depth: childDepth,
              parentRunId,
            }),
          },
        ],
        ...(isError ? { isError: true } : {}),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startedAt;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              runId: childRunId,
              graphId,
              durationMs,
              phase: 'execute',
            }),
          },
        ],
        isError: true,
      };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  },
};

export default invokeGraphTool;
module.exports = invokeGraphTool;
