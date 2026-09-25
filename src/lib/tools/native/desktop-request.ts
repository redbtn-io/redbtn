/**
 * desktop-request — internal request/reply helper for the "computer use" tools.
 *
 * Where `alert_desktop` is fire-and-forget, computer-use needs a full
 * REQUEST → REPLY round-trip: a graph asks the desktop to take a screenshot /
 * click / type, and must wait for the desktop's `computer_result` before the
 * agent can decide the next move.
 *
 * # Transport contract (must match the webapp desktop-gateway + redAgent)
 *
 *   Request channel `desktop:cmd:{userId}:{installId}`
 *     The tool PUBLISHes the full protocol message
 *       { "kind":"computer", "id":"<uuid>", "request": <ComputerAction> }
 *     here. The gateway socket for that installId relays it verbatim down that
 *     desktop connection.
 *
 *   Reply channel `desktop:reply:{id}`  (keyed by the request's `id`)
 *     When the desktop sends a `computer_result` (or `exec_result`/`ack`) up
 *     the socket, the gateway PUBLISHes that message JSON here. This helper,
 *     subscribed to `desktop:reply:{id}` BEFORE it publishes the command,
 *     receives the first such message and resolves.
 *
 * # Targeting
 *
 * Callers must resolve an Environment `environmentId` to the desktop
 * connector's `installId` before calling this helper. The helper refuses to
 * publish without an installId, so computer-use/exec/settings cannot silently
 * fall back to user-wide broadcast.
 *
 * # Fail-safe
 *
 * EVERYTHING is wrapped so a transport failure NEVER throws into the run:
 *   - no desktop connected            → immediate `{ ok:false, error:{ code:'computer_failed' } }`
 *     (presence is checked via SCAN first, so we don't burn the full timeout)
 *   - timeout                         → `{ ok:false, error:{ code:'computer_failed', message:'timed out' } }`
 *   - any other error                 → `{ ok:false, error:{ code:'computer_failed', message } }`
 * Both Redis connections (publisher + dedicated subscriber) are torn down in a
 * `finally`.
 *
 * Environment:
 *   REDIS_URL — Redis connection (default redis://localhost:6379)
 */

import { randomUUID } from 'crypto';
import Redis from 'ioredis';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export type WindowTarget = string | { id: string | number };
export type ClickRegion = { x: number; y: number; w: number; h: number };
export type NormalizedRegion = { nx: number; ny: number; nw: number; nh: number };

export type BatchStep =
  | { op: 'click'; x?: number; y?: number; nx?: number; ny?: number; display?: number; window?: WindowTarget; bringToFront?: boolean; button?: 'left' | 'right' | 'middle'; double?: boolean; smooth?: boolean; speed?: 'normal' | 'fast' | 'instant'; region?: ClickRegion | NormalizedRegion; screenshot?: boolean; size?: { w: number; h: number }; label?: string }
  | { op: 'click_text'; text?: string; regex?: string; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; occurrence?: number | 'first' | 'last'; button?: 'left' | 'right' | 'middle'; double?: boolean; offset?: { x: number; y: number }; display?: number; screenshot?: boolean; size?: { w: number; h: number }; label?: string }
  | { op: 'key'; keys: string[]; durationMs?: number; opMode?: 'tap' | 'down' | 'up'; opKind?: 'tap' | 'down' | 'up'; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; label?: string }
  | { op: 'type'; text: string; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; label?: string }
  | { op: 'move'; x?: number; y?: number; nx?: number; ny?: number; display?: number; window?: WindowTarget; bringToFront?: boolean; dx?: number; dy?: number; relative?: boolean; transport?: 'injected' | 'virtual-hid'; smooth?: boolean; speed?: 'normal' | 'fast' | 'instant'; region?: ClickRegion | NormalizedRegion; label?: string }
  | { op: 'hover'; x: number; y: number; nx?: number; ny?: number; display?: number; window?: WindowTarget; bringToFront?: boolean; dwellMs?: number; wiggle?: boolean; screenshot?: boolean; region?: ClickRegion | NormalizedRegion; size?: { w: number; h: number }; label?: string }
  | { op: 'drag'; from?: { x?: number; y?: number; nx?: number; ny?: number }; to: { x?: number; y?: number; nx?: number; ny?: number }; display?: number; window?: WindowTarget; bringToFront?: boolean; button?: 'left' | 'right' | 'middle'; durationMs?: number; smooth?: boolean; region?: ClickRegion | NormalizedRegion; screenshot?: boolean; size?: { w: number; h: number }; label?: string }
  | { op: 'scroll'; dx?: number; dy?: number; x?: number; y?: number; nx?: number; ny?: number; display?: number; window?: WindowTarget; bringToFront?: boolean; region?: ClickRegion | NormalizedRegion; label?: string }
  | { op: 'wait'; ms?: number; durationMs?: number; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; label?: string }
  | { op: 'wait_for'; text?: string; regex?: string; template?: string; image?: string; gone?: boolean; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; display?: number; timeoutMs?: number; intervalMs?: number; threshold?: number; label?: string }
  | { op: 'assert_text'; text?: string; regex?: string; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; display?: number; label?: string }
  | { op: 'screenshot'; region?: ClickRegion | NormalizedRegion; window?: WindowTarget; bringToFront?: boolean; around?: { x: number; y: number } | 'cursor'; size?: { w: number; h: number }; display?: number; format?: 'png' | 'jpeg'; label?: string };

