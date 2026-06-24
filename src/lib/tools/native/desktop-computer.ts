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
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { requestDesktop } = require('./desktop-request.js') as typeof import('./desktop-request');
import type { ComputerAction, ComputerResultMessage } from './desktop-request';

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
  });
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
  context?.publisher?.emit?.('log', `desktop_${request.action} → desktop:cmd:${userId}`);
  return requestDesktop({ userId, request, timeoutMs: resolveTimeoutMs(args) });
}

// ─── desktop_screenshot ──────────────────────────────────────────────────────

const desktopScreenshotTool: NativeToolDefinition = {
  description:
    "Capture a screenshot of the current user's connected desktop (redAgent) and return it as an image the model can see, plus geometry. Round-trips over Redis to the /ws/desktop gateway; fails safe with a computer_failed error if no desktop is connected.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['png', 'jpeg'],
        description: 'Image encoding. Default png.',
        default: 'png',
      },
      timeoutMs: {
        type: 'number',
        description: 'Optional round-trip timeout in ms (default 30000).',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const format: 'png' | 'jpeg' = rawArgs?.format === 'jpeg' ? 'jpeg' : 'png';
    const result = await runAction(context, { action: 'screenshot', format }, rawArgs);
    if (!result) return noUserResult();

    if (!result.ok || !result.image) {
      return textResult({
        ok: false,
        error: result.error || { code: 'computer_failed', message: 'screenshot failed (no image returned)' },
      });
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
    "Click the mouse at absolute virtual-desktop pixel coordinates on the current user's connected desktop (redAgent). Supports left/right/middle button and double-click.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Absolute X pixel coordinate. Required.' },
      y: { type: 'number', description: 'Absolute Y pixel coordinate. Required.' },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'Mouse button. Default left.',
        default: 'left',
      },
      double: { type: 'boolean', description: 'Perform a double-click. Default false.' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['x', 'y'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const x = Number(rawArgs?.x);
    const y = Number(rawArgs?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'x and y must be finite numbers' } }, true);
    }
    const button: 'left' | 'right' | 'middle' =
      rawArgs?.button === 'right' ? 'right' : rawArgs?.button === 'middle' ? 'middle' : 'left';
    const result = await runAction(
      context,
      { action: 'mouse', op: 'click', x, y, button, double: rawArgs?.double === true },
      rawArgs,
    );
    if (!result) return noUserResult();
    return textResult({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  },
};

// ─── desktop_move ────────────────────────────────────────────────────────────

const desktopMoveTool: NativeToolDefinition = {
  description:
    "Move the mouse pointer (without clicking) to absolute virtual-desktop pixel coordinates on the current user's connected desktop (redAgent).",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      x: { type: 'number', description: 'Absolute X pixel coordinate. Required.' },
      y: { type: 'number', description: 'Absolute Y pixel coordinate. Required.' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['x', 'y'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const x = Number(rawArgs?.x);
    const y = Number(rawArgs?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'x and y must be finite numbers' } }, true);
    }
    const result = await runAction(context, { action: 'mouse', op: 'move', x, y }, rawArgs);
    if (!result) return noUserResult();
    return textResult({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  },
};

// ─── desktop_type ────────────────────────────────────────────────────────────

const desktopTypeTool: NativeToolDefinition = {
  description:
    "Type literal text into whatever currently has keyboard focus on the current user's connected desktop (redAgent).",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Literal text to type. Required.' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['text'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text : '';
    if (!text) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'text is required' } }, true);
    }
    const result = await runAction(context, { action: 'keyboard', op: 'type', text }, rawArgs);
    if (!result) return noUserResult();
    return textResult({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  },
};

// ─── desktop_key ─────────────────────────────────────────────────────────────

const desktopKeyTool: NativeToolDefinition = {
  description:
    "Tap a key or key-chord (e.g. ['ctrl','c'], ['enter'], ['alt','tab']) on the current user's connected desktop (redAgent). Keys are pressed together as a chord.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: "Key names forming a chord, e.g. ['ctrl','c'] or ['enter']. Required, non-empty.",
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: ['keys'],
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
    return textResult({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
  },
};

// ─── desktop_scroll ──────────────────────────────────────────────────────────

const desktopScrollTool: NativeToolDefinition = {
  description:
    "Scroll the mouse wheel on the current user's connected desktop (redAgent). Positive dy scrolls down, positive dx scrolls right.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      dx: { type: 'number', description: 'Horizontal wheel delta (positive = right). Default 0.' },
      dy: { type: 'number', description: 'Vertical wheel delta (positive = down). Default 0.' },
      x: { type: 'number', description: 'Optional pointer X to scroll at (absolute pixels).' },
      y: { type: 'number', description: 'Optional pointer Y to scroll at (absolute pixels).' },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const dx = Number.isFinite(Number(rawArgs?.dx)) ? Number(rawArgs.dx) : 0;
    const dy = Number.isFinite(Number(rawArgs?.dy)) ? Number(rawArgs.dy) : 0;
    const req: ComputerAction = { action: 'mouse', op: 'scroll', dx, dy };
    if (Number.isFinite(Number(rawArgs?.x))) req.x = Number(rawArgs.x);
    if (Number.isFinite(Number(rawArgs?.y))) req.y = Number(rawArgs.y);
    const result = await runAction(context, req, rawArgs);
    if (!result) return noUserResult();
    return textResult({ ok: result.ok, ...(result.error ? { error: result.error } : {}) });
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
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 30000).' },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const result = await runAction(context, { action: 'screen_info' }, rawArgs);
    if (!result) return noUserResult();
    return textResult({
      ok: result.ok,
      ...(result.screen ? { displays: result.screen.displays } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  },
};

// ─── Exports ─────────────────────────────────────────────────────────────────

export const desktopScreenshot = desktopScreenshotTool;
export const desktopClick = desktopClickTool;
export const desktopMove = desktopMoveTool;
export const desktopType = desktopTypeTool;
export const desktopKey = desktopKeyTool;
export const desktopScroll = desktopScrollTool;
export const desktopScreenInfo = desktopScreenInfoTool;

module.exports = {
  desktopScreenshot: desktopScreenshotTool,
  desktopClick: desktopClickTool,
  desktopMove: desktopMoveTool,
  desktopType: desktopTypeTool,
  desktopKey: desktopKeyTool,
  desktopScroll: desktopScrollTool,
  desktopScreenInfo: desktopScreenInfoTool,
};
