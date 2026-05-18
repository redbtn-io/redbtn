/**
 * Update Automation — Native Automation Tool
 *
 * Patches an existing automation's configuration in place via the webapp API
 * (`PATCH /api/v1/automations/:automationId`) — WITHOUT recreating it.
 *
 * Before this tool, changing a cron schedule, concurrency mode, trigger array,
 * or defaultInput required a direct MongoDB write to the `automations`
 * collection. This tool closes that gap.
 *
 * Patchable fields (all optional, partial-merge semantics):
 *   - triggers        — full trigger array (replaces the existing array)
 *   - scheduleMode    — 'cron' | 'interval'
 *   - concurrency     — 'allow' | 'skip' | 'queue' | 'interrupt'
 *   - defaultInput    — default graph input object
 *   - inputMapping    — input mapping object
 *   - configOverrides — per-run config overrides object
 *   - name            — display name
 *   - description     — description text
 *   - tags            — string array
 *
 * Forbidden fields (rejected before any request is issued):
 *   - graphId / streamId — changing the target = a different automation
 *   - userId             — ownership is immutable
 *   - isSystem / _id     — internal identity fields
 *
 * Owner-only — the webapp route enforces this via
 * `verifyAutomationAccess(..., 'owner')`. Members / viewers receive 403 which
 * surfaces here as `isError: true`.
 *
 * Any `schedule`-type trigger carrying a `config.cron` expression is
 * re-validated locally with `cron-parser` before the request is sent, so an
 * invalid cron never reaches the database.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// Loaded via require (not ESM import) so this file stays CommonJS — the native
// registry loads tool modules with require() and reads `module.exports`.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const cronParser = require('cron-parser') as {
  parseExpression: (expr: string, options?: AnyObject) => unknown;
};

/** Fields a caller may patch through this tool. */
const PATCHABLE_FIELDS = [
  'triggers',
  'scheduleMode',
  'concurrency',
  'defaultInput',
  'inputMapping',
  'configOverrides',
  'name',
  'description',
  'tags',
] as const;

/**
 * Fields that must NEVER be changed via a patch. Changing graphId/streamId
 * effectively makes a different automation; userId/isSystem/_id are identity.
 */
const FORBIDDEN_FIELDS = ['graphId', 'streamId', 'userId', 'isSystem', '_id'];

const CONCURRENCY_MODES = ['allow', 'skip', 'queue', 'interrupt'];
const SCHEDULE_MODES = ['cron', 'interval'];

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

function errorResult(error: string, code: string, extra?: AnyObject): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error, code, ...extra }) }],
    isError: true,
  };
}

/**
 * Validate every `schedule`-type trigger that carries a cron expression.
 * Returns an error string on the first invalid expression, or null if all OK.
 */
function validateTriggerCrons(triggers: unknown): string | null {
  if (!Array.isArray(triggers)) {
    return 'triggers must be an array of { type, config } objects';
  }
  for (let i = 0; i < triggers.length; i++) {
    const t = triggers[i] as AnyObject;
    if (!t || typeof t !== 'object') {
      return `triggers[${i}] must be an object`;
    }
    const cron = t?.config?.cron;
    // Only schedule triggers carry cron; validate whenever a cron string is present.
    if (cron === undefined || cron === null || cron === '') continue;
    if (typeof cron !== 'string') {
      return `triggers[${i}].config.cron must be a string`;
    }
    try {
      cronParser.parseExpression(cron, { utc: true });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      return `triggers[${i}].config.cron is not a valid cron expression ("${cron}"): ${reason}`;
    }
  }
  return null;
}