/**
 * Computer-use action — discriminated union mirroring redAgent
 * `src/shared/protocol.ts` `ComputerAction` EXACTLY.
 */
export type ComputerAction =
  /**
    Capture the screen.
   *  - default: DOWNSCALED to the click space (~1366px long edge) — good
   *    grounding, but small text is unreadable.
   *  - `region` (CLICK SPACE coords): native-resolution crop of that area —
   *    the "zoom in" path. The desktop clamps the rect to the display.
   *  - `around`: crop centered on `{x, y}` in click space or `'cursor'`, with optional `size: {w, h}` (defaults to 400x200).
   *  - `fullRes`: whole screen at native resolution (large; escape hatch).
   */
  | {
      action: 'screenshot';
      display?: number;
      window?: WindowTarget;
      bringToFront?: boolean;
      format?: 'png' | 'jpeg';
      region?: ClickRegion | NormalizedRegion;
      fullRes?: boolean;
      around?: { x: number; y: number } | 'cursor';
      size?: { w: number; h: number };
    }
  | {
      action: 'mouse';
      op: 'move' | 'click' | 'down' | 'up' | 'scroll' | 'hover' | 'drag';
      x?: number;
      y?: number;
      display?: number;
      window?: WindowTarget;
      bringToFront?: boolean;
      nx?: number;
      ny?: number;
      button?: 'left' | 'right' | 'middle';
      double?: boolean;
      dx?: number;
      dy?: number;
      relative?: boolean;
      transport?: 'injected' | 'virtual-hid';
      smooth?: boolean;
      speed?: 'normal' | 'fast' | 'instant';
      durationMs?: number;
      dwellMs?: number;
      wiggle?: boolean;
      region?: ClickRegion | NormalizedRegion;
      screenshot?: boolean;
      size?: { w: number; h: number };
      to?: { x?: number; y?: number; nx?: number; ny?: number };
      from?: { x?: number; y?: number; nx?: number; ny?: number };
    }
  | {
      action: 'keyboard';
      op: 'type' | 'tap' | 'down' | 'up';
      text?: string;
      keys?: string[];
      durationMs?: number;
      opMode?: 'tap' | 'down' | 'up';
      window?: WindowTarget;
      bringToFront?: boolean;
    }
  | {
      action: 'ocr';
      op: 'read' | 'find' | 'click';
      text?: string;
      regex?: string;
      region?: ClickRegion | NormalizedRegion;
      window?: WindowTarget;
      bringToFront?: boolean;
      occurrence?: number | 'first' | 'last' | 'all';
      caseSensitive?: boolean;
      fuzzy?: boolean | number;
      button?: 'left' | 'right' | 'middle';
      double?: boolean;
      offset?: { x: number; y: number };
      display?: number;
      screenshot?: boolean;
      size?: { w: number; h: number };
      imagePath?: string;
      imageBase64?: string;
      scale?: number;
    }
  | {
      action: 'wait_for';
      text?: string;
      regex?: string;
      template?: string;
      image?: string;
      gone?: boolean;
      region?: ClickRegion | NormalizedRegion;
      window?: WindowTarget;
      bringToFront?: boolean;
      display?: number;
      timeoutMs?: number;
      intervalMs?: number;
      threshold?: number;
    }
  | {
      action: 'find_image';
      template: string;
      region?: ClickRegion | NormalizedRegion;
      window?: WindowTarget;
      bringToFront?: boolean;
      display?: number;
      threshold?: number;
      maxResults?: number;
      scales?: number[];
      imagePath?: string;
      imageBase64?: string;
    }
  | {
      action: 'batch';
      steps: BatchStep[];
      window?: WindowTarget;
      bringToFront?: boolean;
      display?: number;
      stopOnFail?: boolean;
      stopOnError?: boolean;
      abortOnError?: boolean;
      maxDurationMs?: number;
      durationCapMs?: number;
    }
  | { action: 'list_windows' }
  | { action: 'screen_info' };

