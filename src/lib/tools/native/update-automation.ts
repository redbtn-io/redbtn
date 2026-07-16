/**
 * Update Automation — Native Automation Tool
 *
 * Updates an existing automation via the webapp API
 * (`PATCH /api/v1/automations/:automationId`).
 *
 * Spec: TOOL-HANDOFF.md §4.8
 *   - inputs: automationId, name?, description?, tags?, triggers?, defaultInput?, inputMapping?, configOverrides?, concurrency?, scheduleMode?
 *   - output: the updated automation doc
 *
 * Owner-only — server enforces via `verifyAutomationAccess(..., 'owner')`.
 * Members and viewers receive 403.
 *
 * Use this to surgically patch an automation's config (e.g. changing a cron
 * schedule or concurrency mode) without recreating it. Forbidden fields
 * (automationId, userId, graphId) are ignored or rejected by the API.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

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

const ALLOWED_STATUSES = ['active', 'paused', 'disabled', 'error'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

const CONCURRENCY_MODES = ['allow', 'skip', 'queue', 'interrupt'] as const;

/**
 * Concurrency schema fragment. Accepts EITHER the legacy bare-mode string OR the
 * numeric object `{ mode, max }` (TOTAL scope, or a per-trigger override).
 *   - mode: allow (unlimited) | skip (drop at cap) | queue (defer at cap) | interrupt
 *   - max:  positive integer cap. Ignored for mode 'allow'. Omit with skip/queue
 *           for the legacy cap of 1.
 */
const CONCURRENCY_SCHEMA = {
  anyOf: [
    { type: 'string', enum: [...CONCURRENCY_MODES] },
    {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...CONCURRENCY_MODES] },
        max: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
  ],
  description:
    'Concurrency cap. String mode (allow|skip|queue|interrupt) OR object { mode, max } where max is a positive integer. TOTAL scope on the automation; per-trigger override on triggers[].concurrency. Enforced atomically at trigger time.',
} as const;

/**
 * Validate a raw concurrency value (string mode or { mode, max } object).
 * Returns an error string or null. Mirrors normalizeAutomationConcurrency's
 * accepted shapes without pulling the Redis-backed limiter into the tool.
 */
function validateConcurrency(value: unknown, label: string): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    return (CONCURRENCY_MODES as readonly string[]).includes(value)
      ? null
      : `${label} must be one of ${CONCURRENCY_MODES.join(', ')} (or a { mode, max } object)`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.mode !== undefined && !(CONCURRENCY_MODES as readonly string[]).includes(obj.mode as string)) {
      return `${label}.mode must be one of ${CONCURRENCY_MODES.join(', ')}`;
    }
    if (obj.max !== undefined) {
      const n = obj.max;
      if (typeof n !== 'number' || !Number.isFinite(n) || Math.floor(n) < 1) {
        return `${label}.max must be a positive integer`;
      }
    }
    return null;
  }
  return `${label} must be a mode string or a { mode, max } object`;
}

const updateAutomationTool: NativeToolDefinition = {
  description:
    "Surgically update an existing automation's configuration (name, description, tags, triggers, defaultInput, inputMapping, configOverrides, concurrency, scheduleMode, status). Owner-only. Pass `status: 'paused'` to pause or `status: 'active'` to resume — this is the single canonical knob for pause/resume.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to update.',
      },
      name: { type: 'string' },
      description: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      triggers: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            type: { type: 'string', enum: ['webhook', 'schedule', 'manual', 'event'] },
            config: { type: 'object', additionalProperties: true },
            concurrency: CONCURRENCY_SCHEMA,
          },
          required: ['type'],
        },
      },
      defaultInput: { type: 'object', additionalProperties: true },
      inputMapping: { type: 'object', additionalProperties: true },
      configOverrides: { type: 'object', additionalProperties: true },
      concurrency: CONCURRENCY_SCHEMA,
      scheduleMode: { type: 'string', enum: ['cron', 'interval'] },
      status: {
        type: 'string',
        enum: ['active', 'paused', 'disabled', 'error'],
        description: "Canonical lifecycle field. 'active' = scheduler runs it; 'paused' = user pause; 'disabled' = admin/tier off; 'error' = auto-marked after validation failure.",
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const { automationId, ...patch } = rawArgs as any;

    if (typeof automationId !== 'string' || !automationId.trim()) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'automationId is required', code: 'VALIDATION' }) }],
        isError: true,
      };
    }

    // Protection: don't even send forbidden fields if the LLM hallucinated them into the patch.
    // The API enforces this too, but we catch it early for better feedback.
    const forbidden = ['userId', 'graphId', 'createdAt', 'updatedAt'];
    for (const key of forbidden) {
      if (key in patch) delete patch[key];
    }

    // Validate concurrency shape early (total + per-trigger override) for a
    // clearer error than the webapp's generic 400.
    if ('concurrency' in patch) {
      const err = validateConcurrency(patch.concurrency, 'concurrency');
      if (err) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: err, code: 'VALIDATION' }) }],
          isError: true,
        };
      }
    }
    if (Array.isArray(patch.triggers)) {
      for (let i = 0; i < patch.triggers.length; i++) {
        const t = patch.triggers[i];
        if (t && typeof t === 'object' && 'concurrency' in t) {
          const err = validateConcurrency(t.concurrency, `triggers[${i}].concurrency`);
          if (err) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: err, code: 'VALIDATION' }) }],
              isError: true,
            };
          }
        }
      }
    }

    // Canonical-status compatibility shim for the deprecation window.
    // Spec: explanations/automation-status-spec.md.
    // The webapp PATCH endpoint currently still keys on `isEnabled` and
    // pair-writes `status` from it (route.ts:242-244). Until phase 6 flips
    // the endpoint to accept `status` directly, translate any `status`
    // argument into the equivalent `isEnabled` boolean here so a caller
    // passing the canonical field gets the correct mongo write.
    if (typeof patch.status === 'string') {
      const normalized = patch.status as AllowedStatus;
      if (!(ALLOWED_STATUSES as readonly string[]).includes(normalized)) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `status must be one of ${ALLOWED_STATUSES.join(', ')}`, code: 'VALIDATION' }) }],
          isError: true,
        };
      }
      // active ⇄ isEnabled:true ; everything else ⇄ isEnabled:false
      if (patch.isEnabled === undefined) {
        patch.isEnabled = normalized === 'active';
      }
      // Drop the status field — the endpoint doesn't accept it yet (phase 6 fixes).
      delete patch.status;
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify(patch),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return {
          content: [{ type: 'text', text: JSON.stringify(data || { error: `Automation API ${response.status}`, status: response.status }) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, automation: data.automation || data }) }],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message, automationId }) }],
        isError: true,
      };
    }
  },
};

export default updateAutomationTool;
module.exports = updateAutomationTool;
