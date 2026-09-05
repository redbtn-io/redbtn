/**
 * desktop-computer — "computer use" native tools (redAgent push connector)
 *
 * Seven thin tools that let a graph drive a user's desktop: screenshot, click,
 * move, type, key-chord, scroll, and screen-info. Each reads `userId` from the
 * run state, builds a `ComputerAction`, round-trips it through `requestDesktop`
 * (Redis request→reply over the /ws/desktop gateway), and returns the result.
 *
 * Wire shapes mirror redAgent `src/shared/protocol.ts` `ComputerAction` /
 * `ComputerResultMessage` EXACTLY.
 *
 * # Config-driven
 *
 * Graphs reference these `toolName`s in a `tool` step (no compiler changes):
 *   desktop_screenshot, desktop_click, desktop_move, desktop_type,
 *   desktop_key, desktop_scroll, desktop_screen_info.
 *
 * # How `desktop_screenshot` returns the image
 *
 * It returns BOTH:
 *   1. a real MCP `image` content block ({ type:'image', data:<base64>,
 *      mimeType }) — so any consumer that understands image blocks gets the
 *      pixels, AND
 *   2. a `text` content block with JSON { ok, format, width, height, dataUrl,
 *      base64 } — so the value that lands in graph state (toolExecutor extracts
 *      `content[0]`, which is the image block here, but downstream graphs can
 *      also reference the text block) is usable config-side. The `dataUrl` is a
 *      ready-to-render `data:image/...;base64,...` string.
 *
 * NOTE: the engine's `tool` step extracts `content[0]` into state. We put the
 * IMAGE block first so MCP/image-aware consumers see it, and ALSO carry the
 * geometry+dataUrl in the text block for graph authors who wire a downstream
 * neuron with image input from state.
 *
 * # Fail-safe
 *
 * `requestDesktop` never throws — it returns a `computer_result` with
 * `ok:false` + a `computer_failed` error on any failure (no desktop connected,
 * timeout, transport error). These tools surface that verbatim so the LLM can
 * adapt rather than crash the run.
 *
 * # Honesty (the rule these tools exist to keep)
 *
 * Fail-safe is not the same as truthful. A tool that never throws can still
 * hand a model a success it did not earn, and a voice agent that believes it
 * opened a browser will narrate a browsing session that never happened.
 *
 * So every handler here answers ONE question — did the requested action
 * actually happen? — and returns an MCP error envelope (`isError: true`) plus a
 * top-level `{ error: { code, message } }` whenever the answer is no:
 *
 *   - the desktop replied `ok:false`                    (transport, consent, gate)
 *   - the command RAN and FAILED (`result.failed`, or a non-zero `result.exitCode`
 *     on connector builds that predate `failed`) — `ok:true` alone means only
 *     that an exit status came back, NOT that the command worked
 *   - the desktop was in DRY RUN (`result.dryRun`) and synthesized no input at
 *     all, which used to be flattened to a bare `{ok:true}` indistinguishable
 *     from a real keystroke
 *
 * And the desktop's evidence payload (`result`: dryRun, op, typed, text, keys,
 * unknownKeys, foregroundWindow, mouse `diag`) is forwarded to the model
 * instead of being rebuilt away, so "what did the machine say it did" is
 * answerable from the tool result itself.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';
import { requestDesktop, requestDesktopRaw, type ComputerAction, type ComputerResultMessage } from './desktop-request';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/** Resolve the target user from run state — same precedence as alert_desktop. */
function resolveUserId(context: NativeToolContext): string | null {
  const uid =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined) ||
    (context?.state?.options?.userId as string | undefined);
  return uid && String(uid).trim() ? String(uid).trim() : null;
}

