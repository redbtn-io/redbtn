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
 * # Zoom
 *
 * The default capture is DOWNSCALED to the click space, which grounds clicks
 * well but makes small text unreadable. `desktop_screenshot` therefore also
 * takes `region` (a rectangle in click space — the same coordinates
 * `desktop_click`/`desktop_move` use — cropped at NATIVE resolution) and
 * `fullRes` (the whole screen at native resolution). Both are passed to the
 * desktop verbatim; the desktop clamps the rect to the real display. The text
 * block echoes `region`/`fullRes` so the model knows which view it is reading.
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
import { resolveRunUserId } from './_run-identity';
import { requestDesktop, requestDesktopRaw, type ComputerAction, type ComputerResultMessage } from './desktop-request';
import { RELAY_GRACE_MS } from '../../environments/DesktopAgentSession';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * The identity these tools target — same precedence as `alert_desktop`: the
 * DELEGATED caller first (`state.callerUserId`, set by `buildInitialState` iff
 * the run executes as `executionIdentity:'caller'`), then the run owner, then
 * the legacy `state.options.userId` these tools have always accepted as a last
 * resort.
 *
 * A desktop is reached through an Environment, and environments are
 * caller-resolved under docs/RUN-AS-CALLER-DELEGATION-SPEC.md — resolving only
 * the owner sent a delegated run's desktop calls at the OWNER's machine, or
 * more often failed the environment access check outright. Undelegated runs
 * carry no `callerUserId`, so they are unchanged.
 */
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

/**
 * How long `desktop_exec` waits for the connector's reply, given the command
 * budget it is sending the connector.
 *
 * `desktop_exec` used to pass the caller's `timeoutMs` to BOTH clocks — the
 * connector's hard-kill budget (`payload.timeoutMs`) and the engine's wait for
 * the reply. Equal values race, and the engine loses often enough to matter: a
 * command that legitimately exceeded its budget came back as
 * `desktop_failed: No desktop responded within Nms` — a PRESENCE error naming a
 * connector that was present, answering, and had already captured the
 * stdout/stderr the caller never got to see. Same defect, same shape, as the
 * `DesktopAgentSession.exec` one; see `RELAY_GRACE_MS` for the margin.
 *
 * With no `timeoutMs` the caller has asked for no hard kill, so there is no
 * second clock to clear and the relay keeps its own presence-detector default.
 */
