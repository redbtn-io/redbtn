/**
 * Disable Automation — Native Automation Tool
 *
 * Disables an automation via the webapp API
 * (`POST /api/v1/automations/:automationId/disable`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: automationId
 *   - output: { ok: true, isEnabled: false }
 *
 * Owner-only — server enforces via `verifyAutomationAccess(..., 'owner')`.
 * Members and viewers receive 403 which surfaces here as `isError: true`.
 *
 * Disabling sets `isEnabled: false` and `status: 'paused'`. Cron schedulers
 * and webhook receivers will skip a disabled automation. Use this when an
 * agent has decided an automation should be temporarily silenced (e.g. after
 * detecting an error condition or while a related dependency is being
 * reconfigured).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DisableAutomationArgs {
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

const disableAutomationTool: NativeToolDefinition = {
  description:
    "Disable an active automation by id. Owner-only. Sets isEnabled=false and status=paused — cron schedulers and webhook receivers will skip it. Returns { ok: true, isEnabled: false } on success.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to disable.',
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DisableAutomationArgs>;
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
    const url = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}/disable`;

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
      // it when available, otherwise default to false (the disable endpoint
      // always sets isEnabled: false on success).
      let isEnabled = false;
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

export default disableAutomationTool;
module.exports = disableAutomationTool;
