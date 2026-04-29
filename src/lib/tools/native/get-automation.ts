/**
 * Get Automation — Native Automation Tool
 *
 * Returns the full definition of a single automation the caller can access via
 * the webapp API (`GET /api/v1/automations/:automationId`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: automationId
 *   - output: full automation doc
 *
 * Access is enforced server-side by `verifyAutomationAccess` — owner or
 * participant. Forbidden / not-found surface as `isError: true`.
 *
 * Use this to inspect the automation's trigger config, defaultInput, secret
 * names, and current stats before deciding whether/how to trigger it via
 * `trigger_automation`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetAutomationArgs {
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

const getAutomationTool: NativeToolDefinition = {
  description:
    "Fetch the full definition of a single automation by id (triggers, defaultInput, inputMapping, secret names, stats, status). Use to inspect an automation's shape and current state before triggering it.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to fetch.',
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetAutomationArgs>;
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
    const url = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}`;

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

      const data = (await response.json()) as AnyObject;
      // Route returns { success, automation: {...} } — surface the inner object
      // directly so callers don't need to peel off the wrapper.
      const automation = (data?.automation ?? data) as AnyObject;

      return {
        content: [
          { type: 'text', text: JSON.stringify({ automation }) },
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

export default getAutomationTool;
module.exports = getAutomationTool;
