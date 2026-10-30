/**
 * browser-tools — browser native tools (redbtn browser extension)
 *
 * Thin tools that let a graph drive a user's browser: list / tabs / snapshot /
 * read / screenshot / navigate / click / type / key / hover / scroll / select /
 * fill_form / wait_for / dialog / evaluate / console / network / upload and
 * tab locks. Each reads `userId` from the run state, builds a `BrowserAction`,
 * round-trips it through `requestDesktopRaw` (Redis request→reply over the
 * /ws/desktop gateway, kind:'browser'), and returns the result.
 *
 * Wire contract (fixed, other lanes build to it): a browser call dispatches
 *   requestDesktopRaw({ kind: 'browser', payload: { request: BrowserAction } })
 * where BrowserAction = { action: <verb>, ...args, runId?, agentName? }.
 * The extension replies { ok, result?, image?: { format, base64, width,
 * height }, error?: { code, message } } (image may also be at result.image).
 *
 * # Config-driven
 *
 * Graphs reference these `toolName`s in a `tool` step (no compiler changes):
 *   browser_list, browser_tabs, browser_snapshot, browser_read,
 *   browser_screenshot, browser_navigate, browser_click, browser_type,
 *   browser_press_key, browser_hover, browser_scroll, browser_select,
 *   browser_fill_form, browser_wait_for, browser_dialog, browser_evaluate,
 *   browser_console, browser_network, browser_upload, browser_acquire_lock,
 *   browser_release_lock.
 *
 * # Fail-safe
 *
 * `requestDesktopRaw` never throws — it returns { ok:false, error } on any
 * failure (no browser connected, timeout, transport error). These tools
 * surface that verbatim so the LLM can adapt rather than crash the run.
 *
 * # Honesty (the rule these tools exist to keep)
 *
 * Fail-safe is not the same as truthful. Every handler answers ONE question —
 * did the requested action actually happen? — and returns an MCP error
 * envelope (`isError: true`) plus a top-level `{ error: { code, message } }`
 * whenever the answer is no: the extension replied `ok:false`, or the reply
 * carried no usable error detail (one is synthesised, code 'browser_failed').
 * The extension's evidence payload is forwarded instead of being rebuilt away.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';
import { resolveRunUserId } from './_run-identity';
import { requestDesktopRaw } from './desktop-request';
import { getCapabilityProfile } from '../../run/contextLookup';
import type { BrowserAction } from './browser-types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

function resolveUserId(context: NativeToolContext): string | null {
  const userId =
    resolveRunUserId(context) ||
    (context?.state?.options?.userId as string | undefined);
  return userId && String(userId).trim() ? String(userId).trim() : null;
}

/** Per-tool override of the round-trip timeout (ms). */
function resolveTimeoutMs(args: AnyObject): number | undefined {
  const raw = args?.timeoutMs;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Standard text-only result wrapper. */
function textResult(value: unknown, isError = false): NativeMcpResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

/** No-userId fail-safe (never throw into the run). */
function noUserResult(): NativeMcpResult {
  return textResult({
    ok: false,
    error: { code: 'browser_failed', message: 'No userId available in run context; cannot target any browser.' },
  }, true);
}

function isRecord(value: unknown): value is AnyObject {
  return value !== null && typeof value === 'object';
}

/** Does `browser` name this environment exactly (environmentId, installId or name, case-insensitively)? */
function browserNamesEnvironment(browser: string, env: AnyObject | null | undefined): boolean {
  const m = browser.trim().toLowerCase();
  if (!m || !env) return false;
  return [env.environmentId, env.installId, env.name].some(
    (v) => typeof v === 'string' && v.trim().toLowerCase() === m,
  );
}

/**
 * May a browser-only call use FUZZY lookup (installId prefix, name substring)?
 * Only when no scoped grant governs it: an ungated tool, an unprofiled run, or
 * a profile that grants 'browser' on '*'. Mirrors desktop's
 * fuzzyMachineLookupAllowed (2026-10-12 hardening).
 */
function fuzzyBrowserLookupAllowed(context: NativeToolContext): boolean {
  const profile = getCapabilityProfile(context?.state);
  if (!profile) return true;
  return (profile.capabilities ?? []).some(
    (c: AnyObject) => c?.resource === 'browser' && typeof c?.selector === 'string' && c.selector.trim() === '*',
  );
}

/**
 * Resolve the target browser's installId from `environmentId` OR `browser`
 * (with `machine` accepted as an alias for the target string).
 *
 *   - `environmentId` given: resolve it, never fall back when it fails, refuse
 *     when the resolved env.kind !== 'browser' (naming the actual kind), and
 *     refuse when `browser` names a different browser.
 *   - `browser` only: a UUID is treated as an installId directly; otherwise a
 *     Mongo environments query with kind:'browser' — exact matches always,
 *     fuzzy (installId prefix / name substring) only where no scoped grant
 *     governs the call. Multiple matches throw, listing them.
 */
async function resolveTargetInstallId(
  context: NativeToolContext,
  args: AnyObject,
): Promise<string | undefined> {
  const envArg = typeof args?.environmentId === 'string' ? args.environmentId.trim() : '';
  const browserArgRaw =
    typeof args?.browser === 'string' && args.browser.trim()
      ? args.browser
      : typeof args?.machine === 'string'
        ? args.machine
        : '';
  const browserArg = browserArgRaw.trim();
  if (!envArg && !browserArg) {
    throw new Error('environmentId is required to target a browser instance.');
  }
  const userId = resolveUserId(context);
  if (!userId) return undefined;

  // 1. Explicit environmentId: the checked address. Resolve it or fail.
  if (envArg) {
    let env: AnyObject;
    try {
      ({ env } = await loadAndResolveEnvironment(envArg, userId));
    } catch (err) {
      throw new Error(`Failed to resolve environment ${envArg}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (env?.kind !== 'browser') {
      throw new Error(
        `environment "${envArg}" is a ${env?.kind || 'unknown'} environment, not a browser environment.`,
      );
    }
    if (browserArg && !browserNamesEnvironment(browserArg, { ...env, environmentId: env?.environmentId ?? envArg })) {
      throw new Error(
        `environmentId "${envArg}" and browser "${browserArg}" name different browsers; pass only one of them.`,
      );
    }
    return env.installId;
  }

  // 2. Browser string only.
  const q = browserArg;
  const fuzzy = fuzzyBrowserLookupAllowed(context);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    return q;
  }

  try {
    const mongoose = await import('mongoose');
    const conn = mongoose.connection;
    if (conn?.db) {
      const envCol = conn.db.collection('environments');
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const docs = await envCol.find({
        userId,
        kind: 'browser',
        $or: fuzzy
          ? [
              { environmentId: q },
              { installId: q },
              { name: { $regex: `^${escaped}$`, $options: 'i' } },
              { installId: { $regex: `^${escaped}`, $options: 'i' } },
              { name: { $regex: escaped, $options: 'i' } },
            ]
          : [
              { environmentId: q },
              { installId: q },
              { name: { $regex: `^${escaped}$`, $options: 'i' } },
            ],
      }).toArray();

      if (docs.length === 1 && docs[0].installId) {
        return docs[0].installId;
      }
      if (docs.length > 1) {
        const matches = docs.map((d: any) => `${d.name || '(unnamed)'} [${d.installId?.slice(0, 8)}]`).join(', ');
        throw new Error(`"${q}" matches multiple browser environments: ${matches}`);
      }
      if (!fuzzy) {
        throw new Error(`No browser environment is named exactly "${q}" (pass its environmentId).`);
      }
    }
  } catch (err: any) {
    if (err?.message && (err.message.includes('matches multiple') || err.message.includes('named exactly'))) {
      throw err;
    }
  }

  try {
    const { env } = await loadAndResolveEnvironment(q, userId);
    if ((env as AnyObject)?.kind && (env as AnyObject).kind !== 'browser') {
      throw new Error(
        `environment "${q}" is a ${(env as AnyObject).kind} environment, not a browser environment.`,
      );
    }
    return env.installId;
  } catch (err: any) {
    if (err?.message && err.message.includes('not a browser environment')) throw err;
    if (!fuzzy) throw new Error(`Failed to resolve browser "${q}".`);
    return q;
  }
}

/** Drop undefined keys so the wire payload carries only what was asked for. */
function cleanAction(action: BrowserAction): BrowserAction {
  const out: AnyObject = {};
  for (const [k, v] of Object.entries(action as AnyObject)) {
    if (v !== undefined) out[k] = v;
  }
  return out as BrowserAction;
}

/**
 * Resolve target, stamp run identity, dispatch one BrowserAction through
 * requestDesktopRaw (kind:'browser'), and wrap the extension's reply:
 * image replies become a real MCP image block + a text JSON block with the
 * base64 stripped; everything else is a text JSON result, isError iff the
 * extension did not report ok:true, with a synthesised error when it left none.
 */
async function dispatch(
  context: NativeToolContext,
  request: BrowserAction,
  args: AnyObject,
): Promise<NativeMcpResult> {
  const userId = resolveUserId(context);
  if (!userId) return noUserResult();

  if (!args?.environmentId && !args?.browser && !args?.machine) {
    return textResult({
      ok: false,
      error: { code: 'browser_failed', message: 'environmentId is required to target a browser instance.' },
    }, true);
  }

  let installId: string | undefined = undefined;
  try {
    installId = await resolveTargetInstallId(context, args);
    if (!installId) {
      return textResult({
        ok: false,
        error: {
          code: 'browser_failed',
          message: `Target environment ${args.environmentId || args.browser || args.machine} does not have an active browser connection (missing installId).`,
        },
      }, true);
    }
  } catch (err: any) {
    return textResult({
      ok: false,
      error: { code: 'browser_failed', message: err instanceof Error ? err.message : String(err) },
    }, true);
  }

  const agentName =
    (typeof args?.agentName === 'string' && args.agentName) ||
    context?.state?.agentName ||
    context?.state?.options?.agentName ||
    undefined;
  const stamped = cleanAction({
    ...request,
    ...(context?.runId ? { runId: context.runId } : {}),
    ...(agentName ? { agentName: String(agentName) } : {}),
  } as BrowserAction);

  context?.publisher?.emit?.('log', `browser_${stamped.action} → desktop:cmd:${userId}:${installId}`);
  const reply: AnyObject = await requestDesktopRaw({
    userId,
    installId,
    kind: 'browser',
    payload: { request: stamped },
    timeoutMs: resolveTimeoutMs(args),
  });

  const isError = reply?.ok !== true;
  const image =
    isRecord(reply?.image) && typeof reply.image.base64 === 'string' && reply.image.base64
      ? reply.image
      : isRecord(reply?.result?.image) && typeof reply.result.image.base64 === 'string' && reply.result.image.base64
        ? reply.result.image
        : null;

  if (image) {
    const cleaned: AnyObject = JSON.parse(JSON.stringify(reply ?? {}));
    if (isRecord(cleaned.image)) delete cleaned.image.base64;
    if (isRecord(cleaned.result?.image)) delete cleaned.result.image.base64;
    if (isError && !cleaned.error) {
      cleaned.error = { code: 'browser_failed', message: 'the browser reported failure with no detail' };
    }
    const mimeType =
      typeof image.mimeType === 'string' && image.mimeType
        ? image.mimeType
        : image.format === 'jpeg'
          ? 'image/jpeg'
          : 'image/png';
    return {
      content: [
        { type: 'image', data: image.base64, mimeType },
        { type: 'text', text: JSON.stringify(cleaned) },
      ],
      ...(isError ? { isError: true } : {}),
    };
  }

  if (isError && !(isRecord(reply) && reply.error)) {
    const body: AnyObject = isRecord(reply) ? { ...reply } : { ok: false };
    body.error = { code: 'browser_failed', message: 'the browser reported failure with no detail' };
    return textResult(body, true);
  }
  return textResult(reply, isError);
}

// ─── tool factory ────────────────────────────────────────────────────────────

const BROWSER_PROP = {
  type: 'string',
  description:
    'Target browser environment: environmentId, installId, id prefix, or part of its name (e.g. "Chrome Work"). Use browser_list to see the options.',
};
const ENVIRONMENT_ID_PROP = {
  type: 'string',
  description: 'environmentId of the target browser environment.',
};
const TIMEOUT_PROP = { type: 'number', description: 'Optional round-trip timeout in ms.' };
const TAB_ID_PROP = { type: 'number', description: 'Tab id (from browser_tabs). Omit for the active tab.' };
const REF_PROP = { type: 'string', description: 'Element ref from browser_snapshot.' };

type BuildFn = (args: AnyObject) => BrowserAction;

function makeTool(
  _name: string,
  description: string,
  extraProps: AnyObject,
  required: string[],
  build: BuildFn,
  opts: { includeTabId?: boolean; includeRef?: boolean } = {},
): NativeToolDefinition {
  const properties: AnyObject = {
    browser: BROWSER_PROP,
    environmentId: ENVIRONMENT_ID_PROP,
    timeoutMs: TIMEOUT_PROP,
    ...(opts.includeTabId === false ? {} : { tabId: TAB_ID_PROP }),
    ...(opts.includeRef ? { ref: REF_PROP } : {}),
    ...extraProps,
  };
  return {
    description,
    server: 'browser',
    inputSchema: { type: 'object', properties, required },
    async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
      const args = rawArgs || {};
      return dispatch(context, cleanAction(build(args)), args);
    },
  };
}

// ─── browser_list ────────────────────────────────────────────────────────────

const browserListTool: NativeToolDefinition = {
  description:
    "List the registered browser environments (redbtn browser extension) for the current user, showing their environmentId, name, installId, connection status (online/offline), and capabilities.",
  server: 'browser',
  inputSchema: {
    type: 'object',
    properties: {
      timeoutMs: { type: 'number', description: 'Optional timeout in ms.' },
    },
    required: [],
  },

  async handler(_rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();

    try {
      const mongoose = require('mongoose');
      const db = mongoose.connection?.db;
      if (!db) {
        return textResult({ ok: false, error: { code: 'browser_failed', message: 'Database connection not available.' } }, true);
      }

      const docs = await db.collection('environments')
        .find({ userId, kind: 'browser' })
        .sort({ updatedAt: -1 })
        .toArray();

      const Redis = require('ioredis');
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      const redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

      const presentInstallIds = new Set<string>();
      try {
        const presencePrefix = 'desktop:presence:';
        const match = `${presencePrefix}${userId}:*`;
        let cursor = '0';
        let iterations = 0;
        do {
          const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 100);
          cursor = next;
          for (const key of keys) {
            const installId = key.slice(`${presencePrefix}${userId}:`.length);
            if (installId) presentInstallIds.add(installId);
          }
          iterations += 1;
        } while (cursor !== '0' && iterations < 1000);
      } catch (err) {
        console.error('[browser_list] presence scan failed:', err);
      } finally {
        redis.disconnect();
      }

      const browsers = docs.map((doc: any) => {
        const installId = doc.installId || '';
        const present = typeof installId === 'string' && installId.length > 0 && presentInstallIds.has(installId);
        return {
          environmentId: doc.environmentId,
          name: doc.name || '',
          kind: 'browser' as const,
          installId,
          online: present,
          lastSeenAt: doc.lastSeenAt || doc.updatedAt || null,
          capabilities: doc.capabilities || [],
        };
      });

      return textResult({ ok: true, browsers });
    } catch (err) {
      return textResult({
        ok: false,
        error: {
          code: 'browser_failed',
          message: `Failed to list browsers: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, true);
    }
  },
};

// ─── targeted tools (via makeTool) ───────────────────────────────────────────

const browserTabsTool = makeTool(
  'browser_tabs',
  "List, open, close or activate tabs in the target browser. action:'list' (default) returns the tabs; 'open' opens `url` in a new tab; 'close' / 'activate' act on `tabId`. Round-trips over Redis to the browser extension; fails safe with a browser_failed error if no browser is connected.",
  {
    action: { type: 'string', enum: ['list', 'open', 'close', 'activate'], default: 'list', description: "Tab operation: 'list', 'open', 'close' or 'activate'." },
    url: { type: 'string', description: "URL to open (action:'open')." },
  },
  [],
  (args) => ({ action: 'tabs', op: args.action || 'list', tabId: args.tabId, url: args.url }),
);

const browserSnapshotTool = makeTool(
  'browser_snapshot',
  'Take an accessibility snapshot of a tab in the target browser: a structured element tree with stable refs you can pass to browser_click / browser_type / browser_hover / browser_select / browser_upload. Fails safe with a browser_failed error if no browser is connected.',
  {},
  [],
  (args) => ({ action: 'snapshot', tabId: args.tabId }),
);

const browserReadTool = makeTool(
  'browser_read',
  "Read a tab's page content from the target browser as text or markdown (format:'text' default, 'markdown'). Fails safe with a browser_failed error if no browser is connected.",
  {
    format: { type: 'string', enum: ['text', 'markdown'], description: "Output format: 'text' or 'markdown'." },
  },
  [],
  (args) => ({ action: 'read', tabId: args.tabId, format: args.format }),
);

const browserScreenshotTool = makeTool(
  'browser_screenshot',
  'Capture a screenshot of a tab in the target browser and return it as an image the model can see, plus geometry. Fails safe with a browser_failed error if no browser is connected.',
  {
    format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image encoding. Default png.' },
  },
  [],
  (args) => ({ action: 'screenshot', tabId: args.tabId, format: args.format }),
);

const browserNavigateTool = makeTool(
  'browser_navigate',
  "Navigate a tab in the target browser: op:'url' (default when `url` is given) loads `url`; op:'back' / 'forward' / 'reload' move through history. Fails safe with a browser_failed error if no browser is connected.",
  {
    url: { type: 'string', description: 'URL to load.' },
    op: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: "Navigation operation: 'url', 'back', 'forward' or 'reload'." },
  },
  [],
  (args) => ({ action: 'navigate', op: args.op || (args.url ? 'url' : undefined), url: args.url, tabId: args.tabId }),
);