function resolveExecRelayTimeoutMs(args: AnyObject): number | undefined {
  const budget = resolveTimeoutMs(args);
  return budget === undefined ? undefined : budget + RELAY_GRACE_MS;
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

/** A screenshot crop rectangle in CLICK SPACE (the coordinate space clicks use). */
type ScreenshotRegion = { x: number; y: number; w: number; h: number };

/**
 * Optional crop rectangle, or null when explicitly invalid.
 *
 * Types only — NO clamping here. The desktop owns the clamp (`computerUse.ts`
 * maps click space → native pixels and clamps with Math.max/Math.min against
 * the real display), and a second, engine-side clamp against dimensions we do
 * not know would silently move the crop away from what the model asked for.
 */
function resolveRegion(args: AnyObject): ScreenshotRegion | undefined | null {
  const raw = args?.region;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { x, y, w, h } = raw as AnyObject;
  const offset = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const extent = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 1;
  if (!offset(x) || !offset(y) || !extent(w) || !extent(h)) return null;
  return { x, y, w, h };
}

function invalidRegionResult(): NativeMcpResult {
  return textResult({
    ok: false,
    error: {
      code: 'computer_failed',
      message:
        'region must be { x, y, w, h } integers in click space with x >= 0, y >= 0, w >= 1, h >= 1',
    },
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
 * Resolve target desktop installId from either environmentId OR machine name / prefix / installId.
 */
async function resolveTargetInstallId(context: NativeToolContext, args: AnyObject): Promise<string | undefined> {
  const target = args?.environmentId || args?.machine;
  if (!target) {
    throw new Error('environmentId is required to target a desktop instance.');
  }
  const userId = resolveUserId(context);
  if (!userId) return undefined;

  // 1. If explicit environmentId was provided, resolve via loadAndResolveEnvironment
  if (args.environmentId) {
    try {
      const { env } = await loadAndResolveEnvironment(args.environmentId, userId);
      return env.installId;
    } catch (err) {
      if (!args.machine) {
        throw new Error(`Failed to resolve environment ${args.environmentId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 2. If target is a machine name/prefix/installId:
  const q = String(args.machine || args.environmentId).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) {
    return q;
  }

  try {
    const mongoose = await import('mongoose');
    const conn = mongoose.connection;
    if (conn?.db) {
      const envCol = conn.db.collection('environments');
      const docs = await envCol.find({
        userId,
        kind: 'desktop-agent',
        $or: [
          { environmentId: q },
          { installId: q },
          { installId: { $regex: `^${q}`, $options: 'i' } },
          { name: { $regex: q, $options: 'i' } },
        ],
      }).toArray();

      if (docs.length === 1 && docs[0].installId) {
        return docs[0].installId;
      }
      if (docs.length > 1) {
        const matches = docs.map((d: any) => `${d.name || '(unnamed)'} [${d.installId?.slice(0, 8)}]`).join(', ');
        throw new Error(`"${q}" matches multiple desktop environments: ${matches}`);
      }
    }
  } catch (err: any) {
    if (err.message && err.message.includes('matches multiple')) {
      throw err;
    }
  }

  try {
    const { env } = await loadAndResolveEnvironment(q, userId);
    return env.installId;
  } catch {
    return q;
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
  marginMs = 0,
): Promise<ComputerResultMessage | null> {
  const userId = resolveUserId(context);
  if (!userId) return null;

  if (!args.environmentId && !args.machine) {
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
    installId = await resolveTargetInstallId(context, args);
    if (!installId) {
      return {
        kind: 'computer_result',
        id: '',
        ok: false,
        error: {
          code: 'computer_failed',
          message: `Target environment ${args.environmentId || args.machine} does not have an active desktop connection (missing installId).`,
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
  const baseTimeout = resolveTimeoutMs(args);
  const timeoutMs = baseTimeout !== undefined ? baseTimeout + marginMs : (marginMs > 0 ? 10000 + marginMs : undefined);
  return requestDesktop({ userId, request, installId, timeoutMs });
}

// ─── desktop_screenshot ──────────────────────────────────────────────────────

const desktopScreenshotTool: NativeToolDefinition = {
  description:
    "Capture a screenshot of the current user's connected desktop (redAgent) and return it as an image the model can see, plus geometry. YOU CAN ZOOM: pass `region` to get a native-resolution crop of part of the screen (use it whenever text or detail is too small to read in the default view), or `fullRes` for the whole screen at native resolution. Round-trips over Redis to the /ws/desktop gateway; fails safe with a computer_failed error if no desktop is connected.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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
      region: {
        type: 'object',
        description:
          'Zoom in on part of the screen to read small text or detail. Coordinates are in the SAME CLICK SPACE that desktop_click / desktop_move use (the dimensions reported as `clickSpace` by a default screenshot) — NOT native pixels. The desktop crops that rectangle at NATIVE resolution, so the crop is sharper than the default downscaled view. A region that is off-screen or too large is clamped to the display by the desktop, so it never fails for being out of bounds. Omit for the normal full-screen overview.',
        properties: {
          x: { type: 'integer', minimum: 0, description: 'Left edge in click space.' },
          y: { type: 'integer', minimum: 0, description: 'Top edge in click space.' },
          w: { type: 'integer', minimum: 1, description: 'Width in click space.' },
          h: { type: 'integer', minimum: 1, description: 'Height in click space.' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      fullRes: {
        type: 'boolean',
        description:
          'Return the WHOLE screen at full native resolution instead of the default click-space downscale. The image is large and costly — prefer `region` when you only need to read one part of the screen. Ignored when `region` is set. Default false.',
        default: false,
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
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const fullRes = rawArgs?.fullRes === true;
    const request: ComputerAction = { action: 'screenshot', format };
    if (display !== undefined) request.display = display;
    // Passed through verbatim; the desktop clamps the rect (computerUse.ts).
    if (region !== undefined) request.region = region;
    if (fullRes) request.fullRes = true;
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
            // What am I looking at? — echoed so the model can tell a zoomed
            // crop from the default overview without guessing from dimensions.
            region: region ?? null,
            fullRes: region === undefined ? fullRes : false,
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
    "Click the mouse in the CLICK SPACE reported by desktop_screenshot on the current user's connected desktop (redAgent). Supports display targeting, left/right/middle button, double-click, and smooth movement.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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
      smooth: { type: 'boolean', description: 'Move the cursor smoothly to coordinates before clicking. Default false.' },
      speed: { type: 'string', enum: ['normal', 'fast', 'instant'], description: 'Movement speed preset. Default normal.' },
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
    if (rawArgs?.smooth === true) request.smooth = true;
    if (rawArgs?.speed !== undefined) request.speed = rawArgs.speed;
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
    "Move the mouse pointer in the CLICK SPACE reported by desktop_screenshot on the current user's connected desktop (redAgent). Supports absolute or relative moves, virtual-hid or injected transport, smooth interpolation, and speed presets.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      x: { type: 'number', description: 'Absolute X pixel coordinate in click space.' },
      y: { type: 'number', description: 'Absolute Y pixel coordinate in click space.' },
      relative: { type: 'boolean', description: 'Relative movement if true. Default false.' },
      dx: { type: 'number', description: 'Relative horizontal delta in pixels (for relative moves).' },
      dy: { type: 'number', description: 'Relative vertical delta in pixels (for relative moves).' },
      transport: { type: 'string', enum: ['injected', 'virtual-hid'], description: 'Transport to use ("injected" or "virtual-hid").' },
      smooth: { type: 'boolean', description: 'Smooth movement interpolation. Default true for absolute moves.' },
      speed: { type: 'string', enum: ['normal', 'fast', 'instant'], description: 'Movement speed preset. Default normal.' },
      durationMs: { type: 'integer', description: 'Movement duration in ms.' },
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
    const relative = rawArgs?.relative === true;
    const x = Number(rawArgs?.x);
    const y = Number(rawArgs?.y);
    const dx = Number(rawArgs?.dx);
    const dy = Number(rawArgs?.dy);

    if (relative) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        return textResult({ ok: false, error: { code: 'computer_failed', message: 'relative move requires finite dx and dy' } }, true);
      }
    } else {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return textResult({ ok: false, error: { code: 'computer_failed', message: 'x and y must be finite numbers' } }, true);
      }
    }

    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const request: ComputerAction = {
      action: 'mouse',
      op: 'move',
      x: Number.isFinite(x) ? x : undefined,
      y: Number.isFinite(y) ? y : undefined,
    };
    if (relative) {
      request.relative = true;
      if (Number.isFinite(dx)) request.dx = dx;
      if (Number.isFinite(dy)) request.dy = dy;
    }
    if (rawArgs?.transport !== undefined) request.transport = rawArgs.transport;
    if (rawArgs?.smooth !== undefined) request.smooth = rawArgs.smooth;
    if (rawArgs?.speed !== undefined) request.speed = rawArgs.speed;
    if (rawArgs?.durationMs !== undefined) request.durationMs = rawArgs.durationMs;
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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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
    "Tap a key or key-chord (e.g. ['ctrl','c'], ['enter'], ['alt','tab']) on the current user's connected desktop (redAgent). Supports opMode: tap (default), down (hold), or up (release), and hold durationMs.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: "Key names forming a chord, e.g. ['ctrl','c'] or ['enter']. Required, non-empty.",
      },
      opMode: {
        type: 'string',
        enum: ['tap', 'down', 'up'],
        description: 'Key operation: "tap" (default), "down" (press and hold), or "up" (release hold)',
      },
      durationMs: {
        type: 'integer',
        description: 'Hold duration in milliseconds before release (when opMode is "tap")',
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
    const opMode = rawArgs?.opMode;
    const request: ComputerAction = {
      action: 'keyboard',
      op: opMode === 'down' ? 'down' : opMode === 'up' ? 'up' : 'tap',
      keys,
    };
    if (opMode !== undefined) request.opMode = opMode;
    if (typeof rawArgs?.durationMs === 'number') request.durationMs = rawArgs.durationMs;
    const result = await runAction(context, request, rawArgs);
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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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

// ─── desktop_read_text ───────────────────────────────────────────────────────

const desktopReadTextTool: NativeToolDefinition = {
  description:
    'Read on-screen text using on-device OCR (Windows.Media.Ocr / macOS Vision). Returns detected lines and words with bounding boxes in CLICK SPACE coords.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Crop region in click-space coords.',
        properties: {
          x: { type: 'number', description: 'Left edge in click space.' },
          y: { type: 'number', description: 'Top edge in click space.' },
          w: { type: 'number', description: 'Width in click space.' },
          h: { type: 'number', description: 'Height in click space.' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      imageBase64: {
        type: 'string',
        description: 'Base64-encoded image to read (offline / testing).',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = { action: 'ocr', op: 'read' };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;
    if (typeof rawArgs?.imageBase64 === 'string') request.imageBase64 = rawArgs.imageBase64;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    if (!result.ok) {
      return textResult({
        ok: false,
        error: result.error || { code: 'computer_failed', message: 'read_text failed' },
      }, true);
    }
    const ocr = result.ocr || {};
    return textResult({
      ok: true,
      text: ocr.text || (result.result as any)?.text || '',
      lines: ocr.lines || (result.result as any)?.lines || [],
      words: ocr.words || (result.result as any)?.words || [],
      clickSpace: result.clickSpace || (result.result as any)?.clickSpace || ocr.clickSpace,
      display: display ?? 0,
      region: region ?? null,
    });
  },
};

// ─── desktop_find_text ───────────────────────────────────────────────────────

const desktopFindTextTool: NativeToolDefinition = {
  description:
    'Find text on screen using on-device OCR. Returns matching occurrences with bounding boxes and click-center coordinates in CLICK SPACE.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      text: { type: 'string', description: 'Text substring to find.' },
      regex: { type: 'string', description: 'Regular expression pattern to find.' },
      caseSensitive: { type: 'boolean', description: 'Case-sensitive search (default: false).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Crop region in click-space coords.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      imageBase64: {
        type: 'string',
        description: 'Base64-encoded image to read (offline / testing).',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text : undefined;
    const regex = typeof rawArgs?.regex === 'string' ? rawArgs.regex : undefined;
    if (!text && !regex) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'find_text requires text or regex' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = {
      action: 'ocr',
      op: 'find',
      text,
      regex,
      caseSensitive: rawArgs?.caseSensitive === true,
    };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;
    if (typeof rawArgs?.imageBase64 === 'string') request.imageBase64 = rawArgs.imageBase64;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    if (!result.ok) {
      return textResult({
        ok: false,
        error: result.error || { code: 'computer_failed', message: 'find_text failed' },
      }, true);
    }
    const matches = result.ocr?.matches || (result.result as any)?.matches || [];
    return textResult({
      ok: true,
      query: { text, regex },
      matches,
      clickSpace: result.clickSpace || (result.result as any)?.clickSpace || result.ocr?.clickSpace,
      display: display ?? 0,
      region: region ?? null,
    });
  },
};

// ─── desktop_click_text ──────────────────────────────────────────────────────

const desktopClickTextTool: NativeToolDefinition = {
  description:
    'Find text on screen using OCR and click it. Solves UI automation without hardcoded pixel coordinates.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      text: { type: 'string', description: 'Text substring to find and click.' },
      regex: { type: 'string', description: 'Regular expression pattern to find and click.' },
      occurrence: { description: 'Which occurrence to click: 1-based index, "first", or "last" (default: 1).' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default: left).' },
      double: { type: 'boolean', description: 'Double-click (default: false).' },
      offset: {
        type: 'object',
        description: 'Pixel offset {x, y} from match click-center in click-space coordinates.',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
      },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Crop region in click-space coords.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text : undefined;
    const regex = typeof rawArgs?.regex === 'string' ? rawArgs.regex : undefined;
    if (!text && !regex) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'click_text requires text or regex' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = {
      action: 'ocr',
      op: 'click',
      text,
      regex,
      occurrence: rawArgs?.occurrence,
      button: rawArgs?.button === 'right' ? 'right' : rawArgs?.button === 'middle' ? 'middle' : 'left',
      double: rawArgs?.double === true,
      offset: rawArgs?.offset,
    };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_find_image ──────────────────────────────────────────────────────

const desktopFindImageTool: NativeToolDefinition = {
  description:
    'Find a template image on screen using pure TypeScript template matching (NCC). Returns matching occurrences with bounding boxes and click-center coordinates in CLICK SPACE.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      template: { type: 'string', description: 'Base64-encoded PNG/JPEG template image to find.' },
      image: { type: 'string', description: 'Alias for template (base64-encoded PNG/JPEG).' },
      threshold: { type: 'number', minimum: 0, maximum: 1, description: 'Similarity threshold 0.0–1.0 (default 0.8).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Crop region in click-space coords.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const template = typeof rawArgs?.template === 'string' ? rawArgs.template : (typeof rawArgs?.image === 'string' ? rawArgs.image : '');
    if (!template) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'template (base64 image) is required' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = {
      action: 'find_image',
      template,
      threshold: typeof rawArgs?.threshold === 'number' ? rawArgs.threshold : undefined,
    };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    if (!result.ok) {
      return textResult({
        ok: false,
        error: result.error || { code: 'computer_failed', message: 'find_image failed' },
      }, true);
    }
    const matches = result.matches || (result.result as any)?.matches || [];
    return textResult({
      ok: true,
      matches,
      clickSpace: result.clickSpace || (result.result as any)?.clickSpace,
      display: display ?? 0,
      region: region ?? null,
    });
  },
};

// ─── desktop_wait_for ────────────────────────────────────────────────────────

const desktopWaitForTool: NativeToolDefinition = {
  description:
    'Poll until text or an image template appears on screen (or disappears, with gone: true). When timeout occurs, returns error evidence screenshot crop.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      text: { type: 'string', description: 'Text substring to wait for.' },
      regex: { type: 'string', description: 'Regular expression to wait for.' },
      template: { type: 'string', description: 'Base64 image template to wait for.' },
      image: { type: 'string', description: 'Alias for template (base64 image).' },
      gone: { type: 'boolean', description: 'If true, wait for the target to DISAPPEAR. Default false.' },
      timeoutMs: { type: 'integer', description: 'Max wait time in ms (default 10000, max 60000).' },
      intervalMs: { type: 'integer', description: 'Poll interval in ms (default 250).' },
      threshold: { type: 'number', description: 'Image match threshold 0.0–1.0 (default 0.8).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Crop region in click-space coords.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const text = typeof rawArgs?.text === 'string' ? rawArgs.text : undefined;
    const regex = typeof rawArgs?.regex === 'string' ? rawArgs.regex : undefined;
    const template = typeof rawArgs?.template === 'string' ? rawArgs.template : (typeof rawArgs?.image === 'string' ? rawArgs.image : undefined);
    if (!text && !regex && !template) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'wait_for requires text, regex, or template' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = {
      action: 'wait_for',
      text,
      regex,
      template,
      gone: rawArgs?.gone === true,
      timeoutMs: typeof rawArgs?.timeoutMs === 'number' ? rawArgs.timeoutMs : undefined,
      intervalMs: typeof rawArgs?.intervalMs === 'number' ? rawArgs.intervalMs : undefined,
      threshold: typeof rawArgs?.threshold === 'number' ? rawArgs.threshold : undefined,
    };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;

    // Add 5000ms margin to Redis relay timeout so desktop connector can finish and return evidence
    const result = await runAction(context, request, rawArgs, 5000);
    if (!result) return noUserResult();

    const content: Array<Record<string, unknown>> = [];
    const evidence = (result.result as any)?.evidence || (result.error as any)?.evidence;
    if (evidence?.imageBase64 || evidence?.base64) {
      const data = evidence.imageBase64 || evidence.base64;
      const mime = evidence.format ? `image/${evidence.format}` : 'image/png';
      content.push({ type: 'image', data, mimeType: mime });
    }
    content.push({
      type: 'text',
      text: JSON.stringify({
        ok: result.ok,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      }),
    });
    return {
      content: content as any,
      ...(result.ok !== true ? { isError: true } : {}),
    };
  },
};

// ─── desktop_hover ───────────────────────────────────────────────────────────

const desktopHoverTool: NativeToolDefinition = {
  description:
    'Hover the mouse at coordinates with an optional dwell time (default 300ms) and micro-wiggle (1px) to trigger tooltip/hover effects. Optionally captures a screenshot of the region.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      x: { type: 'number', description: 'X coordinate in click space. Required.' },
      y: { type: 'number', description: 'Y coordinate in click space. Required.' },
      dwellMs: { type: 'integer', description: 'Dwell time in ms (default 300).' },
      wiggle: { type: 'boolean', description: 'Perform 1px wiggle to trigger hover handlers (default true).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      region: {
        type: 'object',
        description: 'Optional crop region in click space to screenshot after dwelling.',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          w: { type: 'number' },
          h: { type: 'number' },
        },
        required: ['x', 'y', 'w', 'h'],
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
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
    const region = resolveRegion(rawArgs);
    if (region === null) return invalidRegionResult();
    const request: ComputerAction = {
      action: 'mouse',
      op: 'hover',
      x,
      y,
      dwellMs: typeof rawArgs?.dwellMs === 'number' ? rawArgs.dwellMs : undefined,
      wiggle: rawArgs?.wiggle !== false,
    };
    if (display !== undefined) request.display = display;
    if (region !== undefined) request.region = region;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();

    const failure = inputFailure(result);
    const content: Array<Record<string, unknown>> = [];
    const evidence = (result.result as any)?.screenshot || (result.result as any)?.evidence || (result.result as any)?.image;
    if (evidence?.base64 || evidence?.imageBase64) {
      const data = evidence.base64 || evidence.imageBase64;
      const mime = evidence.format ? `image/${evidence.format}` : 'image/png';
      content.push({ type: 'image', data, mimeType: mime });
    }
    content.push({
      type: 'text',
      text: JSON.stringify({
        ok: failure === null,
        ...(result.result ? { result: result.result } : {}),
        ...(failure ? { error: failure } : {}),
      }),
    });
    return {
      content: content as any,
      ...(failure !== null ? { isError: true } : {}),
    };
  },
};

// ─── desktop_drag ────────────────────────────────────────────────────────────

const desktopDragTool: NativeToolDefinition = {
  description:
    'Drag from one position to another in click space. If `from` is omitted, drags from the current mouse position. Returns { ok, result }.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      to: {
        type: 'object',
        description: 'Destination coordinates in click space. Required.',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
      },
      from: {
        type: 'object',
        description: 'Source starting coordinates in click space (omitted = current position).',
        properties: { x: { type: 'number' }, y: { type: 'number' } },
        required: ['x', 'y'],
      },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button to hold (default: left).' },
      durationMs: { type: 'integer', description: 'Drag duration in ms (default 500).' },
      smooth: { type: 'boolean', description: 'Smooth movement along bezier path (default true).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId', 'to'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    if (!rawArgs?.to || typeof rawArgs.to !== 'object' || !Number.isFinite(Number(rawArgs.to.x)) || !Number.isFinite(Number(rawArgs.to.y))) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'to {x, y} is required and must be finite numbers' } }, true);
    }
    const to = { x: Number(rawArgs.to.x), y: Number(rawArgs.to.y) };
    let from: { x: number; y: number } | undefined = undefined;
    if (rawArgs?.from && typeof rawArgs.from === 'object' && Number.isFinite(Number(rawArgs.from.x)) && Number.isFinite(Number(rawArgs.from.y))) {
      from = { x: Number(rawArgs.from.x), y: Number(rawArgs.from.y) };
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();

    const request: ComputerAction = {
      action: 'mouse',
      op: 'drag',
      to,
      from,
      button: rawArgs?.button === 'right' ? 'right' : rawArgs?.button === 'middle' ? 'middle' : 'left',
      durationMs: typeof rawArgs?.durationMs === 'number' ? rawArgs.durationMs : undefined,
      smooth: rawArgs?.smooth !== false,
    };
    if (display !== undefined) request.display = display;

    const result = await runAction(context, request, rawArgs);
    if (!result) return noUserResult();
    return inputResult(result);
  },
};

// ─── desktop_batch ───────────────────────────────────────────────────────────

const desktopBatchTool: NativeToolDefinition = {
  description:
    'Execute an atomic batch of input actions and perceptual checkpoints in sequence. Returns array of step results. If any step fails and abortOnError is true (default), execution stops.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      steps: {
        type: 'array',
        description: 'Sequence of batch steps to execute in order. Required, non-empty.',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: [
                'click',
                'click_text',
                'key',
                'type',
                'move',
                'hover',
                'drag',
                'scroll',
                'wait',
                'wait_for',
                'assert_text',
                'screenshot',
              ],
            },
            label: { type: 'string', description: 'Optional step label for diagnostics.' },
          },
          required: ['op'],
        },
      },
      abortOnError: { type: 'boolean', description: 'Stop execution immediately on first step failure (default true).' },
      display: {
        type: 'integer',
        minimum: 0,
        description: 'Display index from desktop_screen_info / desktop_screenshot. Omitted means primary.',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms.' },
    },
    required: ['environmentId', 'steps'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const steps = Array.isArray(rawArgs?.steps) ? rawArgs.steps : [];
    if (steps.length === 0) {
      return textResult({ ok: false, error: { code: 'computer_failed', message: 'steps must be a non-empty array' } }, true);
    }
    const display = resolveDisplayIndex(rawArgs);
    if (display === null) return invalidDisplayResult();

    const request: ComputerAction = {
      action: 'batch',
      steps,
      stopOnFail: rawArgs?.abortOnError !== false,
      abortOnError: rawArgs?.abortOnError !== false,
    };

    // Batch duration cap on connector is 120s; set relay timeout margin to 125s (125000ms)
    const result = await runAction(context, request, rawArgs, 125000);
    if (!result) return noUserResult();

    const content: Array<Record<string, unknown>> = [];
    const stepResults = (result.result as any)?.results;
    if (Array.isArray(stepResults)) {
      for (let i = 0; i < stepResults.length; i++) {
        const s = stepResults[i];
        const res = (s as any)?.result || (s as any);
        const evidence = res?.evidence || res?.image || res?.screenshot;
        if (evidence?.base64 || evidence?.imageBase64) {
          const data = evidence.base64 || evidence.imageBase64;
          const mime = evidence.format ? `image/${evidence.format}` : 'image/png';
          content.push({ type: 'image', data, mimeType: mime });
        }
      }
    }
    content.push({
      type: 'text',
      text: JSON.stringify({
        ok: result.ok,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      }),
    });
    return {
      content: content as any,
      ...(result.ok !== true ? { isError: true } : {}),
    };
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
export const desktopList = desktopListTool;
export const desktopReadText = desktopReadTextTool;
export const desktopFindText = desktopFindTextTool;
export const desktopClickText = desktopClickTextTool;
export const desktopFindImage = desktopFindImageTool;
export const desktopWaitFor = desktopWaitForTool;
export const desktopHover = desktopHoverTool;
export const desktopDrag = desktopDragTool;
export const desktopBatch = desktopBatchTool;

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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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

    if (!rawArgs.environmentId && !rawArgs.machine) {
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
      installId = await resolveTargetInstallId(context, rawArgs);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId || rawArgs.machine} does not have an active desktop connection (missing installId).`,
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
    // Relay wait STRICTLY outlasts payload.timeoutMs — see resolveExecRelayTimeoutMs.
    const reply = await requestDesktopRaw({ userId, kind: 'exec', payload, installId, timeoutMs: resolveExecRelayTimeoutMs(rawArgs) });
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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
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

    if (!rawArgs.environmentId && !rawArgs.machine) {
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
      installId = await resolveTargetInstallId(context, rawArgs);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId || rawArgs.machine} does not have an active desktop connection (missing installId).`,
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
      machine: {
        type: 'string',
        description: 'Target computer: installId, id prefix, or part of its name (e.g. "mac", "alphaSystem").',
      },
      timeoutMs: { type: 'number', description: 'Optional round-trip timeout in ms (default 10000).' },
    },
    required: ['environmentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const userId = resolveUserId(context);
    if (!userId) return noUserResult();

    if (!rawArgs.environmentId && !rawArgs.machine) {
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
      installId = await resolveTargetInstallId(context, rawArgs);
      if (!installId) {
        return textResult({
          ok: false,
          error: {
            code: 'desktop_failed',
            message: `Target environment ${rawArgs.environmentId || rawArgs.machine} does not have an active desktop connection (missing installId).`,
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

(module as any).exports = {
  desktopScreenshot: desktopScreenshotTool,
  desktopClick: desktopClickTool,
  desktopMove: desktopMoveTool,
  desktopType: desktopTypeTool,
  desktopKey: desktopKeyTool,
  desktopScroll: desktopScrollTool,
  desktopScreenInfo: desktopScreenInfoTool,
  desktopExec: desktopExecTool,
  desktopSettings: desktopSettingsTool,
  desktopList: desktopListTool,
  desktopPing: desktopPingTool,
  desktopReadText: desktopReadTextTool,
  desktopFindText: desktopFindTextTool,
  desktopClickText: desktopClickTextTool,
  desktopFindImage: desktopFindImageTool,
  desktopWaitFor: desktopWaitForTool,
  desktopHover: desktopHoverTool,
  desktopDrag: desktopDragTool,
  desktopBatch: desktopBatchTool,
};