/**
 * Result of a computer-use action — mirrors redAgent
 * `ComputerResultMessage`. On any transport-level failure we synthesize a
 * value of this same shape with `ok:false` so callers have ONE result type.
 */
export interface ComputerResultMessage {
  kind: 'computer_result';
  id: string;
  ok: boolean;
  image?: {
    format: 'png' | 'jpeg';
    base64: string;
    width: number;
    height: number;
    display?: { index: number; id: number; x: number; y: number };
    sourceWidth?: number;
    sourceHeight?: number;
    clickSpace?: { w: number; h: number };
    captureMode?: 'window' | 'display-crop';
    windowRect?: { x: number; y: number; width: number; height: number };
  };
  screen?: {
    displays: Array<{
      id: number;
      width: number;
      height: number;
      x: number;
      y: number;
      scaleFactor: number;
      primary: boolean;
    }>;
  };
  windows?: Array<{
    id: string | number;
    title: string;
    bounds: { x: number; y: number; width: number; height: number };
    display?: number;
    focused?: boolean;
    minimized?: boolean;
  }>;
  ocr?: {
    text?: string;
    lines?: Array<{
      text: string;
      conf?: number;
      box: { x: number; y: number; w: number; h: number };
      words?: Array<{ text: string; conf?: number; box: { x: number; y: number; w: number; h: number } }>;
    }>;
    words?: Array<{ text: string; conf?: number; box: { x: number; y: number; w: number; h: number } }>;
    matches?: Array<{
      text: string;
      box: { x: number; y: number; w: number; h: number };
      center: { x: number; y: number };
    }>;
    clickSpace?: { w: number; h: number };
    ms?: number;
    display?: { index: number; id: number };
  };
  matches?: Array<{
    box: { x: number; y: number; w: number; h: number };
    center: { x: number; y: number };
    score: number;
  }>;
  clickSpace?: { w: number; h: number };
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface RequestDesktopArgs {
  userId: string;
  request: ComputerAction;
  /** Reject (resolve to ok:false) after this many ms. Default 30000. */
  timeoutMs?: number;
  installId: string;
}

const CMD_CHANNEL_PREFIX = 'desktop:cmd:';
const REPLY_CHANNEL_PREFIX = 'desktop:reply:';
const STREAM_CHANNEL_PREFIX = 'desktop:stream:';

// Connected desktops reply in well under a second; this bounds the wait when
// NO desktop is connected (the round-trip timeout is our presence detector).
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Normalize whatever landed on the id-keyed reply channel into a
 * `ComputerResultMessage`.
 *
 * Exported so the shape the tools receive can be pinned by a test: `result` was
 * missing from this list, and it is the field carrying the connector's account
 * of what it actually did (dryRun, op, typed, text, keys, unknownKeys,
 * foregroundWindow, and the mouse `diag`). Dropping it here meant no tool above
 * could report input evidence even after the connector started sending it — a
 * dry-run no-op and a real keystroke both arrived as a bare `{ok:true}`.
 */
export function normalizeComputerReply(id: string, parsed: AnyObject): ComputerResultMessage {
  return {
    kind: 'computer_result',
    id,
    ok: parsed.ok === true,
    ...(parsed.image ? { image: parsed.image } : {}),
    ...(parsed.screen ? { screen: parsed.screen } : {}),
    ...(parsed.windows ? { windows: parsed.windows } : {}),
    ...(parsed.ocr ? { ocr: parsed.ocr } : {}),
    ...(parsed.matches ? { matches: parsed.matches } : {}),
    ...(parsed.clickSpace ? { clickSpace: parsed.clickSpace } : {}),
    ...(parsed.result ? { result: parsed.result } : {}),
    ...(parsed.error ? { error: parsed.error } : {}),
  };
}

/** Build a fail-safe `computer_result` carrying a `computer_failed` error. */
function failResult(id: string, message: string): ComputerResultMessage {
  return {
    kind: 'computer_result',
    id,
    ok: false,
    error: { code: 'computer_failed', message },
  };
}

/**
 * Send a computer-use request to the user's desktop(s) and await the first
 * reply, or fail safe.
 *
 * Returns a `ComputerResultMessage` ALWAYS — never throws. On the unhappy path
 * it returns `{ ok:false, error:{ code:'computer_failed', ... } }`.
 */
export async function requestDesktop(args: RequestDesktopArgs): Promise<ComputerResultMessage> {
  const id = randomUUID();
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const userId = (args.userId || '').trim();
  if (!userId) return failResult(id, 'No userId available; cannot target any desktop.');
  const installId = (args.installId || '').trim();
  if (!installId) return failResult(id, 'No installId available; targeting a specific desktop is required.');

  const cmdChannel = `${CMD_CHANNEL_PREFIX}${userId}:${installId}`;
  const replyChannel = `${REPLY_CHANNEL_PREFIX}${id}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pub: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sub: any = null;

  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    // Publisher / commands connection. A subscriber-mode connection can't run
    // normal commands (SCAN/PUBLISH), so we keep a SECOND dedicated subscriber
    // connection below — same split the gateway + entity-stream code uses.
    pub = new Redis(redisUrl, { maxRetriesPerRequest: 3 });

    // Dedicated subscriber. `maxRetriesPerRequest: null` mirrors the gateway's
    // subscriber connection (BullMQ/ioredis subscriber-mode requirement).
    sub = new Redis(redisUrl, { maxRetriesPerRequest: null });

    const result = await new Promise<ComputerResultMessage>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;

      const finish = (value: ComputerResultMessage): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(value);
      };

      // First reply on the id-keyed channel wins.
      sub.on('message', (_channel: string, payload: string) => {
        let parsed: AnyObject | null = null;
        try {
          parsed = JSON.parse(payload) as AnyObject;
        } catch {
          return; // ignore malformed
        }
        if (!parsed || typeof parsed !== 'object') return;
        // The gateway publishes the raw upstream message (computer_result /
        // exec_result / ack). For computer-use we expect computer_result, but
        // accept whatever lands on this id-keyed channel — it's unique to this
        // request — and normalize to a ComputerResultMessage.
        finish(normalizeComputerReply(id, parsed));
      });

      // SUBSCRIBE FIRST, then publish — so we can't miss a fast reply.
      sub
        .subscribe(replyChannel)
        .then(() => {
          const message = JSON.stringify({ kind: 'computer', id, request: args.request });
          return pub.publish(cmdChannel, message);
        })
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          finish(failResult(id, `transport error: ${m}`));
        });

      timer = setTimeout(() => {
        finish(
          failResult(
            id,
            `No desktop responded within ${timeoutMs}ms (is redAgent running and computer-use enabled?)`,
          ),
        );
      }, timeoutMs);
    });

    return result;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return failResult(id, m);
  } finally {
    if (sub) {
      try {
        await sub.unsubscribe();
      } catch {
        /* ignore */
      }
      try {
        await sub.quit();
      } catch {
        /* ignore */
      }
    }
    if (pub) {
      try {
        await pub.quit();
      } catch {
        /* ignore */
      }
    }
  }
}


export interface RequestDesktopRawArgs {
  userId: string;
  kind: string;
  payload?: AnyObject;
  timeoutMs?: number;
  installId: string;
  id?: string;
  onChunk?: (chunk: { stream: 'stdout' | 'stderr'; chunk: string; seq: number }) => void;
  abortSignal?: AbortSignal;
}

/**
 * Generic desktop round-trip for non-computer message kinds (exec, settings).
 * Publishes { kind, id, ...payload } to desktop:cmd:{userId}:{installId} and resolves with
 * the FULL parsed reply object (passthrough — exec_result carries `result`,
 * settings_result carries `settings`). Fail-safe: never throws; returns
 * { ok:false, error:{ code:'desktop_failed', message } } on any failure.
 */
export async function requestDesktopRaw(args: RequestDesktopRawArgs): Promise<AnyObject> {
  const id = args.id || randomUUID();
  const timeoutMs =
    typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
      ? args.timeoutMs
      : DEFAULT_TIMEOUT_MS;
  const userId = (args.userId || '').trim();
  if (!userId)
    return { ok: false, error: { code: 'desktop_failed', message: 'No userId available; cannot target any desktop.' } };
  const installId = (args.installId || '').trim();
  if (!installId)
    return { ok: false, error: { code: 'desktop_failed', message: 'No installId available; targeting a specific desktop is required.' } };

  const cmdChannel = `${CMD_CHANNEL_PREFIX}${userId}:${installId}`;
  const replyChannel = `${REPLY_CHANNEL_PREFIX}${id}`;
  const streamChannel = `${STREAM_CHANNEL_PREFIX}${id}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pub: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sub: any = null;
  let abortListener: (() => void) | null = null;
  try {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    pub = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    sub = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const result = await new Promise<AnyObject>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const finish = (value: AnyObject): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (abortListener && args.abortSignal) {
          args.abortSignal.removeEventListener('abort', abortListener);
        }
        resolve(value);
      };
      sub.on('message', (channel: string, payload: string) => {
        let parsed: AnyObject | null = null;
        try {
          parsed = JSON.parse(payload) as AnyObject;
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object') return;
        if (channel === streamChannel) {
          if (args.onChunk && parsed.kind === 'exec_chunk') {
            args.onChunk({
              stream: parsed.stream === 'stderr' ? 'stderr' : 'stdout',
              chunk: typeof parsed.chunk === 'string' ? parsed.chunk : '',
              seq: typeof parsed.seq === 'number' ? parsed.seq : 0,
            });
          }
          return;
        }
        finish({ ...parsed, ok: parsed.ok === true });
      });

      const channels = args.onChunk ? [replyChannel, streamChannel] : [replyChannel];
      sub
        .subscribe(...channels)
        .then(() => {
          if (args.abortSignal) {
            if (args.abortSignal.aborted) {
              void pub.publish(cmdChannel, JSON.stringify({ kind: 'exec_cancel', id }));
            } else {
              abortListener = () => {
                if (pub) {
                  void pub.publish(cmdChannel, JSON.stringify({ kind: 'exec_cancel', id }));
                }
              };
              args.abortSignal.addEventListener('abort', abortListener, { once: true });
            }
          }
          const message = JSON.stringify({ kind: args.kind, id, ...(args.payload || {}) });
          return pub.publish(cmdChannel, message);
        })
        .catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err);
          finish({ ok: false, error: { code: 'desktop_failed', message: `transport error: ${m}` } });
        });
      timer = setTimeout(() => {
        finish({
          ok: false,
          error: { code: 'desktop_failed', message: `No desktop responded within ${timeoutMs}ms (is redAgent running?)` },
        });
      }, timeoutMs);
    });
    return result;
  } catch (err: unknown) {
    const m = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: 'desktop_failed', message: m } };
  } finally {
    if (abortListener && args.abortSignal) {
      args.abortSignal.removeEventListener('abort', abortListener);
    }
    if (sub) {
      try { await sub.unsubscribe(); } catch { /* ignore */ }
      try { await sub.quit(); } catch { /* ignore */ }
    }
    if (pub) {
      try { await pub.quit(); } catch { /* ignore */ }
    }
  }
}

module.exports = { requestDesktop, requestDesktopRaw, normalizeComputerReply };
module.exports.requestDesktop = requestDesktop;
module.exports.requestDesktopRaw = requestDesktopRaw;
module.exports.normalizeComputerReply = normalizeComputerReply;