const updateAutomationTool: NativeToolDefinition = {
  description:
    "Patch an existing automation's config in place (no recreate). Supply automationId plus any of: triggers, scheduleMode ('cron'|'interval'), concurrency ('allow'|'skip'|'queue'|'interrupt'), defaultInput, inputMapping, configOverrides, name, description, tags. Owner-only, partial-merge. Cannot change graphId/streamId/userId. Cron expressions on schedule triggers are re-validated before the patch is applied.",
  server: 'automation',
  inputSchema: {
    type: 'object',
    properties: {
      automationId: {
        type: 'string',
        description: 'The automationId of the automation to update.',
      },
      triggers: {
        type: 'array',
        description:
          'Full replacement trigger array. Each item is { type, config }. Schedule triggers use config.cron (re-validated) or config.intervalMs.',
        items: { type: 'object' },
      },
      scheduleMode: {
        type: 'string',
        enum: SCHEDULE_MODES,
        description: "Schedule mode — 'cron' (fixed cron schedule) or 'interval' (fixed delay).",
      },
      concurrency: {
        type: 'string',
        enum: CONCURRENCY_MODES,
        description:
          "Concurrency mode when a run is already active — 'allow', 'skip', 'queue', or 'interrupt'.",
      },
      defaultInput: {
        type: 'object',
        description: 'Default graph input merged into every run of this automation.',
      },
      inputMapping: {
        type: 'object',
        description: 'Input mapping object applied to incoming trigger payloads.',
      },
      configOverrides: {
        type: 'object',
        description: 'Per-run config overrides surfaced to the graph via {{parameters.X}}.',
      },
      name: { type: 'string', description: 'New display name.' },
      description: { type: 'string', description: 'New description text.' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replacement tag array.',
      },
    },
    required: ['automationId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as AnyObject;

    const automationId =
      typeof args.automationId === 'string' ? args.automationId.trim() : '';
    if (!automationId) {
      return errorResult(
        'automationId is required and must be a non-empty string',
        'VALIDATION',
      );
    }

    // Reject any attempt to mutate an immutable / identity field. Done before
    // any network call so a forbidden field can never silently slip through.
    const forbiddenPresent = FORBIDDEN_FIELDS.filter((f) => f in args);
    if (forbiddenPresent.length > 0) {
      return errorResult(
        `Cannot patch immutable field(s): ${forbiddenPresent.join(', ')}. ` +
          'Changing graphId/streamId makes a different automation; userId and identity fields are fixed.',
        'FORBIDDEN_FIELD',
        { forbiddenFields: forbiddenPresent },
      );
    }

    // Collect the patchable fields the caller actually supplied.
    const patch: AnyObject = {};
    for (const field of PATCHABLE_FIELDS) {
      if (args[field] !== undefined) patch[field] = args[field];
    }

    if (Object.keys(patch).length === 0) {
      return errorResult(
        `No patchable field supplied. Provide at least one of: ${PATCHABLE_FIELDS.join(', ')}`,
        'VALIDATION',
      );
    }

    // Validate enum-style fields up front for a clearer error than a 400.
    if (patch.scheduleMode !== undefined && !SCHEDULE_MODES.includes(patch.scheduleMode)) {
      return errorResult(
        `scheduleMode must be one of: ${SCHEDULE_MODES.join(', ')}`,
        'VALIDATION',
      );
    }
    if (patch.concurrency !== undefined && !CONCURRENCY_MODES.includes(patch.concurrency)) {
      return errorResult(
        `concurrency must be one of: ${CONCURRENCY_MODES.join(', ')}`,
        'VALIDATION',
      );
    }

    // Re-validate cron expressions on any schedule trigger before persisting.
    if (patch.triggers !== undefined) {
      const cronError = validateTriggerCrons(patch.triggers);
      if (cronError) {
        return errorResult(cronError, 'INVALID_CRON');
      }
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/automations/${encodeURIComponent(automationId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
        body: JSON.stringify(patch),
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

      let automation: AnyObject | undefined;
      try {
        const data = (await response.json()) as AnyObject;
        automation = (data?.automation ?? data) as AnyObject;
      } catch {
        /* response had no body — fall back to a bare ok */
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              automationId,
              patched: Object.keys(patch),
              ...(automation ? { automation } : {}),
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message, 'REQUEST_FAILED', { automationId });
    }
  },
};

export default updateAutomationTool;
module.exports = updateAutomationTool;
