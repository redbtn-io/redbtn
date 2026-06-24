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
 *   Request channel `desktop:cmd:{userId}`
 *     The tool PUBLISHes the full protocol message
 *       { "kind":"computer", "id":"<uuid>", "request": <ComputerAction> }
 *     here. The gateway (one dedicated subscriber per connected socket) relays
 *     it verbatim down that socket.
 *
 *   Reply channel `desktop:reply:{id}`  (keyed by the request's `id`)
 *     When the desktop sends a `computer_result` (or `exec_result`/`ack`) up
 *     the socket, the gateway PUBLISHes that message JSON here. This helper,
 *     subscribed to `desktop:reply:{id}` BEFORE it publishes the command,
 *     receives the first such message and resolves.
 *
 * # v1 limitation (documented)
 *
 * The command channel is keyed by `{userId}`, exactly like alerts. If a user
 * has multiple desktops connected, ALL of them receive the command — but the
 * reply is keyed by the unique request `id`, so the FIRST desktop to answer
 * wins and any later duplicate replies are ignored (the subscriber is torn
 * down after the first message). Targeting a specific `installId`/display is a
 * follow-up.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/**
 * Computer-use action — discriminated union mirroring redAgent
 * `src/shared/protocol.ts` `ComputerAction` EXACTLY.
 */
export type ComputerAction =
  | { action: 'screenshot'; display?: number; format?: 'png' | 'jpeg' }
  | {
      action: 'mouse';
      op: 'move' | 'click' | 'down' | 'up' | 'scroll';
      x?: number;
      y?: number;
      button?: 'left' | 'right' | 'middle';
      double?: boolean;
      dx?: number;
      dy?: number;
    }
  | { action: 'keyboard'; op: 'type' | 'tap'; text?: string; keys?: string[] }
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
  error?: { code: string; message: string };
}

export interface RequestDesktopArgs {
  userId: string;
  request: ComputerAction;
  /** Reject (resolve to ok:false) after this many ms. Default 30000. */
  timeoutMs?: number;
}

const CMD_CHANNEL_PREFIX = 'desktop:cmd:';
const REPLY_CHANNEL_PREFIX = 'desktop:reply:';
const PRESENCE_PREFIX = 'desktop:presence:';

const DEFAULT_TIMEOUT_MS = 30_000;

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
 * Count connected desktops for a user via SCAN over
 * `desktop:presence:{userId}:*`. SCAN (cursor-based) is used instead of KEYS
 * so we never block Redis on large keyspaces. Mirrors `alert_desktop`.
 */
async function countPresence(redis: AnyObject, userId: string): Promise<number> {
  const match = `${PRESENCE_PREFIX}${userId}:*`;
  let cursor = '0';
  let count = 0;
  let iterations = 0;
  do {
    const [next, keys] = (await redis.scan(cursor, 'MATCH', match, 'COUNT', 100)) as [
      string,
      string[],
    ];
    cursor = next;
    count += keys.length;
    iterations += 1;
  } while (cursor !== '0' && iterations < 1000);
  return count;
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

  const cmdChannel = `${CMD_CHANNEL_PREFIX}${userId}`;
  const replyChannel = `${REPLY_CHANNEL_PREFIX}${id}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pub: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let sub: any = null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const IORedis = require('ioredis');
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

    // Publisher / commands connection. A subscriber-mode connection can't run
    // normal commands (SCAN/PUBLISH), so we keep a SECOND dedicated subscriber
    // connection below — same split the gateway + entity-stream code uses.
    pub = new IORedis(redisUrl, { maxRetriesPerRequest: 3 });

    // Presence gate: if zero desktops are connected, fail immediately instead
    // of waiting out the full timeout. Best-effort — a SCAN failure must not
    // block a request that might still succeed, so we only short-circuit on a
    // confirmed zero.
    try {
      const connected = await countPresence(pub, userId);
      if (connected === 0) {
        return failResult(id, 'No desktop connected.');
      }
    } catch {
      /* presence check is best-effort — fall through and try the round-trip */
    }

    // Dedicated subscriber. `maxRetriesPerRequest: null` mirrors the gateway's
    // subscriber connection (BullMQ/ioredis subscriber-mode requirement).
    sub = new IORedis(redisUrl, { maxRetriesPerRequest: null });

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
        finish({
          kind: 'computer_result',
          id,
          ok: parsed.ok === true,
          ...(parsed.image ? { image: parsed.image } : {}),
          ...(parsed.screen ? { screen: parsed.screen } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        });
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
        finish(failResult(id, `timed out after ${timeoutMs}ms waiting for desktop`));
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

module.exports = { requestDesktop };
module.exports.requestDesktop = requestDesktop;
