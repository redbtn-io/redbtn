/**
 * redrun_delete_env — Native Tool
 *
 * Remove one or more environment variable keys from a RedRun workspace.
 * Uses the `removed` field of the env-diff PATCH shape so the server
 * issues a proper MongoDB `$unset` — keys are fully deleted, not nulled.
 * Calls PATCH /api/workspaces/:id on the configured RedRun instance.
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

interface RedrunDeleteEnvArgs {
  workspaceId: string;
  keys: string[];
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

const redrunDeleteEnvTool: NativeToolDefinition = {
  description:
    'Remove one or more environment variable keys from a RedRun workspace. Other env keys are preserved. The keys are fully deleted (not set to empty string).',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The RedRun workspace ID (24-char hex).',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of env var key names to delete.',
        minItems: 1,
      },
    },
    required: ['workspaceId', 'keys'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RedrunDeleteEnvArgs>;
    const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
    const keys = Array.isArray(args.keys)
      ? args.keys.filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];

    if (!workspaceId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'workspaceId is required', code: 'VALIDATION' }) }],
        isError: true,
      };
    }
    if (keys.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'keys must be a non-empty array of strings', code: 'VALIDATION' }) }],
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

    const body = {
      appConfig: {
        env: {
          added: {},
          updated: {},
          removed: keys,
        },
      },
    };

    try {
      const response = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: 'PATCH',
        headers: buildRedrunHeaders(),
        body: JSON.stringify(body),
      });

      if (response.status === 404) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Workspace ${workspaceId} not found`, code: 'NOT_FOUND' }) }],
          isError: true,
        };
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `RedRun API ${response.status}: ${errBody.slice(0, 200)}`, code: 'API_ERROR' }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, workspaceId, keysDeleted: keys }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }
  },
};

export default redrunDeleteEnvTool;
module.exports = redrunDeleteEnvTool;
