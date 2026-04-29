/**
 * Trigger Automation — Native Automation Tool
 *
 * Manually triggers an automation via the webapp API
 * (`POST /api/v1/automations/:automationId/trigger`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: automationId (required), input? (object), wait? (default false)
 *   - output: { runId, automationId, status }  — or, when wait=true, the
 *             terminal status retrieved by polling the automation runs route.
 *
 * Behaviour:
 *   - `wait: false` (default) — fires the trigger and returns immediately with
 *     the queued runId. Status will be "queued" or "running" depending on
 *     timing; the caller can poll `get_automation_run` (or future tools) for
 *     terminal state.
 *
 *   - `wait: true` — submits the trigger, then polls
 *     `GET /api/v1/automations/:automationId/runs/:runId` every 2 seconds
 *     (with exponential backoff capped at 8s) until the run reaches a terminal
 *     status (`completed`, `failed`, `cancelled`) OR the per-call timeout
 *     elapses (default 5 minutes, hard cap 30 minutes). On timeout the
 *     in-flight run is NOT cancelled — the response includes the last-seen
 *     status so the caller can decide whether to keep polling.
 *
 * Stream-mode automations (those with a `streamId`) are accepted but the
 * polling path returns immediately with the session info — sessions don't
 * have a terminal status the same way runs do.
 *
 * The trigger route is documented at:
 *   webapp/src/app/api/v1/automations/[automationId]/trigger/route.ts
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TriggerAutomationArgs {
  automationId?: string;
  input?: Record<string, unknown> | unknown[] | string | number | boolean | null;
  wait?: boolean;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const TERMINAL_STATUSES = new Set([
  'completed',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'timeout',
  'timed_out',
]);

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes
const MAX_TIMEOUT_MS = 1_800_000; // 30 minutes hard cap
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_POLL_INTERVAL_MS = 8_000;

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

const triggerAutomationTool: NativeToolDefinition = {
  description:
    "Manually trigger an automation by id. Returns the new runId and initial status. Set wait:true to block until the run reaches a terminal status (completed / failed / cancelled) — useful when an agent needs the result before proceeding. Stream-mode automations always return their session immediately.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to trigger.',
      },
      input: {
        description:
          "Override the automation's defaultInput / inputMapping. May be any JSON value; an object is most common. Optional — when omitted, the automation runs with its configured input.",
      },
      wait: {
        type: 'boolean',
        description:
          'When true, block until the run reaches a terminal status. When false (default), return immediately with the queued runId.',
      },
      timeoutMs: {
        type: 'integer',
        description: `Maximum time to poll for completion when wait=true (default ${DEFAULT_TIMEOUT_MS}ms = 5min, max ${MAX_TIMEOUT_MS}ms = 30min). On timeout, returns the last-seen status without cancelling the run.`,
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
      },
      pollIntervalMs: {
        type: 'integer',
        description: `Initial polling interval in ms when wait=true (default ${DEFAULT_POLL_INTERVAL_MS}ms, max ${MAX_POLL_INTERVAL_MS}ms). Backs off exponentially up to the max.`,
        minimum: 250,
        maximum: MAX_POLL_INTERVAL_MS,
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TriggerAutomationArgs>;
    const automationId =
      typeof args.automationId === 'string' ? args.automationId.trim() : '';

    if (!automationId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'automationId is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const wait = args.wait === true;
    const timeoutMs =
      args.timeoutMs !== undefined && Number.isFinite(Number(args.timeoutMs))
        ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.floor(Number(args.timeoutMs))))
        : DEFAULT_TIMEOUT_MS;
    const initialPollIntervalMs =
      args.pollIntervalMs !== undefined && Number.isFinite(Number(args.pollIntervalMs))
        ? Math.min(
            MAX_POLL_INTERVAL_MS,
            Math.max(250, Math.floor(Number(args.pollIntervalMs))),
          )
        : DEFAULT_POLL_INTERVAL_MS;

    const baseUrl = getBaseUrl();
    const triggerUrl = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}/trigger`;

    // Pass-through the input override only when caller actually provided one.
    // Posting `{ input: undefined }` is fine, but explicitly setting `null`
    // would override the automation's defaultInput — let's avoid that surprise.
    const triggerBody: Record<string, unknown> = {};
    if (args.input !== undefined) {
      triggerBody.input = args.input as unknown;
    }

    let triggerResponse: Response;
    try {
      triggerResponse = await fetch(triggerUrl, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(triggerBody),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message, automationId, phase: 'trigger' }),
          },
        ],
        isError: true,
      };
    }

    if (!triggerResponse.ok) {
      let errBody = '';
      try {
        errBody = await triggerResponse.text();
      } catch {
        /* ignore */
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Automation API ${triggerResponse.status} ${triggerResponse.statusText}` +
                (errBody ? `: ${errBody.slice(0, 200)}` : ''),
              status: triggerResponse.status,
              automationId,
            }),
          },
        ],
        isError: true,
      };
    }

    let triggerData: AnyObject;
    try {
      triggerData = (await triggerResponse.json()) as AnyObject;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `Invalid JSON from trigger: ${message}`, automationId }),
          },
        ],
        isError: true,
      };
    }

    // Stream-mode automations return { mode: 'stream', sessionId, ... } and
    // don't have a terminal run status. Surface immediately regardless of wait.
    const mode = (triggerData?.mode as string) || 'graph';
    if (mode === 'stream') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              automationId,
              mode: 'stream',
              sessionId: triggerData?.sessionId,
              streamId: triggerData?.streamId,
              wsUrl: triggerData?.wsUrl,
              reused: triggerData?.reused === true,
              session: triggerData?.session,
              status: triggerData?.session?.status ?? 'queued',
            }),
          },
        ],
      };
    }

    const runId = triggerData?.runId as string | undefined;
    const initialStatus = (triggerData?.run?.status as string | undefined) ?? 'queued';

    if (!runId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Trigger response did not contain a runId',
              automationId,
              data: triggerData,
            }),
          },
        ],
        isError: true,
      };
    }

    // wait:false — return the queued runId immediately.
    if (!wait) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              runId,
              automationId,
              status: initialStatus,
              streamUrl: triggerData?.streamUrl,
              startedAt: triggerData?.run?.startedAt,
            }),
          },
        ],
      };
    }

    // wait:true — poll the runs detail endpoint until terminal or timeout.
    const runUrl = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}/runs/${encodeURIComponent(runId)}`;
    const startedAt = Date.now();
    let pollInterval = initialPollIntervalMs;
    let lastSeenStatus = initialStatus;
    let lastSeenRun: AnyObject | null = null;

    while (Date.now() - startedAt < timeoutMs) {
      // Sleep before the first poll so the worker has a beat to start.
      await new Promise((r) => setTimeout(r, pollInterval));

      let runResponse: Response;
      try {
        runResponse = await fetch(runUrl, { headers: buildHeaders(context) });
      } catch (err: unknown) {
        // Transient network errors during polling — back off and retry.
        pollInterval = Math.min(MAX_POLL_INTERVAL_MS, pollInterval * 2);
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: `Polling failed: ${message}`,
                  runId,
                  automationId,
                  status: lastSeenStatus,
                  durationMs: Date.now() - startedAt,
                }),
              },
            ],
            isError: true,
          };
        }
        continue;
      }

      if (runResponse.status === 404) {
        // Run hasn't been written to MongoDB yet — keep polling with backoff.
        pollInterval = Math.min(MAX_POLL_INTERVAL_MS, Math.floor(pollInterval * 1.5));
        continue;
      }

      if (!runResponse.ok) {
        let errBody = '';
        try {
          errBody = await runResponse.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Run lookup ${runResponse.status} ${runResponse.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: runResponse.status,
                runId,
                automationId,
                lastSeenStatus,
              }),
            },
          ],
          isError: true,
        };
      }

      let runData: AnyObject;
      try {
        runData = (await runResponse.json()) as AnyObject;
      } catch {
        // Malformed JSON — back off and retry.
        pollInterval = Math.min(MAX_POLL_INTERVAL_MS, pollInterval * 2);
        continue;
      }

      const run = (runData?.run ?? runData) as AnyObject;
      lastSeenRun = run;
      const runStatus = String(run?.status ?? 'unknown');
      lastSeenStatus = runStatus;

      if (TERMINAL_STATUSES.has(runStatus)) {
        const durationMs = Date.now() - startedAt;
        const isError = runStatus === 'failed' || runStatus === 'error';
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                runId,
                automationId,
                status: runStatus,
                output: run?.output ?? null,
                error: run?.error ?? null,
                durationMs,
                runDurationMs: run?.durationMs,
                startedAt: run?.startedAt,
                completedAt: run?.completedAt,
              }),
            },
          ],
          ...(isError ? { isError: true } : {}),
        };
      }

      // Exponential backoff on the polling interval, capped.
      pollInterval = Math.min(MAX_POLL_INTERVAL_MS, Math.floor(pollInterval * 1.5));
    }

    // Timeout — surface the last-seen status without cancelling the run.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            runId,
            automationId,
            status: 'timeout',
            lastSeenStatus,
            durationMs: timeoutMs,
            output: lastSeenRun?.output ?? null,
          }),
        },
      ],
    };
  },
};

export default triggerAutomationTool;
module.exports = triggerAutomationTool;
