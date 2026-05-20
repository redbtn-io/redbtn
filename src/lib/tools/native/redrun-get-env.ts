/**
 * redrun_get_env — Native Tool
 *
 * Returns the full env map for a RedRun workspace (`appConfig.env`).
 * Calls GET /api/workspaces/:id on the configured RedRun instance.
 *
 * Required env vars:
 *   REDRUN_API_URL   — base URL, e.g. https://run.redbtn.io
 *   REDRUN_API_KEY   — sent as `x-api-key`; must match RedRun's INTERNAL_SERVICE_KEY
 *
 * Optional:
 *   REDRUN_USER_ID   — scope to a specific user's workspaces (`x-user-id`)
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface RedrunGetEnvArgs {
  workspaceId: string;
}

function getRedrunBaseUrl(): string {
  return (process.env.REDRUN_API_URL || '').replace(/\/$/, '');
}

function buildRedrunHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.REDRUN_API_KEY;
  const userId = process.env.REDRUN_USER_ID;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (userId) headers['x-user-id'] = userId;
  return headers;
}

const redrunGetEnvTool: NativeToolDefinition = {
  description:
    'Read all environment variables for a RedRun workspace. Returns the full env map from appConfig.env. Use redrun_set_env to add/update keys, redrun_delete_env to remove them.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The RedRun workspace ID (24-char hex).',
      },
    },
    required: ['workspaceId'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RedrunGetEnvArgs>;
    const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';

    if (!workspaceId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'workspaceId is required', code: 'VALIDATION' }) }],
        isError: true,
      };
    }

    const baseUrl = getRedrunBaseUrl();
    if (!baseUrl) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'REDRUN_API_URL env var is not set', code: 'CONFIG' }) }],
        isError: true,
      };
    }

    try {
      const response = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        headers: buildRedrunHeaders(),
      });

      if (response.status === 404) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Workspace ${workspaceId} not found`, code: 'NOT_FOUND' }) }],
          isError: true,
        };
      }
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `RedRun API ${response.status}: ${body.slice(0, 200)}`, code: 'API_ERROR' }) }],
          isError: true,
        };
      }

      const ws = (await response.json()) as AnyObject;
      const env = ws?.appConfig?.env ?? {};
      return {
        content: [{ type: 'text', text: JSON.stringify({ workspaceId, name: ws.name, env, keyCount: Object.keys(env).length }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }
  },
};

export default redrunGetEnvTool;
module.exports = redrunGetEnvTool;