/** Per-tool override of the round-trip timeout (ms). */
function resolveTimeoutMs(args: AnyObject): number | undefined {
  const raw = args?.timeoutMs;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Optional non-negative display index, or null when explicitly invalid. */
function resolveDisplayIndex(args: AnyObject): number | undefined | null {
  if (args?.display === undefined) return undefined;
  const display = args.display;
  return typeof display === 'number' && Number.isInteger(display) && display >= 0 ? display : null;
}

function invalidDisplayResult(): NativeMcpResult {
  return textResult({
    ok: false,
    error: { code: 'computer_failed', message: 'display must be a non-negative integer' },
  }, true);
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
    error: { code: 'computer_failed', message: 'No userId available in run context; cannot target any desktop.' },
  }, true);
}

// ─── honesty helpers ─────────────────────────────────────────────────────────
//
// ONE rule for every tool below: a result reaches the model as an ERROR
// (`isError: true` on the MCP envelope, plus a top-level `error`) whenever the
// requested action did not actually happen. Three things count as "did not
// happen", and all three used to read as success:
//
//   1. the desktop answered `ok:false`                      (always did)
//   2. the desktop ran the command and it FAILED            (`result.failed`)
//   3. the desktop was in DRY RUN and synthesized no input  (`result.dryRun`)
//
// The evidence payload is forwarded verbatim alongside the error, never
// replaced by it — the model should see BOTH that the action failed and what
// the desktop reported about it.

interface DesktopFailure {
  code: string;
  message: string;
}

function isRecord(value: unknown): value is AnyObject {
  return value !== null && typeof value === 'object';
}

/**
 * The desktop's own error, when it sent a usable one. The protocol shape is
 * `{code, message}`, but a bare string is accepted too rather than thrown away
 * in favour of a generic "no detail" line.
 */
function replyError(reply: AnyObject | null | undefined, fallbackCode: string): DesktopFailure | null {
  const err = reply?.error;
  if (isRecord(err) && typeof err.message === 'string' && err.message) {
    return { code: typeof err.code === 'string' && err.code ? err.code : fallbackCode, message: err.message };
  }
  if (typeof err === 'string' && err.trim()) return { code: fallbackCode, message: err };
  return null;
}

/**
 * Did an INPUT op (click / move / type / key / scroll) actually happen?
 *
 * Returns the failure to report, or null when the desktop really did it.
 * `dryRun:true` is the incident: the connector acknowledges the request, is
 * explicit that it synthesized nothing, and used to be flattened to `{ok:true}`
 * — a success for a keystroke that never existed.
 */
function inputFailure(result: ComputerResultMessage): DesktopFailure | null {
  if (result.ok !== true) {
    return (
      replyError(result as AnyObject, 'computer_failed') ?? {
        code: 'computer_failed',
        message: 'the desktop reported failure with no detail',
      }
    );
  }
  if (isRecord(result.result) && result.result.dryRun === true) {
    return {
      code: 'capability_disabled',
      message:
        'DRY RUN — real control is OFF on this desktop, so NOTHING HAPPENED: no click, keystroke or scroll was ' +
        'synthesized. The screen is unchanged. Do NOT report this action as done; ask the user to enable real ' +
        'control on the desktop app.',
    };
  }
  return null;
}

/**
 * Wrap an input op's reply for the model: evidence forwarded, failure named.
 *
 * `result.result` carries the connector's evidence (dryRun, op, typed, text,
 * keys, unknownKeys, foregroundWindow, or the mouse `diag`). Older connector
 * builds send nothing there; those still return a bare `{ok:true}`, which is
 * the pre-existing behaviour and not a regression.
 */
function inputResult(result: ComputerResultMessage): NativeMcpResult {
  const failure = inputFailure(result);
  return textResult(
    {
      // A dry run claims ok:true. It did nothing, so it is not ok.
      ok: failure === null,
      ...(result.result ? { result: result.result } : {}),
      ...(failure ? { error: failure } : {}),
    },
    failure !== null,
  );
}

/**
 * Did a `requestDesktopRaw` op (exec / settings) actually succeed?
 *
 * `ok` and `failed` mean different things on the connector and BOTH have to be
 * read (redbtn-desktop `src/main/environment/executor.ts`): `ok` says an exit
 * status came back at all, `failed` says that status means the command failed.
 * So `{ok:true, result:{exitCode:127, failed:true}}` is a command that ran and
 * did not work — reading `ok` alone reported it to the model as a success, and
 * that is exactly how a missing browser got narrated as a working browser.
 *
 * Connector builds older than the one that introduced `failed` are tolerated:
 * when the field is absent we fall back to a non-zero `exitCode`, and when both
 * are absent we report exactly what we did before.
 */
