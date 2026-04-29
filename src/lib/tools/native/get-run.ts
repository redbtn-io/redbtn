/**
 * Get Run — Native Run Tool
 *
 * Fetches the full state of a single run via the webapp API
 * (`GET /api/v1/runs/:runId`).
 *
 * Spec: TOOL-HANDOFF.md §4.11
 *   - inputs: runId
 *   - output: full RunState
 *
 * The webapp route returns either the live state from Redis (1 hour TTL) or
 * — implicitly via the engine's `getRunState` — a cached snapshot. Once a run
 * is older than the Redis TTL the route returns 404; for older history use
 * `get_recent_runs` which reads the long-term `runEvents` archive.
 *
 * Access is enforced server-side: the route compares `state.userId` with the
 * authenticated caller and returns 403 on mismatch. Forbidden / not-found
 * surface as `isError: true` here.
 *
 * Use this to:
 *   - poll for terminal status when an agent has previously called
 *     `trigger_automation` or `invoke_graph` with `wait: false`
 *   - inspect a recently-completed run's status, output, and graph progress
 *   - drive a UI bubble that re-attaches to an in-flight run after a refresh
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetRunArgs {
  runId?: string;
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

const getRunTool: NativeToolDefinition = {
  description:
    'Fetch the full live state of a single run by id (status, output, current node, graph progress, errors). Use to poll for terminal status after triggering a run with wait:false, or to inspect recent run details. Returns 404 once the run state expires from Redis (1 hour after completion); use get_recent_runs for older archived runs.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      runId: {
        type: 'string',
        description: 'The runId of the run to fetch.',
      },
    },
    required: ['runId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetRunArgs>;
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

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/runs/${encodeURIComponent(runId)}`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

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
                  `Run API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                runId,
              }),
            },
          ],
          isError: true,
        };
      }

      // The webapp route returns the RunState document directly (no wrapper).
      // Surface it as `{ run: <state> }` so callers can pattern-match the
      // outer shape across all the runs-pack tools.
      const run = (await response.json()) as AnyObject;

      return {
        content: [
          { type: 'text', text: JSON.stringify({ run }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, runId }) },
        ],
        isError: true,
      };
    }
  },
};

export default getRunTool;
module.exports = getRunTool;
