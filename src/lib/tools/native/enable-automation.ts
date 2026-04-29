/**
 * Enable Automation — Native Automation Tool
 *
 * Enables an automation via the webapp API
 * (`POST /api/v1/automations/:automationId/enable`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: automationId
 *   - output: { ok: true, isEnabled: true }
 *
 * Owner-only — server enforces via `verifyAutomationAccess(..., 'owner')`.
 * Members and viewers receive 403 which surfaces here as `isError: true`.
 *
 * Use this when an agent has decided an automation should be re-activated
 * (e.g. after fixing a configuration issue, or as part of a higher-level
 * workflow that pauses + resumes a chain of automations).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface EnableAutomationArgs {
  automationId?: string;
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

const enableAutomationTool: NativeToolDefinition = {
  description:
    "Enable a paused or disabled automation by id. Owner-only. Returns { ok: true, isEnabled: true } on success. Use when an agent should re-activate an automation after a config fix or as part of a multi-automation workflow.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to enable.',
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<EnableAutomationArgs>;
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

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}/enable`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
      });

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
                  `Automation API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                automationId,
              }),
            },
          ],
          isError: true,
        };
      }

      // Don't strictly trust the route's response — derive `isEnabled` from
      // it when available, otherwise default to true (the enable endpoint
      // always sets isEnabled: true on success).
      let isEnabled = true;
      try {
        const data = (await response.json()) as AnyObject;
        if (typeof data?.automation?.isEnabled === 'boolean') {
          isEnabled = data.automation.isEnabled;
        }
      } catch {
        /* response had no body or non-JSON — fall back to default */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, isEnabled, automationId }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, automationId }) },
        ],
        isError: true,
      };
    }
  },
};

export default enableAutomationTool;
module.exports = enableAutomationTool;