function rawFailure(reply: AnyObject | null | undefined): DesktopFailure | null {
  if (!isRecord(reply)) {
    return { code: 'desktop_failed', message: 'no reply from the desktop connector' };
  }
  if (reply.ok !== true) {
    // Covers transport errors, a closed capability gate, and `exec_timeout` —
    // a timeout resolves ok:false and carries partial stdout in `result`.
    return (
      replyError(reply, 'desktop_failed') ?? {
        code: 'desktop_failed',
        message: 'the desktop reported failure with no detail',
      }
    );
  }
  const r = reply.result;
  if (isRecord(r)) {
    const failed =
      typeof r.failed === 'boolean'
        ? r.failed
        : typeof r.exitCode === 'number'
          ? r.exitCode !== 0
          : false;
    if (failed) {
      const exit = typeof r.exitCode === 'number' ? String(r.exitCode) : 'unknown';
      const stderr = typeof r.stderr === 'string' ? r.stderr.trim() : '';
      return {
        code: 'exec_nonzero_exit',
        message:
          `the command RAN and FAILED (exit ${exit}) — it did NOT do what was asked. ` +
          `Read stdout/stderr on this result before reporting anything as done.` +
          (stderr ? ` stderr: ${stderr.slice(0, 500)}` : ''),
      };
    }
  }
  return null;
}

/**
 * Wrap an exec/settings reply for the model. The connector's reply is passed
 * through verbatim (stdout, stderr, exitCode, durationMs, truncated, settings);
 * on failure a top-level `error` is added when the connector did not send one,
 * so a consumer that only inspects `error` still sees the failure.
 */
function rawResult(reply: AnyObject | null | undefined): NativeMcpResult {
  const failure = rawFailure(reply);
  if (!failure) return textResult(reply);
  const body: AnyObject = isRecord(reply) ? { ...reply } : { ok: false };
  // Never overwrite what the connector said — only fill a gap it left.
  if (body.error === undefined || body.error === null || body.error === '') body.error = failure;
  return textResult(body, true);
}

