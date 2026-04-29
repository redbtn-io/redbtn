/**
 * Cancel Run — Native Run Tool
 *
 * Cancels an in-flight run via the webapp's interrupt endpoint
 * (`POST /api/v1/runs/:runId/interrupt`).
 *
 * Spec: TOOL-HANDOFF.md §4.11
 *   - inputs: runId, reason?
 *   - output: { ok: true, status: 'cancelled' }
 *
 * The interrupt endpoint implements a request/ACK handshake with the worker
 * that owns the run:
 *   1. Endpoint subscribes to `run:interrupt:ack:{runId}` BEFORE publishing
 *      the interrupt request (race-safe).
 *   2. Endpoint publishes on `run:interrupt:{runId}`. The engine's per-run
 *      subscriber receives the message, calls `runControlRegistry.cancel`,
 *      walks every in-flight LLM call (NeuronCalls), and ACKs back.
 *   3. If ACK arrives within 5s, the run is cleanly aborting.
 *   4. If no ACK, the endpoint force-kills (Mongo update + Redis cleanup +
 *      synthetic `run_interrupted` event for SSE consumers).
 *
 * From the agent's perspective both paths return success — the only
 * difference visible here is the `forceKilled` flag on the response. Already-
 * terminal runs (completed / failed / cancelled) short-circuit with
 * `alreadyTerminated: <status>`; the tool surfaces those as ok:true with
 * `status: <existing>` so callers don't need to special-case the no-op.
 *
 * Auth: caller must be the run owner. 403 surfaces as `isError: true`. 404
 * (run not found — likely already TTL-expired from Redis) also surfaces as
 * `isError: true`.
 *
 * `reason` is free-form text, sanity-capped to 500 chars by the route.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CancelRunArgs {
  runId?: string;
  reason?: string;
}

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

const cancelRunTool: NativeToolDefinition = {
  description:
    "Cancel an in-flight run by id. Posts an interrupt request to the webapp; the worker that owns the run aborts the run-level AbortController and cancels every in-flight LLM call. If the worker doesn't ACK within 5s the run is force-killed (Mongo + Redis cleanup). Already-terminal runs short-circuit ok:true with their existing status. Owner-only — caller must own the run.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'The runId of the run to cancel.',
      },
      reason: {
        type: 'string',
        description:
          'Optional free-form reason forwarded to the engine and AbortSignal. Sanity-capped at 500 chars.',
        maxLength: 500,
      },
    },
    required: ['runId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CancelRunArgs>;
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

    const reason =
      typeof args.reason === 'string' && args.reason.length > 0
        ? args.reason.slice(0, 500)
        : undefined;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}/interrupt`;

    const body: Record<string, unknown> = {};
    if (reason !== undefined) body.reason = reason;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(body),
      });
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
                `Run interrupt API ${response.status} ${response.statusText}` +
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
    } catch {
      // No body — treat as a successful cancel with no extra diagnostics.
      data = {};
    }

    // Already-terminal short-circuit: the route returns
    //   { interrupted: false, alreadyTerminated: <status>, runId, ack: false }
    // We surface this as ok:true with status=<existing> so the agent doesn't
    // need to discriminate between "we cancelled it" and "it was already done."
    if (data?.interrupted === false && data?.alreadyTerminated) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              runId,
              status: String(data.alreadyTerminated),
              alreadyTerminated: true,
            }),
          },
        ],
      };
    }

    // Live cancel — either an ACKed cooperative cancel or a force-kill. Both
    // surface as `status: 'cancelled'`. Forward the worker diagnostics so a
    // calling agent can decide whether the cancel was clean or forced.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            runId,
            status: 'cancelled',
            ack: data?.ack === true,
            forceKilled: data?.forceKilled === true,
            workerId: data?.workerId,
            currentNodeId: data?.currentNodeId,
            currentStep: data?.currentStep,
            neuronCallsCancelled: data?.neuronCallsCancelled,
            reason,
          }),
        },
      ],
    };
  },
};

export default cancelRunTool;
module.exports = cancelRunTool;
