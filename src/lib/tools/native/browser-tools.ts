/**
 * browser-tools — browser native tools (redbtn browser extension)
 *
 * Thin tools that let a graph drive a user's browser: list / tabs / snapshot /
 * read / screenshot / navigate / click / type / key / hover / scroll / select /
 * fill_form / wait_for / dialog / evaluate / console / network / upload /
 * record_start / record_status / record_stop and tab locks. Each reads `userId` from the run state, builds a `BrowserAction`,
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
 *   browser_release_lock, browser_record_start, browser_record_status,
 *   browser_record_stop.
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
  const userId = resolveUserId(context);
  if (!userId) return undefined;

  if (!envArg && !browserArg) {
    if (fuzzyBrowserLookupAllowed(context)) {
      try {
        const mongoose = await import('mongoose');
        const conn = mongoose.connection;
        if (conn?.db) {
          const docs = await conn.db.collection('environments').find({ userId, kind: 'browser' }).toArray();
          if (docs.length === 1 && docs[0].installId) {
            return docs[0].installId;
          }
          if (docs.length > 1) {
            const matches = docs.map((d: any) => `${d.name || '(unnamed)'} [${d.environmentId || d.installId?.slice(0, 8)}]`).join(', ');
            throw new Error(`Multiple browser environments exist (${matches}); pass environmentId or browser to select one.`);
          }
        }
      } catch (err: any) {
        if (err?.message && err.message.includes('Multiple browser environments')) throw err;
      }
    }
    throw new Error('environmentId is required to target a browser instance.');
  }

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
  opts: { includeTabId?: boolean; includeRef?: boolean; defaultTimeoutMs?: number } = {},
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
      const withTimeout = opts.defaultTimeoutMs && args.timeoutMs === undefined
        ? { ...args, timeoutMs: opts.defaultTimeoutMs }
        : args;
      return dispatch(context, cleanAction(build(args)), withTimeout);
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
    waitMs: { type: 'number', description: "Wait up to this many ms for the opened tab to finish loading (action:'open')." },
  },
  [],
  (args) => ({ action: 'tabs', op: args.action || 'list', tabId: args.tabId, url: args.url, waitMs: args.waitMs }),
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
  'Capture a screenshot of a tab in the target browser at 1:1 CSS viewport scale and return it as an image the model can see, plus geometry. Fails safe with a browser_failed error if no browser is connected.',
  {
    format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image encoding. Default png.' },
    quality: { type: 'number', description: 'JPEG quality 1-100 (default 80, used when format is jpeg).' },
    fullRes: { type: 'boolean', description: 'Capture at native devicePixelRatio instead of 1:1 CSS viewport scale (default false).' },
  },
  [],
  (args) => ({ action: 'screenshot', tabId: args.tabId, format: args.format, quality: args.quality, fullRes: args.fullRes }),
);

const browserNavigateTool = makeTool(
  'browser_navigate',
  "Navigate a tab in the target browser: op:'url' (default when `url` is given) loads `url`; op:'back' / 'forward' / 'reload' move through history. Fails safe with a browser_failed error if no browser is connected.",
  {
    url: { type: 'string', description: 'URL to load.' },
    op: { type: 'string', enum: ['url', 'back', 'forward', 'reload'], description: "Navigation operation: 'url', 'back', 'forward' or 'reload'." },
    wait: { type: 'boolean', description: 'Wait briefly for navigation to complete before returning (default true).' },
    waitMs: { type: 'number', description: 'Maximum time in ms to wait for page load (default 2500, max 15000).' },
  },
  [],
  (args) => ({ action: 'navigate', op: args.op || (args.url ? 'url' : undefined), url: args.url, wait: args.wait, waitMs: args.waitMs, tabId: args.tabId }),
);

const browserClickTool = makeTool(
  'browser_click',
  'Click an element in a tab of the target browser — by `ref` from browser_snapshot, by CSS `selector`, by visible `text`, or by `x`/`y` coordinates (plus element-relative `offsetX`/`offsetY` or normalized `nx`/`ny` 0..1 for <canvas> / WebGL targets). Supports button (left/right/middle), modifiers, and double-click. Fails safe with a browser_failed error if no browser is connected.',
  {
    selector: { type: 'string', description: 'CSS selector to click directly without a snapshot (e.g. "canvas#stage").' },
    text: { type: 'string', description: 'Visible button/link text or aria-label to click directly without a snapshot.' },
    x: { type: 'number', description: 'Viewport X coordinate to click (alternative to ref/selector/text).' },
    y: { type: 'number', description: 'Viewport Y coordinate to click (alternative to ref/selector/text).' },
    offsetX: { type: 'number', description: 'Pixel X offset from the top-left of the target element (ref/selector).' },
    offsetY: { type: 'number', description: 'Pixel Y offset from the top-left of the target element (ref/selector).' },
    nx: { type: 'number', description: 'Normalized X (0..1) inside the target element (or viewport when no element is given).' },
    ny: { type: 'number', description: 'Normalized Y (0..1) inside the target element (or viewport when no element is given).' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button. Default left.' },
    double: { type: 'boolean', description: 'Double-click instead of a single click.' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifier keys held during click (e.g. ["Shift", "Alt"]).' },
  },
  [],
  (args) => ({
    action: 'click',
    ref: args.ref,
    selector: args.selector,
    text: args.text,
    x: args.x,
    y: args.y,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    nx: args.nx,
    ny: args.ny,
    tabId: args.tabId,
    button: args.button,
    double: args.double,
    modifiers: args.modifiers,
  }),
  { includeRef: true },
);

const browserDragTool = makeTool(
  'browser_drag',
  'Drag the mouse across a <canvas>, WebGL/Three.js scene, slider, or drag-and-drop target via CDP Input.dispatchMouseEvent with held mouse buttons. Supports 2-point drags (`from` + `to`, or `dx`/`dy`), multi-point strokes (`path` array of waypoints), or standalone `op: "down" | "up" | "move"`. Coordinates can be viewport (`x`/`y`), element-relative (`offsetX`/`offsetY`), or normalized `0..1` (`nx`/`ny`) inside `selector` or `ref`. Fails safe with a browser_failed error if no browser is connected.',
  {
    op: { type: 'string', enum: ['drag', 'down', 'up', 'move'], description: 'Operation: "drag" (default full press->move->release), or standalone "down", "up", "move".' },
    selector: { type: 'string', description: 'CSS selector for element-relative coordinates (e.g. "canvas").' },
    from: { type: 'object', description: 'Start point: { x, y } or { offsetX, offsetY } or { nx, ny } or { ref } or { selector }.' },
    to: { type: 'object', description: 'End point: { x, y } or { offsetX, offsetY } or { nx, ny } or { ref } or { selector }.' },
    path: { type: 'array', items: { type: 'object' }, description: 'Multi-point stroke array of >= 2 point objects ({ x, y } / { offsetX, offsetY } / { nx, ny }).' },
    fromX: { type: 'number', description: 'Start viewport X (shorthand).' },
    fromY: { type: 'number', description: 'Start viewport Y (shorthand).' },
    toX: { type: 'number', description: 'End viewport X (shorthand).' },
    toY: { type: 'number', description: 'End viewport Y (shorthand).' },
    dx: { type: 'number', description: 'Relative horizontal drag distance in pixels from start.' },
    dy: { type: 'number', description: 'Relative vertical drag distance in pixels from start.' },
    x: { type: 'number', description: 'Target X (for op="down"|"up"|"move" or start of dx/dy drag).' },
    y: { type: 'number', description: 'Target Y (for op="down"|"up"|"move" or start of dx/dy drag).' },
    offsetX: { type: 'number', description: 'Element-relative X offset in pixels.' },
    offsetY: { type: 'number', description: 'Element-relative Y offset in pixels.' },
    nx: { type: 'number', description: 'Normalized X (0..1) inside selector/ref or viewport.' },
    ny: { type: 'number', description: 'Normalized Y (0..1) inside selector/ref or viewport.' },
    steps: { type: 'number', description: 'Number of interpolated mouseMoved steps per segment (default 12, max 120).' },
    durationMs: { type: 'number', description: 'Total drag duration in ms across all steps (default 120).' },
    button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button held during drag. Default left.' },
    buttons: { type: 'number', description: 'CDP buttons bitmask (1=left, 2=right, 4=middle) for op="move".' },
    modifiers: { type: 'array', items: { type: 'string' }, description: 'Modifier keys held during drag (e.g. ["Shift"]).' },
  },
  [],
  (args) => ({
    action: 'drag',
    op: args.op,
    ref: args.ref,
    selector: args.selector,
    from: args.from,
    to: args.to,
    path: args.path,
    fromX: args.fromX,
    fromY: args.fromY,
    toX: args.toX,
    toY: args.toY,
    dx: args.dx,
    dy: args.dy,
    x: args.x,
    y: args.y,
    offsetX: args.offsetX,
    offsetY: args.offsetY,
    nx: args.nx,
    ny: args.ny,
    steps: args.steps,
    durationMs: args.durationMs,
    button: args.button,
    buttons: args.buttons,
    modifiers: args.modifiers,
    tabId: args.tabId,
  }),
  { includeRef: true },
);

const browserResizeTool = makeTool(
  'browser_resize',
  'Resize a tab viewport or emulate a mobile/tablet/desktop screen via CDP Emulation.setDeviceMetricsOverride + touch emulation. Pass `preset: "mobile"` (390x844 @3x mobile), `"tablet"` (820x1180 @2x mobile), `"desktop"` (1440x900 @2x), or custom `width` + `height` (+ `deviceScaleFactor`, `mobile`, `orientation`). Pass `reset: true` (or `preset: "reset"`) to restore the normal browser viewport. Fails safe with a browser_failed error if no browser is connected.',
  {
    preset: { type: 'string', enum: ['mobile', 'iphone', 'tablet', 'ipad', 'desktop', 'reset'], description: 'Named viewport preset ("mobile"=390x844 @3x, "tablet"=820x1180 @2x, "desktop"=1440x900 @2x, "reset"=clear override).' },
    width: { type: 'number', description: 'Viewport width in CSS pixels (200-7680).' },
    height: { type: 'number', description: 'Viewport height in CSS pixels (200-4320).' },
    deviceScaleFactor: { type: 'number', description: 'Device pixel ratio (0.5-4, default 1 or preset DPR).' },
    mobile: { type: 'boolean', description: 'Enable mobile layout + touch emulation.' },
    orientation: { type: 'string', enum: ['portrait', 'landscape'], description: 'Screen orientation (swaps width/height when landscape).' },
    window: { type: 'boolean', description: 'Also resize the OS browser window to width x height.' },
    reset: { type: 'boolean', description: 'Clear viewport override and restore normal browser dimensions.' },
  },
  [],
  (args) => ({
    action: 'resize',
    preset: args.preset,
    width: args.width,
    height: args.height,
    deviceScaleFactor: args.deviceScaleFactor,
    mobile: args.mobile,
    orientation: args.orientation,
    window: args.window,
    reset: args.reset,
    tabId: args.tabId,
  }),
);

const browserTypeTool = makeTool(
  'browser_type',
  'Type text into an element (by `ref` or CSS `selector`) or the focused element of a tab in the target browser. Fails safe with a browser_failed error if no browser is connected.',
  {
    text: { type: 'string', description: 'Text to type. Required.' },
    selector: { type: 'string', description: 'CSS selector to focus before typing.' },
  },
  ['text'],
  (args) => ({ action: 'type', text: args.text, ref: args.ref, selector: args.selector, tabId: args.tabId }),
  { includeRef: true },
);

const browserPressKeyTool = makeTool(
  'browser_press_key',
  'Press a key or key chord in a tab of the target browser. Pass `keys` as an array of key names (e.g. ["Control", "l"] or ["Enter"]), or a single `key`. Fails safe with a browser_failed error if no browser is connected.',
  {
    keys: { type: 'array', items: { type: 'string' }, description: 'Key names to press together / in sequence. Required (or pass `key`).' },
    key: { type: 'string', description: 'Single key alias for `keys`.' },
    selector: { type: 'string', description: 'CSS selector to focus before pressing keys.' },
  },
  ['keys'],
  (args) => ({ action: 'press_key', keys: args.keys || (args.key ? [args.key] : undefined), ref: args.ref, selector: args.selector, tabId: args.tabId }),
  { includeRef: true },
);

const browserHoverTool = makeTool(
  'browser_hover',
  'Hover over an element in a tab of the target browser — by `ref` from browser_snapshot, CSS `selector`, visible `text`, or by `x`/`y` / `offsetX`/`offsetY` / `nx`/`ny` coordinates. Fails safe with a browser_failed error if no browser is connected.',
  {
    selector: { type: 'string', description: 'CSS selector to hover.' },
    text: { type: 'string', description: 'Visible text or aria-label to hover.' },
    x: { type: 'number', description: 'X coordinate to hover (alternative to ref).' },
    y: { type: 'number', description: 'Y coordinate to hover (alternative to ref).' },
    offsetX: { type: 'number', description: 'Pixel X offset from top-left of target element.' },
    offsetY: { type: 'number', description: 'Pixel Y offset from top-left of target element.' },
    nx: { type: 'number', description: 'Normalized X (0..1) inside target element or viewport.' },
    ny: { type: 'number', description: 'Normalized Y (0..1) inside target element or viewport.' },
  },
  [],
  (args) => ({ action: 'hover', ref: args.ref, selector: args.selector, text: args.text, x: args.x, y: args.y, offsetX: args.offsetX, offsetY: args.offsetY, nx: args.nx, ny: args.ny, tabId: args.tabId }),
  { includeRef: true },
);

const browserScrollTool = makeTool(
  'browser_scroll',
  'Scroll a tab of the target browser by `dx`/`dy` pixels (optionally at `selector`/`ref` or `x`/`y`/`offsetX`/`offsetY`/`nx`/`ny`, e.g. to wheel-zoom a <canvas>), or scroll an element into view by `ref` or CSS `selector`. Fails safe with a browser_failed error if no browser is connected.',
  {
    dx: { type: 'number', description: 'Horizontal scroll delta in pixels.' },
    dy: { type: 'number', description: 'Vertical scroll delta in pixels.' },
    selector: { type: 'string', description: 'CSS selector of an element to scroll into view (or dispatch wheel at when dx/dy are given).' },
    x: { type: 'number', description: 'Viewport X where wheel event is dispatched.' },
    y: { type: 'number', description: 'Viewport Y where wheel event is dispatched.' },
    offsetX: { type: 'number', description: 'Element-relative X offset where wheel event is dispatched.' },
    offsetY: { type: 'number', description: 'Element-relative Y offset where wheel event is dispatched.' },
    nx: { type: 'number', description: 'Normalized X (0..1) where wheel event is dispatched.' },
    ny: { type: 'number', description: 'Normalized Y (0..1) where wheel event is dispatched.' },
  },
  [],
  (args) => ({ action: 'scroll', dx: args.dx, dy: args.dy, ref: args.ref, selector: args.selector, x: args.x, y: args.y, offsetX: args.offsetX, offsetY: args.offsetY, nx: args.nx, ny: args.ny, tabId: args.tabId }),
  { includeRef: true },
);

const browserSelectTool = makeTool(
  'browser_select',
  'Select an option in a <select> element (by `ref` or CSS `selector`) in a tab of the target browser, by option `value` or visible `text`. Fails safe with a browser_failed error if no browser is connected.',
  {
    selector: { type: 'string', description: 'CSS selector of the <select> element.' },
    value: { type: 'string', description: 'Option value to select.' },
    text: { type: 'string', description: 'Visible option text to select (alternative to value).' },
  },
  [],
  (args) => ({ action: 'select', ref: args.ref, selector: args.selector, value: args.value, text: args.text, tabId: args.tabId }),
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
  'Wait for a condition in a tab of the target browser: an element `ref`, visible `text`, CSS `selector`, or `url` pattern to match, up to `timeoutMs`. Fails safe with a browser_failed error if no browser is connected.',
  {
    text: { type: 'string', description: 'Visible text to wait for.' },
    selector: { type: 'string', description: 'CSS selector to wait for.' },
    url: { type: 'string', description: 'URL substring or /regex/ to wait for.' },
  },
  [],
  (args) => ({ action: 'wait_for', ref: args.ref, text: args.text, selector: args.selector, url: args.url, tabId: args.tabId, timeoutMs: args.timeoutMs }),
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
  'Evaluate a JavaScript `expression` in a tab (or iframe via `frame`) of the target browser and return its result. Powerful — use only when snapshot/read cannot answer. Fails safe with a browser_failed error if no browser is connected.',
  {
    expression: { type: 'string', description: 'JavaScript expression to evaluate. Required.' },
    frame: { type: 'string', description: 'Run inside an iframe instead of the top page: URL substring, frame name or frameId (see browser_frames). Works for cross-origin iframes.' },
  },
  ['expression'],
  (args) => ({ action: 'evaluate', expression: args.expression, frame: args.frame, tabId: args.tabId }),
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
  'Read network requests captured from a tab of the target browser, including cross-origin iframes and workers. Supports filter (substring or /regex/), type, frame, status, media (pinned HLS/DASH playlists), headers, clear, reload, waitMs, and watch.',
  {
    limit: { type: 'number', description: 'Maximum number of requests to return (default 50, max 1500).' },
    filter: { type: 'string', description: 'Only URLs containing this text, or matching /regex/flags.' },
    type: { type: 'string', description: 'Comma-separated resource types, e.g. "XHR,Fetch,Media,Document,Script".' },
    frame: { type: 'string', description: 'Only requests made by a frame/target whose URL contains this text.' },
    status: { type: 'string', description: 'Status filter: "200", "4xx", "5xx" or "failed".' },
    media: { type: 'boolean', description: 'Only HLS/DASH playlists, manifests and media requests (pinned buffer).' },
    headers: { type: 'boolean', description: 'Include request/response headers.' },
    clear: { type: 'boolean', description: 'Empty the buffer before reading.' },
    reload: { type: 'boolean', description: 'Clear, hard-reload the tab and capture from its first request.' },
    waitMs: { type: 'number', description: 'Wait this long before reading (default 4000 with reload, max 30000).' },
    watch: { type: 'boolean', description: 'Keep the tab attached past the 60s idle sweep so capture continues.' },
  },
  [],
  (args) => ({
    action: 'network',
    limit: args.limit,
    filter: args.filter,
    type: args.type,
    frame: args.frame,
    status: args.status,
    media: args.media,
    headers: args.headers,
    clear: args.clear,
    reload: args.reload,
    waitMs: args.waitMs,
    watch: args.watch,
    tabId: args.tabId,
  }),
);

const browserNetworkBodyTool = makeTool(
  'browser_network_body',
  'Read the response body of a request listed by browser_network (by `requestId`), e.g. the text of an .m3u8 playlist. Text is returned decoded; binary stays base64.',
  {
    requestId: { type: 'string', description: 'requestId from a browser_network entry. Required.' },
    maxBytes: { type: 'number', description: 'Cap on returned characters (default 65536, max 262144).' },
  },
  ['requestId'],
  (args) => ({ action: 'network_body', requestId: args.requestId, maxBytes: args.maxBytes, tabId: args.tabId }),
);

const browserFramesTool = makeTool(
  'browser_frames',
  "List the page's frames and cross-origin iframe/worker targets. These are the values browser_evaluate's `frame` can address.",
  {},
  [],
  (args) => ({ action: 'frames', tabId: args.tabId }),
);

const browserUploadTool = makeTool(
  'browser_upload',
  'Upload file content to a file input (by `ref` or CSS `selector`) in a tab of the target browser: a single file via `fileName` + `contentBase64` (+ `mimeType`), or multiple via `files` (array of file objects). Fails safe with a browser_failed error if no browser is connected.',
  {
    selector: { type: 'string', description: 'CSS selector of the file input element.' },
    fileName: { type: 'string', description: 'File name for the single-file upload.' },
    contentBase64: { type: 'string', description: 'Base64-encoded file content for the single-file upload.' },
    mimeType: { type: 'string', description: 'MIME type of the uploaded file.' },
    files: { type: 'array', items: { type: 'object' }, description: 'Multiple file objects (e.g. { fileName, contentBase64, mimeType }).' },
  },
  [],
  (args) => ({ action: 'upload', ref: args.ref, selector: args.selector, fileName: args.fileName, contentBase64: args.contentBase64, mimeType: args.mimeType, files: args.files, tabId: args.tabId }),
  { includeRef: true },
);

const browserAcquireLockTool = makeTool(
  'browser_acquire_lock',
  'Acquire the exclusive tab/browser lock on the target browser so other agents do not drive it concurrently. `minutes` sets the lock duration; `note` records why. Fails safe with a browser_failed error if no browser is connected.',
  {
    name: { type: 'string', description: 'Lock name (default "default").' },
    minutes: { type: 'number', description: 'Lock duration in minutes (default 10, max 240).' },
    note: { type: 'string', description: 'Note describing why the lock is held.' },
  },
  [],
  (args) => ({ action: 'acquire_lock', name: args.name, minutes: args.minutes, note: args.note }),
  { includeTabId: false },
);

const browserReleaseLockTool = makeTool(
  'browser_release_lock',
  'Release the tab/browser lock previously acquired with browser_acquire_lock on the target browser. Fails safe with a browser_failed error if no browser is connected.',
  {
    name: { type: 'string', description: 'Lock name (default "default").' },
    force: { type: 'boolean', description: 'Force-release even if held by another agent.' },
  },
  [],
  (args) => ({ action: 'release_lock', name: args.name, force: args.force }),
  { includeTabId: false },
);

const browserReloadTool = makeTool(
  'browser_reload',
  'Reload the redbtn Browser extension itself (to pick up an updated build on disk or a downloaded CRX update), or check its running version/buildId against disk (`checkOnly: true`).',
  {
    checkOnly: { type: 'boolean', description: 'When true, return running vs on-disk version/buildId without reloading.' },
    onlyIfChanged: { type: 'boolean', description: 'When true, reload only if disk buildId/version or a CRX update differs from the running extension.' },
  },
  [],
  (args) => ({ action: 'reload', checkOnly: args.checkOnly, onlyIfChanged: args.onlyIfChanged }),
  { includeTabId: false },
);

const browserRecordStartTool = makeTool(
  'browser_record_start',
  'Start recording a tab as video, audio, or combined video+audio, for demos, walkthroughs and bug reports. Keep driving the page with the other browser_* tools, then call browser_record_stop to get the file. Pass `mode: "both"` (or `audio: true`) for combined video + audio, `mode: "audio"` for audio-only, or `mode: "video"` (default) for video-only. One recording at a time. For video modes, the tab must be active and visible, because Chrome only paints what is on screen; activate it with browser_tabs first if needed. Agent clicks and hovers are drawn as a cursor. Frames and audio from any site this browser does not permit are blanked/muted automatically. Fails safe with a browser_failed error if no browser is connected.',
  {
    mode: { type: 'string', enum: ['video', 'audio', 'both'], description: 'Recording mode: "video" (default), "audio" (audio-only), or "both" (combined video + audio).' },
    audio: { type: 'boolean', description: 'Include tab audio in the recording (shorthand for mode="both" when true).' },
    fps: { type: 'number', description: 'Output frames per second, 1-60. Default 30.' },
    maxSeconds: { type: 'number', description: 'Stop capturing after this long, 1-1800. Default 300. browser_record_stop must still be called to save the file.' },
    format: { type: 'string', enum: ['mp4', 'webm'], description: 'Container. Default mp4 (H.264/AAC). Falls back to the other one if this browser cannot encode it. WebM files have no duration header, so some players cannot seek them.' },
    bitrate: { type: 'number', description: 'Target video bits per second. Default 4000000. Lower it for long recordings: uploads are capped at 50 MB.' },
    quality: { type: 'number', description: 'JPEG quality of the captured frames, 10-100. Default 80.' },
    maxWidth: { type: 'number', description: 'Maximum capture width in pixels. Default 1920.' },
    maxHeight: { type: 'number', description: 'Maximum capture height in pixels. Default 1080.' },
    cursor: { type: 'boolean', description: 'Draw the agent cursor and click ripples into the video. Default true.' },
  },
  [],
  (args) => ({
    action: 'record_start',
    tabId: args.tabId,
    mode: args.mode,
    audio: args.audio,
    fps: args.fps,
    maxSeconds: args.maxSeconds,
    format: args.format,
    bitrate: args.bitrate,
    quality: args.quality,
    maxWidth: args.maxWidth,
    maxHeight: args.maxHeight,
    cursor: args.cursor,
  }),
);

const browserRecordStatusTool = makeTool(
  'browser_record_status',
  'Check the current recording: state (idle, recording, finished), duration, frames captured, hiddenFrames (frames blanked because the site was not permitted) and bytes so far. A state of finished with an endReason means a limit or a closed tab ended it, and browser_record_stop must still be called to save it. Fails safe with a browser_failed error if no browser is connected.',
  {},
  [],
  (_args) => ({ action: 'record_status' }),
  { includeTabId: false },
);

const browserRecordStopTool = makeTool(
  'browser_record_stop',
  'Stop the recording and save it. The video is not returned inline. By default it is saved to the Downloads folder of the machine running the browser (download.path) and uploaded as a redbtn attachment of up to 50 MB (upload.url, upload.attachmentId). If one destination fails, downloadError or uploadError says why. If every destination fails the extension keeps the recording, so this can be called again. Fails safe with a browser_failed error if no browser is connected.',
  {
    save: { type: 'string', enum: ['both', 'download', 'upload'], description: 'Where to save the video. Default both.' },
    filename: { type: 'string', description: 'File name. The extension always matches the real container.' },
    caption: { type: 'string', description: 'Caption for the uploaded attachment.' },
    discard: { type: 'boolean', description: 'Throw the recording away instead of saving it.' },
  },
  [],
  (args) => ({ action: 'record_stop', save: args.save, filename: args.filename, caption: args.caption, discard: args.discard }),
  // Encoding, a disk write and an upload don't fit the 12s default; the hub caps at 120s.
  { includeTabId: false, defaultTimeoutMs: 120_000 },
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
  browser_drag: browserDragTool,
  browser_resize: browserResizeTool,
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
  browser_network_body: browserNetworkBodyTool,
  browser_frames: browserFramesTool,
  browser_upload: browserUploadTool,
  browser_acquire_lock: browserAcquireLockTool,
  browser_release_lock: browserReleaseLockTool,
  browser_reload: browserReloadTool,
  browser_record_start: browserRecordStartTool,
  browser_record_status: browserRecordStatusTool,
  browser_record_stop: browserRecordStopTool,
};

export const browserList = browserListTool;
export const browserTabs = browserTabsTool;
export const browserSnapshot = browserSnapshotTool;
export const browserRead = browserReadTool;
export const browserScreenshot = browserScreenshotTool;
export const browserNavigate = browserNavigateTool;
export const browserClick = browserClickTool;
export const browserDrag = browserDragTool;
export const browserResize = browserResizeTool;
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
export const browserNetworkBody = browserNetworkBodyTool;
export const browserFrames = browserFramesTool;
export const browserUpload = browserUploadTool;
export const browserAcquireLock = browserAcquireLockTool;
export const browserReleaseLock = browserReleaseLockTool;
export const browserReload = browserReloadTool;
export const browserRecordStart = browserRecordStartTool;
export const browserRecordStatus = browserRecordStatusTool;
export const browserRecordStop = browserRecordStopTool;

(module as any).exports = {
  browserList: browserListTool,
  browserTabs: browserTabsTool,
  browserSnapshot: browserSnapshotTool,
  browserRead: browserReadTool,
  browserScreenshot: browserScreenshotTool,
  browserNavigate: browserNavigateTool,
  browserClick: browserClickTool,
  browserDrag: browserDragTool,
  browserResize: browserResizeTool,
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
  browserNetworkBody: browserNetworkBodyTool,
  browserFrames: browserFramesTool,
  browserUpload: browserUploadTool,
  browserAcquireLock: browserAcquireLockTool,
  browserReleaseLock: browserReleaseLockTool,
  browserReload: browserReloadTool,
  browserRecordStart: browserRecordStartTool,
  browserRecordStatus: browserRecordStatusTool,
  browserRecordStop: browserRecordStopTool,
  BROWSER_TOOLS,
};
