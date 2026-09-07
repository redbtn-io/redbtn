/**
 * invoke_function — native tool for calling RedRun cloud functions
 *
 * Submits a job in async mode (?sync=false), then polls the execution
 * endpoint until it completes. Also streams function logs in real-time
 * by polling the execution logs endpoint and forwarding output chunks
 * via RunPublisher.toolProgress().
 *
 * # Security
 *
 * `url` is a REQUIRED caller-supplied argument, and the tool POSTs a
 * caller-supplied body to `${url}/api/invoke/<fn>`. On the worker, inside the
 * private fleet network, that was an unguarded write primitive against any
 * internal HTTP endpoint. Every request this tool makes — the submit, the
 * status poll and the log stream — now goes through `safeFetch`
 * (`lib/net/ssrf-guard`): the host must resolve to a public address AT REQUEST
 * TIME, and each redirect hop is re-checked (max 5).
 *
 * The poll and log endpoints are guarded too, and not only for symmetry:
 * `pollUrl` comes back in the SUBMIT RESPONSE, so it is chosen by whatever
 * answered the first request rather than by us.
 *
 * The only credential in play is the caller's own `apiKey`, sent as
 * `x-api-key`. The tool never attaches the run's `Authorization` / `X-User-Id`
 * / `X-Internal-Key`, has no `headers` parameter through which a caller could
 * add them, and must not gain one.
 *
 * A private RedRun instance (e.g. `http://192.168.1.5:3000`) is reachable only
 * through the explicit, empty-by-default `SSRF_ALLOW_HOSTS` env allowlist, and
 * then only for a trusted authored step — never for a model-chosen `url`.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry.js';
import { safeFetch, SsrfBlockedError } from '../../net/ssrf-guard';
import { callerIsTrusted, ssrfBlockedResult, PUBLIC_HOSTS_ONLY_NOTE } from './_outbound-url';

const POLL_INTERVAL = 1_000; // 1 second — fast enough for interactive use, low overhead for long functions
const LOG_POLL_INTERVAL = 2_000; // 2 seconds for log streaming
const DEFAULT_MAX_WAIT = 900_000; // 15 minutes
const SUBMIT_RETRIES = 3;
const SUBMIT_BACKOFF = [2_000, 5_000, 10_000]; // 2s, 5s, 10s

const definition: NativeToolDefinition = {
  description:
    'Invoke a RedRun cloud function asynchronously. Submits the job, polls for completion, and returns the result. ' +
    PUBLIC_HOSTS_ONLY_NOTE,
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Base URL of the RedRun instance (e.g., https://run.redbtn.io). ' +
          'Refused when the host resolves to a private, loopback or link-local ' +
          'address at the time of the request.',
      },
      functionName: {
        type: 'string',
        description: 'Name of the function to invoke',
      },
      apiKey: {
        type: 'string',
        description: 'API key for authentication (x-api-key header)',
      },
      body: {
        type: 'object',
        description: 'Request body to send to the function',
      },
      timeout: {
        type: 'number',
        description: 'Maximum wait time in ms (default: 900000 = 15 min)',
      },
    },
    required: ['url', 'functionName', 'body'],
  },

  async handler(args, context: NativeToolContext): Promise<NativeMcpResult> {
    // `url` is declared required, but a tool call is not schema-validated
    // before it reaches here — a missing one used to throw a raw TypeError out
    // of the handler.
    const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
    if (!rawUrl || (!rawUrl.startsWith('http://') && !rawUrl.startsWith('https://'))) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'url is required and must start with http:// or https://', code: 'VALIDATION' }) }],
        isError: true,
      };
    }
    const baseUrl = rawUrl.replace(/\/$/, '');
    const trusted = callerIsTrusted(context);
    const functionName = args.functionName as string;
    const apiKey = args.apiKey as string | undefined;
    const rawBody = args.body;
    // Support both object body and pre-stringified JSON (from graph templates)
    const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
    const maxWait = Number(args.timeout) || DEFAULT_MAX_WAIT;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    // Stream progress via RunPublisher.toolProgress(toolId, step, options)
    const pub = context.publisher as any;
    const toolId = context.toolId;

    // ── Step 1: Submit async job ──
    const submitUrl = `${baseUrl}/api/invoke/${functionName}?sync=false`;
    if (pub?.toolProgress && toolId) {
      await pub.toolProgress(toolId, `Submitting ${functionName} job...`, { progress: 5 });
    }

    let submitData: { executionId: string; pollUrl: string } | null = null;
    let submitBlocked: SsrfBlockedError | null = null;
    for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
      try {
        const submitRes = await safeFetch(
          submitUrl,
          {
            method: 'POST',
            headers,
            body: bodyStr,
            signal: AbortSignal.timeout(30_000),
          },
          { trusted },
        );

        if (submitRes.ok) {
          submitData = await submitRes.json() as { executionId: string; pollUrl: string };
          break;
        }

        const errText = await submitRes.text();
        if (submitRes.status >= 400 && submitRes.status < 500) {
          // Client error — don't retry
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Submit failed (${submitRes.status})`, details: errText.substring(0, 500) }) }],
            isError: true,
          };
        }

        // Server error — retry with backoff
        console.warn(`[invoke_function] Submit returned ${submitRes.status}, retrying (${attempt + 1}/${SUBMIT_RETRIES}): ${errText.substring(0, 100)}`);
      } catch (fetchErr: any) {
        // A refused destination is a policy decision, not a flaky upstream —
        // retrying it three times only delays the same answer.
        if (fetchErr instanceof SsrfBlockedError) {
          submitBlocked = fetchErr;
          break;
        }
        console.warn(`[invoke_function] Submit error (${attempt + 1}/${SUBMIT_RETRIES}): ${fetchErr.message}`);
      }

      if (attempt < SUBMIT_RETRIES) {
        await new Promise(r => setTimeout(r, SUBMIT_BACKOFF[attempt] || 10_000));
      }
    }

    if (submitBlocked) {
      return ssrfBlockedResult(submitBlocked, 'invoke_function', { url: baseUrl, functionName });
    }

    if (!submitData) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Submit failed after ${SUBMIT_RETRIES} retries` }) }],
        isError: true,
      };
    }

    const { executionId, pollUrl } = submitData;

    if (!executionId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No executionId in response', response: submitData }) }],
        isError: true,
      };
    }

    console.log(`[invoke_function] Job submitted: ${executionId} for ${functionName}`);

    if (pub?.toolProgress && toolId) {
      await pub.toolProgress(toolId, `Job submitted: ${executionId}`, { progress: 10, data: { executionId, functionName } });
    }

    // ── Step 2: Poll for completion + stream logs ──
    // `pollUrl` is whatever the submit response said, so this destination is
    // upstream-chosen, not ours — `safeFetch` re-checks it on every poll.
    const pollEndpoint = `${baseUrl}${pollUrl || `/api/executions/${executionId}`}`;
    const logsEndpoint = `${baseUrl}/api/executions/${executionId}/logs`;
    const startTime = Date.now();
    let lastStatus = 'queued';
    let lastLogIndex = 0; // Track how many logs we've already forwarded

    // Start log streaming in parallel with status polling
    let logPollTimer: ReturnType<typeof setInterval> | null = null;
    let done = false;

    const streamLogs = async () => {
      try {
        const logRes = await safeFetch(
          logsEndpoint,
          { headers, signal: AbortSignal.timeout(10_000) },
          { trusted },
        );
        if (!logRes.ok) return;

        const logData = await logRes.json() as {
          logs?: Array<{ level: string; message: string; timestamp: string }>;
        };

        const allLogs = logData.logs || [];
        // Only process new logs since last check
        const newLogs = allLogs.slice(lastLogIndex);
        if (newLogs.length === 0) return;

        lastLogIndex = allLogs.length;

        for (const log of newLogs) {
          if (pub?.toolProgress && toolId) {
            // Check if this is an output chunk from ssh-claude
            const isOutputChunk = log.message?.startsWith('[OUTPUT] ');
            const message = isOutputChunk ? log.message.slice(9) : log.message;

            await pub.toolProgress(toolId, message, {
              data: {
                executionId,
                functionName,
                logLevel: log.level,
                isOutputChunk,
                timestamp: log.timestamp,
              },
            });
          }
        }
      } catch {
        // Swallow log poll errors — don't interrupt main polling
      }
    };

    // Poll logs every LOG_POLL_INTERVAL
    logPollTimer = setInterval(() => { if (!done) streamLogs(); }, LOG_POLL_INTERVAL);
    // Also do an initial log fetch after a short delay
    setTimeout(() => { if (!done) streamLogs(); }, 1000);

    try {
      while (Date.now() - startTime < maxWait) {
        // Check abort signal
        if (context.abortSignal?.aborted) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Aborted', executionId }) }],
            isError: true,
          };
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

        try {
          const pollRes = await safeFetch(
            pollEndpoint,
            { headers, signal: AbortSignal.timeout(30_000) },
            { trusted },
          );
          if (!pollRes.ok) {
            const errBody = await pollRes.text().catch(() => '');
            console.warn(`[invoke_function] Poll returned ${pollRes.status}: ${errBody.substring(0, 200)}`);
            continue;
          }

          const execution = await pollRes.json() as {
            status: string;
            result?: unknown;
            error?: string;
            durationMs?: number;
          };

          const elapsed = Math.round((Date.now() - startTime) / 1000);

          if (execution.status !== lastStatus) {
            lastStatus = execution.status;
            console.log(`[invoke_function] ${executionId} status: ${execution.status} (${elapsed}s)`);
          }

          if (pub?.toolProgress && toolId) {
            await pub.toolProgress(
              toolId,
              `${functionName}: ${execution.status} (${elapsed}s)`,
              { progress: Math.min(90, 10 + (elapsed / (maxWait / 1000)) * 80), data: { executionId, status: execution.status, elapsed } },
            );
          }

          if (execution.status === 'success' || execution.status === 'completed') {
            console.log(`[invoke_function] ${executionId} completed in ${elapsed}s`);
            // Final log fetch to get any remaining output
            await streamLogs();
            return {
              content: [{
                type: 'text',
                text: JSON.stringify(execution.result ?? execution),
              }],
            };
          }

          if (execution.status === 'failure' || execution.status === 'error' || execution.status === 'timeout') {
            await streamLogs(); // Get final logs
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  error: execution.error || `Function ${execution.status}`,
                  executionId,
                  durationMs: execution.durationMs,
                }),
              }],
              isError: true,
            };
          }

          // Still running — continue polling
        } catch (pollErr) {
          // Same reasoning as the submit: a blocked poll destination will be
          // blocked on every subsequent attempt, so bail rather than spin for
          // the whole 15-minute budget.
          if (pollErr instanceof SsrfBlockedError) {
            return ssrfBlockedResult(pollErr, 'invoke_function', { url: baseUrl, functionName, executionId });
          }
          console.warn(`[invoke_function] Poll error:`, pollErr instanceof Error ? pollErr.message : pollErr);
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: `Timed out after ${maxWait}ms`, executionId }),
        }],
        isError: true,
      };
    } finally {
      done = true;
      if (logPollTimer) clearInterval(logPollTimer);
    }
  },
};

module.exports = definition;
export default definition;