/** Resolve installId from environmentId if specified. */
async function resolveInstallId(context: NativeToolContext, environmentId?: string): Promise<string | undefined> {
  if (!environmentId) return undefined;
  const userId = resolveUserId(context);
  if (!userId) return undefined;

  try {
    const { env } = await loadAndResolveEnvironment(environmentId, userId);
    return env.installId;
  } catch (err) {
    throw new Error(`Failed to resolve environment ${environmentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Run a computer action and map a non-screenshot result to a compact
 * `{ ok, error? }` text block.
 */
async function runAction(
  context: NativeToolContext,
  request: ComputerAction,
  args: AnyObject,
): Promise<ComputerResultMessage | null> {
  const userId = resolveUserId(context);
  if (!userId) return null;

  if (!args.environmentId) {
    return {
      kind: 'computer_result',
      id: '',
      ok: false,
      error: {
        code: 'computer_failed',
        message: 'environmentId is required to target a desktop instance.',
      },
    };
  }

  let installId: string | undefined = undefined;
  try {
    installId = await resolveInstallId(context, args.environmentId);
    if (!installId) {
      return {
        kind: 'computer_result',
        id: '',
        ok: false,
        error: {
          code: 'computer_failed',
          message: `Target environment ${args.environmentId} does not have an active desktop connection (missing installId).`,
        },
      };
    }
  } catch (err: any) {
    return {
      kind: 'computer_result',
      id: '',
      ok: false,
      error: {
        code: 'computer_failed',
        message: err.message,
      },
    };
  }

  context?.publisher?.emit?.('log', `desktop_${request.action} → desktop:cmd:${userId}:${installId}`);
  return requestDesktop({ userId, request, installId, timeoutMs: resolveTimeoutMs(args) });
}

// ─── desktop_screenshot ──────────────────────────────────────────────────────

const desktopScreenshotTool: NativeToolDefinition = {
  description:
    "Capture a screenshot of the current user's connected desktop (redAgent) and return it as an image the model can see, plus geometry. Round-trips over Redis to the /ws/desktop gateway; fails safe with a computer_failed error if no desktop is connected.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Image encoding. Default png.',
        default: 'png',
      },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info. Omitted means primary.',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional round-trip timeout in ms (default 30000).',
      },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const format: 'png' | 'jpeg' = rawArgs?.format === 'jpeg' ? 'jpeg' : 'png';
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const request: ComputerAction = { action: 'screenshot', format };
    if (display !== undefined) request.display = display;
    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();

    if (!result.ok || !result.image) {
      // No pixels came back. This MUST be an error envelope: a screenshot that
      // silently returns "ok-shaped" JSON is how a model comes to believe it is
      // looking at a screen it has never seen.
      return textResult({
        ok: false,
        error: result.error || { code: 'computer_failed', message: 'screenshot failed (no image returned)' },
      }, true);
    }

    const img = result.image;
    const mimeType = img.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const dataUrl = `data:${mimeType};base64,${img.base64}`;

    // Image block FIRST (so image-aware consumers see pixels), text block
    // SECOND (carries geometry + dataUrl for config-driven graph use).
    return {
      content: [
        { type: 'image', data: img.base64, mimeType },
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            format: img.format,
            width: img.width,
            height: img.height,
            sourceWidth: img.sourceWidth,
            sourceHeight: img.sourceHeight,
            clickSpace: img.clickSpace,
            display: img.display,
            mimeType,
            dataUrl,
            base64: img.base64,
          }),
        },
      ],
    };
  },
};

// ─── desktop_click ───────────────────────────────────────────────────────────

const desktopClickTool: NativeToolDefinition = {
  description:
    "Click the mouse in the CLICK SPACE reported by desktop_screenshot on the current user's connected desktop (redAgent). Supports display targeting, left/right/middle button, and double-click. Returns { ok, result } where `result` is the desktop's evidence for what it actually did; if real control is off the desktop synthesizes NOTHING and this comes back as an error, not a success.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      x: { type: 'number', description: 'Absolute X pixel coordinate. Required.' },
      y: { type: 'number', description: 'Absolute Y pixel coordinate. Required.' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button. Default left.',
        default: 'left',
      },
      double: { type: 'boolean', description: 'Perform a double-click. Default false.' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId', 'x', 'y'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const x = Number(rawArgs?.x);
    const y = Number(rawArgs?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'x and y must be finite numbers' } }, true);
    }
    const button: 'left' | 'right' | 'middle' =
      rawArgs?.button === 'right' ? 'right' : rawArgs?.button === 'middle' ? 'middle' : 'left';
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const request: ComputerAction = {
      action: 'mouse',
      op: 'click',
      x,
      y,
      button,
      double: rawArgs?.double === true,
    };
    if (display !== undefined) request.display = display;
    const result = await runAction(
      context,
      request,
      rawArgs,
    );
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_move ────────────────────────────────────────────────────────────

const desktopMoveTool: NativeToolDefinition = {
  description:
    "Move the mouse pointer (without clicking) in the CLICK SPACE reported by desktop_screenshot on the current user's connected desktop (redAgent). Returns { ok, result } where `result` is the desktop's evidence for what it actually did; if real control is off the pointer does NOT move and this comes back as an error.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      x: { type: 'number', description: 'Absolute X pixel coordinate. Required.' },
      y: { type: 'number', description: 'Absolute Y pixel coordinate. Required.' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId', 'x', 'y'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const x = Number(rawArgs?.x);
    const y = Number(rawArgs?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'x and y must be finite numbers' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const request: ComputerAction = { action: 'mouse', op: 'move', x, y };
    if (display !== undefined) request.display = display;
    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_type ────────────────────────────────────────────────────────────

const desktopTypeTool: NativeToolDefinition = {
  description:
    "Type literal text into whatever currently has keyboard focus on the current user's connected desktop (redAgent). Returns { ok, result } where `result` reports what was actually typed and into which focused window (`typed`, `text`, `foregroundWindow`). If real control is off, NO keystroke is synthesized and this comes back as an error — do not report the text as entered.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      text: { type: 'string', description: 'Literal text to type. Required.' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId', 'text'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text : '';
    if (!text) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'text is required' } }, true);
    }
    const result = await runAction(context, { action: 'keyboard', op: 'type', text }, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_key ─────────────────────────────────────────────────────────────

const desktopKeyTool: NativeToolDefinition = {
  description:
    "Tap a key or key-chord (e.g. ['ctrl','c'], ['enter'], ['alt','tab']) on the current user's connected desktop (redAgent). Keys are pressed together as a chord. Returns { ok, result } reporting which keys were actually pressed (`keys`), any the desktop did not recognise (`unknownKeys`), and the focused window. If real control is off, NO key is synthesized and this comes back as an error.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: "Key names forming a chord, e.g. ['ctrl','c'] or ['enter']. Required, non-empty.",
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId', 'keys'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const keys = Array.isArray(rawArgs?.keys)
      ? rawArgs.keys.filter((k: unknown): k is string => typeof k === 'string' && k.trim().length > 0)
      : [];
    if (keys.length === 0) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'keys must be a non-empty array of strings' } }, true);
    }
    const result = await runAction(context, { action: 'keyboard', op: 'tap', keys }, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_scroll ──────────────────────────────────────────────────────────

const desktopScrollTool: NativeToolDefinition = {
  description:
    "Scroll the mouse wheel on the current user's connected desktop (redAgent). Positive dy scrolls down, positive dx scrolls right. Returns { ok, result } with the desktop's evidence for what it actually did; if real control is off nothing scrolls and this comes back as an error.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      dx: { type: 'number', description: 'Horizontal wheel delta (positive = right). Default 0.' },
      dy: { type: 'number', description: 'Vertical wheel delta (positive = down). Default 0.' },
      x: { type: 'number', description: 'Optional pointer X to scroll at (absolute pixels).' },
      y: { type: 'number', description: 'Optional pointer Y to scroll at (absolute pixels).' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const dx = Number.isFinite(Number(rawArgs?.dx)) ? Number(rawArgs.dx) : 0;
    const dy = Number.isFinite(Number(rawArgs?.dy)) ? Number(rawArgs.dy) : 0;
    const req: ComputerAction = { action: 'mouse', op: 'scroll', dx, dy };
    if (Number.isFinite(Number(rawArgs?.x))) req.x = Number(rawArgs.x);
    if (Number.isFinite(Number(rawArgs?.y))) req.y = Number(rawArgs.y);
    const result = await runAction(context, req, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_screen_info ─────────────────────────────────────────────────────

const desktopScreenInfoTool: NativeToolDefinition = {
  description:
    "Enumerate the displays + geometry of the current user's connected desktop (redAgent). No capture, no input — returns each display's id, size, origin, scaleFactor, and primary flag.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const result = await runAction(context, { action: 'screen_info' }, rawArgs);
    if (!result) return noUserResult();
    return textResult({
      ok: result.ok,
      ...(result.screen ? { displays: result.screen.displays } : {}),
      ...(result.error ? { error: result.error } : {}),
    }, result.ok !== true);
  },
};


// ─── desktop_list ────────────────────────────────────────────────────────────

const desktopListTool: NativeToolDefinition = {
  description:
    "List the registered desktop/CLI connector environments (redAgent desktop + redbtn CLI) for the current user, showing their environmentId, name, installId, machineId, connection status (online/offline), and capabilities.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      timeoutMs: { type: 'number', description: 'Optional timeout in ms.' },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();

    try {
      const mongoose = require('mongoose');
      const db = mongoose.connection?.db;
      if (!db) {
        return textResult({ ok: false, error: { code: 'computer_failed', message: 'Database connection not available.' } }, true);
      }

      // 1. Fetch push-connector environments from DB (redAgent desktop + redbtn CLI)
      const docs = await db.collection('environments')
        .find({ userId, kind: { $in: ['desktop-agent', 'cli'] } })
        .sort({ updatedAt: -1 })
        .toArray();

      // 2. Fetch presence from Redis
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
        console.error('[desktop_list] presence scan failed:', err);
      } finally {
        redis.disconnect();
      }

      // 3. Map docs
      const desktops = docs.map((doc: any) => {
        const installId = doc.installId || '';
        const present = typeof installId === 'string' && installId.length > 0 && presentInstallIds.has(installId);
        return {
          environmentId: doc.environmentId,
          name: doc.name || '',
          kind: doc.kind || 'desktop-agent',
          installId,
          machineId: doc.machineId || null,
          online: present,
          lastSeenAt: doc.lastSeenAt || doc.updatedAt || null,
          capabilities: doc.capabilities || [],
        };
      });

      return textResult({ ok: true, desktops });
    } catch (err) {
      return textResult({
        ok: false,
        error: {
          code: 'computer_failed',
          message: `Failed to list desktops: ${err instanceof Error ? err.message : String(err)}`,
        },
      }, true);
    }
  }
};

// ─── Exports ─────────────────────────────────────────────────────────────────

export const desktopScreenshot = desktopScreenshotTool;
export const desktopClick = desktopClickTool;
export const desktopMove = desktopMoveTool;
export const desktopType = desktopTypeTool;
export const desktopKey = desktopKeyTool;
export const desktopScroll = desktopScrollTool;
export const desktopScreenInfo = desktopScreenInfoTool;
export const desktopList = desktopListTool;




// ─── desktop_exec ────────────────────────────────────────────────────────────

const desktopExecTool: NativeToolDefinition = {
  description:
    "Run a shell command on the current user's connected desktop (redAgent). Returns { ok, result:{ stdout, stderr, exitCode, durationMs, truncated, failed } }. `ok` only says an exit status came back; `failed` (or a non-zero `exitCode`) says the command RAN AND DID NOT WORK, and that case is returned to you as an ERROR — never report it as done. Round-trips over Redis to the /ws/desktop gateway; gated by the desktop's exec settings. Fails safe with a desktop_failed error if no desktop is connected, exec is disabled, or the command timed out.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      command: { type: 'string', description: 'Executable / command to run. Required.' },
      args: { type: 'array', items: { type: 'string' }, description: 'Argument vector (no shell parsing). Optional.' },
      cwd: { type: 'string', description: 'Working directory. Optional.' },
      env: { type: 'object', description: 'Extra environment variables. Optional.' },
      timeoutMs: { type: 'number', description: 'Hard-kill after this many ms. Optional.' },
    },
    required: ['environmentId', 'command'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();
    const command = typeof rawArgs?.command === 'string' ? rawArgs.command : '';
    if (!command.trim())
      return textResult({ ok: false, error: { code: 'desktop_failed', message: 'command is required' } }, true);

    if (!rawArgs.environmentId) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: 'environmentId is required to target a desktop instance.',
        },
      }, true);
    }

    let installId: string | undefined = undefined;
    try {
      installId = await resolveInstallId(context, rawArgs.environmentId);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId} does not have an active desktop connection (missing installId).`,
          },
        }, true);
      }
    } catch (err: any) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: err.message,
        },
      }, true);
    }

    const payload: AnyObject = { command };
    if (Array.isArray(rawArgs.args)) payload.args = rawArgs.args;
    if (typeof rawArgs.cwd === 'string') payload.cwd = rawArgs.cwd;
    if (rawArgs.env && typeof rawArgs.env === 'object') payload.env = rawArgs.env;
    if (typeof rawArgs.timeoutMs === 'number') payload.timeoutMs = rawArgs.timeoutMs;
    context?.publisher?.emit?.('log', `desktop_exec → desktop:cmd:${userId}:${installId}`);
    const reply = await requestDesktopRaw({ userId, kind: 'exec', payload, installId, timeoutMs: resolveTimeoutMs(rawArgs) });
    return rawResult(reply);
  },
};