const browserClickTool = makeTool(
  'browser_click',
  'Click an element in a tab of the target browser — by `ref` from browser_snapshot, or by `x`/`y` coordinates. Supports button (left/right/middle) and double-click. Fails safe with a browser_failed error if no browser is connected.',
  {
    x: { type: 'number', description: 'X coordinate to click (alternative to ref).' },
    y: { type: 'number', description: 'Y coordinate to click (alternative to ref).' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
    double: { type: 'boolean', description: 'Double-click instead of a single click.' },
  },
  [],
  (args) => ({ action: 'click', ref: args.ref, x: args.x, y: args.y, tabId: args.tabId, button: args.button, double: args.double }),
  { includeRef: true },
);

const browserTypeTool = makeTool(
  'browser_type',
  'Type text into an element (by `ref` from browser_snapshot) or the focused element of a tab in the target browser. Fails safe with a browser_failed error if no browser is connected.',
  {
    text: { type: 'string', description: 'Text to type. Required.' },
  },
  ['text'],
  (args) => ({ action: 'type', text: args.text, ref: args.ref, tabId: args.tabId }),
  { includeRef: true },
);

const browserPressKeyTool = makeTool(
  'browser_press_key',
  'Press a key or key chord in a tab of the target browser. Pass `keys` as an array of key names (e.g. ["Control", "l"] or ["Enter"]), or a single `key`. Fails safe with a browser_failed error if no browser is connected.',
  {
    keys: { type: 'array', items: { type: 'string' }, description: 'Key names to press together / in sequence. Required (or pass `key`).' },
    key: { type: 'string', description: 'Single key alias for `keys`.' },
  },
  ['keys'],
  (args) => ({ action: 'press_key', keys: args.keys || (args.key ? [args.key] : undefined), tabId: args.tabId }),
);

const browserHoverTool = makeTool(
  'browser_hover',
  'Hover over an element in a tab of the target browser — by `ref` from browser_snapshot, or by `x`/`y` coordinates. Fails safe with a browser_failed error if no browser is connected.',
  {
    x: { type: 'number', description: 'X coordinate to hover (alternative to ref).' },
    y: { type: 'number', description: 'Y coordinate to hover (alternative to ref).' },
  },
  [],
  (args) => ({ action: 'hover', ref: args.ref, x: args.x, y: args.y, tabId: args.tabId }),
  { includeRef: true },
);

const browserScrollTool = makeTool(
  'browser_scroll',
  'Scroll a tab of the target browser by `dx`/`dy` pixels, optionally within an element given by `ref`. Fails safe with a browser_failed error if no browser is connected.',
  {
    dx: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
    dy: { type: 'number', description: 'Vertical scroll delta in pixels.' },
  },
  [],
  (args) => ({ action: 'scroll', dx: args.dx, dy: args.dy, ref: args.ref, tabId: args.tabId }),
  { includeRef: true },
);

const browserSelectTool = makeTool(
  'browser_select',
  'Select an option in a <select> element (by `ref` from browser_snapshot) in a tab of the target browser, by option `value` or visible `text`. Fails safe with a browser_failed error if no browser is connected.',
  {
    value: { type: 'string', description: 'Option value to select.' },
    text: { type: 'string', description: 'Visible option text to select (alternative to value).' },
  },
  [],
  (args) => ({ action: 'select', ref: args.ref, value: args.value, text: args.text, tabId: args.tabId }),
  { includeRef: true },
);

const browserFillFormTool = makeTool(
  'browser_fill_form',
  'Fill multiple form fields in a tab of the target browser in one call. `fields` is an array of field objects (e.g. { ref, value } or { selector, value } / { name, value }), as understood by the extension. Fails safe with a browser_failed error if no browser is connected.',
  {
    fields: { type: 'array', items: { type: 'object' }, description: 'Field objects to fill. Required.' },
  },
  ['fields'],
  (args) => ({ action: 'fill_form', fields: args.fields, tabId: args.tabId }),
);

const browserWaitForTool = makeTool(
  'browser_wait_for',
  'Wait for a condition in a tab of the target browser: an element `ref`, visible `text`, or a CSS `selector` to appear, up to `timeoutMs`. Fails safe with a browser_failed error if no browser is connected.',
  {
    text: { type: 'string', description: 'Visible text to wait for.' },
    selector: { type: 'string', description: 'CSS selector to wait for.' },
  },
  [],
  (args) => ({ action: 'wait_for', ref: args.ref, text: args.text, selector: args.selector, tabId: args.tabId, timeoutMs: args.timeoutMs }),
  { includeRef: true },
);

const browserDialogTool = makeTool(
  'browser_dialog',
  "Handle a native dialog (alert / confirm / prompt) in a tab of the target browser: op:'accept' (default) or op:'dismiss'; `promptText` supplies the prompt response when accepting. Fails safe with a browser_failed error if no browser is connected.",
  {
    op: { type: 'string', enum: ['accept', 'dismiss'], description: "'accept' or 'dismiss'. Default 'accept'." },
    promptText: { type: 'string', description: 'Text to enter into a prompt dialog when accepting.' },
  },
  [],
  (args) => ({ action: 'dialog', op: args.op || 'accept', promptText: args.promptText, tabId: args.tabId }),
);

const browserEvaluateTool = makeTool(
  'browser_evaluate',
  'Evaluate a JavaScript `expression` in a tab of the target browser and return its result. Powerful — use only when snapshot/read cannot answer. Fails safe with a browser_failed error if no browser is connected.',
  {
    expression: { type: 'string', description: 'JavaScript expression to evaluate. Required.' },
  },
  ['expression'],
  (args) => ({ action: 'evaluate', expression: args.expression, tabId: args.tabId }),
);

const browserConsoleTool = makeTool(
  'browser_console',
  'Read recent console messages captured from a tab of the target browser, optionally filtered by `level` and capped by `limit`. Fails safe with a browser_failed error if no browser is connected.',
  {
    level: { type: 'string', description: 'Console level filter (e.g. log, info, warn, error).' },
    limit: { type: 'number', description: 'Maximum number of messages to return.' },
  },
  [],
  (args) => ({ action: 'console', level: args.level, limit: args.limit, tabId: args.tabId }),
);

const browserNetworkTool = makeTool(
  'browser_network',
  'Read recent network requests captured from a tab of the target browser, capped by `limit`. Fails safe with a browser_failed error if no browser is connected.',
  {
    limit: { type: 'number', description: 'Maximum number of requests to return.' },
  },
  [],
  (args) => ({ action: 'network', limit: args.limit, tabId: args.tabId }),
);

const browserUploadTool = makeTool(
  'browser_upload',
  'Upload file content to a file input (by `ref` from browser_snapshot) in a tab of the target browser: a single file via `fileName` + `contentBase64` (+ `mimeType`), or multiple via `files` (array of file objects). Fails safe with a browser_failed error if no browser is connected.',
  {
    fileName: { type: 'string', description: 'File name for the single-file upload.' },
    contentBase64: { type: 'string', description: 'Base64-encoded file content for the single-file upload.' },
    mimeType: { type: 'string', description: 'MIME type of the uploaded file.' },
    files: { type: 'array', items: { type: 'object' }, description: 'Multiple file objects (e.g. { fileName, contentBase64, mimeType }).' },
  },
  [],
  (args) => ({ action: 'upload', ref: args.ref, fileName: args.fileName, contentBase64: args.contentBase64, mimeType: args.mimeType, files: args.files, tabId: args.tabId }),
  { includeRef: true },
);

const browserAcquireLockTool = makeTool(
  'browser_acquire_lock',
  'Acquire the exclusive tab/browser lock on the target browser so other agents do not drive it concurrently. `minutes` sets the lock duration; `note` records why. Fails safe with a browser_failed error if no browser is connected.',
  {
    minutes: { type: 'number', description: 'Lock duration in minutes.' },
    note: { type: 'string', description: 'Note describing why the lock is held.' },
  },
  [],
  (args) => ({ action: 'acquire_lock', minutes: args.minutes, note: args.note }),
  { includeTabId: false },
);

const browserReleaseLockTool = makeTool(
  'browser_release_lock',
  'Release the tab/browser lock previously acquired with browser_acquire_lock on the target browser. Fails safe with a browser_failed error if no browser is connected.',
  {},
  [],
  (_args) => ({ action: 'release_lock' }),
  { includeTabId: false },
);

// ─── Exports ─────────────────────────────────────────────────────────────────

export const BROWSER_TOOLS: Record<string, NativeToolDefinition> = {
  browser_list: browserListTool,
  browser_tabs: browserTabsTool,
  browser_snapshot: browserSnapshotTool,
  browser_read: browserReadTool,
  browser_screenshot: browserScreenshotTool,
  browser_navigate: browserNavigateTool,
  browser_click: browserClickTool,
  browser_type: browserTypeTool,
  browser_press_key: browserPressKeyTool,
  browser_hover: browserHoverTool,
  browser_scroll: browserScrollTool,
  browser_select: browserSelectTool,
  browser_fill_form: browserFillFormTool,
  browser_wait_for: browserWaitForTool,
  browser_dialog: browserDialogTool,
  browser_evaluate: browserEvaluateTool,
  browser_console: browserConsoleTool,
  browser_network: browserNetworkTool,
  browser_upload: browserUploadTool,
  browser_acquire_lock: browserAcquireLockTool,
  browser_release_lock: browserReleaseLockTool,
};

export const browserList = browserListTool;
export const browserTabs = browserTabsTool;
export const browserSnapshot = browserSnapshotTool;
export const browserRead = browserReadTool;
export const browserScreenshot = browserScreenshotTool;
export const browserNavigate = browserNavigateTool;
export const browserClick = browserClickTool;
export const browserType = browserTypeTool;
export const browserPressKey = browserPressKeyTool;
export const browserHover = browserHoverTool;
export const browserScroll = browserScrollTool;
export const browserSelect = browserSelectTool;
export const browserFillForm = browserFillFormTool;
export const browserWaitFor = browserWaitForTool;
export const browserDialog = browserDialogTool;
export const browserEvaluate = browserEvaluateTool;
export const browserConsole = browserConsoleTool;
export const browserNetwork = browserNetworkTool;
export const browserUpload = browserUploadTool;
export const browserAcquireLock = browserAcquireLockTool;
export const browserReleaseLock = browserReleaseLockTool;

(module as any).exports = {
  browserList: browserListTool,
  browserTabs: browserTabsTool,
  browserSnapshot: browserSnapshotTool,
  browserRead: browserReadTool,
  browserScreenshot: browserScreenshotTool,
  browserNavigate: browserNavigateTool,
  browserClick: browserClickTool,
  browserType: browserTypeTool,
  browserPressKey: browserPressKeyTool,
  browserHover: browserHoverTool,
  browserScroll: browserScrollTool,
  browserSelect: browserSelectTool,
  browserFillForm: browserFillFormTool,
  browserWaitFor: browserWaitForTool,
  browserDialog: browserDialogTool,
  browserEvaluate: browserEvaluateTool,
  browserConsole: browserConsoleTool,
  browserNetwork: browserNetworkTool,
  browserUpload: browserUploadTool,
  browserAcquireLock: browserAcquireLockTool,
  browserReleaseLock: browserReleaseLockTool,
  BROWSER_TOOLS,
};
