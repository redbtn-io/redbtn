/**
 * redrun_set_env — Native Tool
 *
 * Add or update one or more environment variables on a RedRun workspace.
 * Uses the deep-merge env-diff PATCH body so existing unrelated keys are preserved.
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

interface RedrunSetEnvArgs {
  workspaceId: string;
  env: Record<string, string>;
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

const redrunSetEnvTool: NativeToolDefinition = {
  description:
    'Add or update environment variables on a RedRun workspace. Merges the provided keys into the existing env map — other keys are untouched. To remove a key use redrun_delete_env.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The RedRun workspace ID (24-char hex).',
      },
      env: {
        type: 'object',
        description: 'Key-value pairs to set. Values must be strings.',
        additionalProperties: { type: 'string' },
      },
    },
    required: ['workspaceId', 'env'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RedrunSetEnvArgs>;
    const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
    const env = args.env && typeof args.env === 'object' && !Array.isArray(args.env) ? args.env : null;

    if (!workspaceId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'workspaceId is required', code: 'VALIDATION' }) }],
        isError: true,
      };
    }
    if (!env || Object.keys(env).length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'env must be a non-empty object of string key-value pairs', code: 'VALIDATION' }) }],
        isError: true,
      };
    }
    // Validate all values are strings
    for (const [k, v] of Object.entries(env)) {
      if (typeof v !== 'string') {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `env.${k} must be a string`, code: 'VALIDATION' }) }],
          isError: true,
        };
      }
    }

    const baseUrl = getRedrunBaseUrl();
    if (!baseUrl) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'REDRUN_API_URL env var is not set', code: 'CONFIG' }) }],
        isError: true,
      };
    }

    // Use the env-diff shape so the server can express which keys are new vs updated.
    // The server's deep-merge logic handles both the same way, but the diff shape
    // is the canonical format and avoids the empty-env safety guard.
    const body = {
      appConfig: {
        env: {
          added: env,
          updated: {},
          removed: [],
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
        content: [{ type: 'text', text: JSON.stringify({ ok: true, workspaceId, keysSet: Object.keys(env) }) }],
      };
    } catch (err: unknown) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }
  },
};

export default redrunSetEnvTool;
module.exports = redrunSetEnvTool;