// ─── desktop_settings ────────────────────────────────────────────────────────

const desktopSettingsTool: NativeToolDefinition = {
  description:
    "Read or update the current user's desktop (redAgent) local settings — TTS provider/voice/speed, computer-use & exec toggles, launch-at-login, etc. op:'get' returns current settings (secrets redacted); op:'set' shallow-merges `patch` and returns the updated settings. Round-trips over Redis to the /ws/desktop gateway.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      op: { type: 'string', enum: ['get', 'set'], description: "'get' to read, 'set' to merge patch. Required." },
      patch: { type: 'object', description: 'Partial settings to shallow-merge (op:set only).' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId', 'op'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();
    const op: 'get' | 'set' = rawArgs?.op === 'set' ? 'set' : 'get';

    if (!rawArgs.environmentId) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: 'environmentId is required to target a desktop instance.',
        },
      }, true);
    }

    let installId: string | undefined = undefined;
    try {
      installId = await resolveInstallId(context, rawArgs.environmentId);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId} does not have an active desktop connection (missing installId).`,
          },
        }, true);
      }
    } catch (err: any) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: err.message,
        },
      }, true);
    }

    const payload: AnyObject = { op };
    if (op === 'set' && rawArgs?.patch && typeof rawArgs.patch === 'object') payload.patch = rawArgs.patch;
    context?.publisher?.emit?.('log', `desktop_settings:${op} → desktop:cmd:${userId}:${installId}`);
    const reply = await requestDesktopRaw({ userId, kind: 'settings', payload, installId, timeoutMs: resolveTimeoutMs(rawArgs) });
    return rawResult(reply);
  },
};

const desktopPingTool: NativeToolDefinition = {
  description:
    "Ping a specific desktop agent environment (redAgent) to verify that it is online, actively processing commands, and measure the round-trip latency.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 10000).' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();

    if (!rawArgs.environmentId) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: 'environmentId is required to target a desktop instance.',
        },
      }, true);
    }

    let installId: string | undefined = undefined;
    try {
      installId = await resolveInstallId(context, rawArgs.environmentId);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId} does not have an active desktop connection (missing installId).`,
          },
        }, true);
      }
    } catch (err: any) {
      return textResult({
        ok: false,
        error: {
          code: 'desktop_failed',
          message: err.message,
        },
      }, true);
    }

    const start = Date.now();
    const payload: AnyObject = { op: 'get' };
    const timeoutMs = typeof rawArgs.timeoutMs === 'number' ? rawArgs.timeoutMs : 10000;

    context?.publisher?.emit?.('log', `desktop_ping → desktop:cmd:${userId}:${installId}`);
    try {
      const reply = await requestDesktopRaw({ userId, kind: 'settings', payload, installId, timeoutMs });
      const latencyMs = Date.now() - start;

      if (reply && reply.ok) {
        return textResult({
          ok: true,
          latencyMs,
          message: 'Pong! Desktop agent is online and responsive.',
          settings: reply.settings,
        });
      } else {
        return textResult({
          ok: false,
          latencyMs,
          error: reply?.error || {
            code: 'desktop_failed',
            message: 'Ping timed out or agent failed to respond.',
          },
        }, true);
      }
    } catch (err: any) {
      const latencyMs = Date.now() - start;
      return textResult({
        ok: false,
        latencyMs,
        error: {
          code: 'desktop_failed',
          message: err.message,
        },
      }, true);
    }
  },
};

export const desktopExec = desktopExecTool;
export const desktopSettings = desktopSettingsTool;
export const desktopPing = desktopPingTool;

module.exports = { desktopScreenshot: desktopScreenshotTool, desktopClick: desktopClickTool, desktopMove: desktopMoveTool, desktopType: desktopTypeTool, desktopKey: desktopKeyTool, desktopScroll: desktopScrollTool, desktopScreenInfo: desktopScreenInfoTool, desktopExec: desktopExecTool, desktopSettings: desktopSettingsTool, desktopList: desktopListTool, desktopPing: desktopPingTool };
