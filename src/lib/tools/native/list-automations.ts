/**
 * List Automations — Native Automation Tool
 *
 * Lists automations the caller can see (owned + participated) via the
 * webapp API (`GET /api/v1/automations`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: enabled?, search?, limit?
 *   - output: { automations: [...] }
 *
 * The webapp route already supports server-side `search` (matches name,
 * description, and tags) and `limit` query params. We pass both through.
 *
 * `enabled` filters the result client-side because the route's `status` query
 * param uses the AutomationStatus enum (active / paused / disabled / error)
 * which doesn't map 1:1 with the boolean `isEnabled` flag — better to filter
 * on the response and stay forward-compatible.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListAutomationsArgs {
  enabled?: boolean;
  search?: string;
  limit?: number;
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

const listAutomationsTool: NativeToolDefinition = {
  description:
    'List automations the caller can access (owned and participated). Optionally filter by enabled state or search by name/description/tags. Use to discover automations before triggering one.',
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        description:
          'When true, return only enabled automations. When false, return only disabled automations. When omitted, returns both.',
      },
      search: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter. Matches against name, description, and tags via the server-side search.',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of automations to return (default 50, max 100).',
        minimum: 1,
        maximum: 100,
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListAutomationsArgs>;
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    const enabled = typeof args.enabled === 'boolean' ? args.enabled : undefined;
    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(100, Math.max(1, Math.floor(Number(args.limit))))
        : 50;

    const baseUrl = getBaseUrl();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (search) params.set('search', search);
    const url = `${baseUrl}/api/v1/automations?${params.toString()}`;

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
                  `Automations API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const rawList = Array.isArray(data?.automations) ? (data.automations as AnyObject[]) : [];

      // Filter by enabled state client-side. The route's `status` query param
      // doesn't perfectly mirror `isEnabled` (a paused automation has
      // status='paused' AND isEnabled=false, but they're semantically distinct).
      let list = rawList;
      if (enabled !== undefined) {
        list = list.filter((a) => Boolean(a?.isEnabled) === enabled);
      }

      // Project a stable, agent-friendly subset of fields. Pass through the
      // common identifiers + state; full doc is available via get_automation.
      const projected = list.slice(0, limit).map((a) => ({
        automationId: a?.automationId,
        name: a?.name,
        description: a?.description,
        graphId: a?.graphId,
        streamId: a?.streamId,
        mode: a?.mode,
        tags: a?.tags ?? [],
        triggers: a?.triggers ?? [],
        isEnabled: a?.isEnabled === true,
        status: a?.status,
        stats: a?.stats,
        lastRunAt: a?.lastRunAt,
        createdAt: a?.createdAt,
        updatedAt: a?.updatedAt,
        isOwned: a?.isOwned,
      }));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ automations: projected }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  },
};

export default listAutomationsTool;
module.exports = listAutomationsTool;
