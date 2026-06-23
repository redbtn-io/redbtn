/**
 * alert_desktop — Native Tool (redAgent push connector)
 *
 * Sends an OS-notification / spoken alert to ALL of the calling user's
 * connected desktop machines (redAgent connectors).
 *
 * # How delivery works
 *
 * This tool is fire-and-forget over Redis pub/sub — it does NOT open an
 * EnvironmentSession or address a single `environmentId`. The webapp runs a
 * `/ws/desktop` gateway: each connected desktop holds an outbound WebSocket,
 * and the gateway subscribes a Redis client to `desktop:alert:{userId}` for
 * that socket. When this tool PUBLISHes an alert to that channel, every one of
 * the user's connected desktops receives it and pops a native notification
 * (optionally speaking the body via TTS).
 *
 * Wire contract (matches redAgent `src/shared/protocol.ts` `AlertMessage`):
 *
 *   { kind:'alert', id, title, body, level?, speak?, voiceId?, speed? }
 *
 *   - `level` on the protocol message is `'info' | 'warning' | 'critical'`.
 *     We accept a broader input enum for ergonomics (`success`/`error`) and
 *     map them onto the wire enum (`success`→`info`, `error`→`critical`).
 *   - `speed` is not part of the protocol AlertMessage but the connector's TTS
 *     path honors it; we forward it so a future protocol bump is forward-compatible.
 *
 * # Presence
 *
 * The gateway maintains a presence key per connected install:
 *   `desktop:presence:{userId}:{installId}`  (≈70s TTL, refreshed on heartbeat)
 * We SCAN (never KEYS) for `desktop:presence:{userId}:*` to report how many
 * desktops are currently connected (`delivered`).
 *
 * # Fail-safe
 *
 * EVERYTHING is wrapped in try/catch. A delivery failure NEVER throws into the
 * run — on error we return `{ delivered: 0, ... , note }` so the LLM can adapt.
 *
 * Environment:
 *   REDIS_URL — Redis connection (default redis://localhost:6379)
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/** Protocol-level severity (matches redAgent AlertMessage.level). */
type WireLevel = 'info' | 'warning' | 'critical';
/** Broader input enum for tool ergonomics. */
type InputLevel = 'info' | 'success' | 'warning' | 'error';

interface AlertDesktopArgs {
  title: string;
  body: string;
  speak?: boolean;
  voiceId?: string;
  level?: InputLevel;
  speed?: number;
}

const ALERT_CHANNEL_PREFIX = 'desktop:alert:';
const PRESENCE_PREFIX = 'desktop:presence:';

/** Map the broad input level onto the protocol wire enum. */
function toWireLevel(level: InputLevel | undefined): WireLevel {
  switch (level) {
    case 'warning':
      return 'warning';
    case 'error':
      return 'critical';
    case 'success':
    case 'info':
    default:
      return 'info';
  }
}

/**
 * Generate a lightweight correlation id for the alert message. Mirrors the
 * shape connectors expect on `AlertMessage.id` (any unique string).
 */
function makeAlertId(): string {
  return `alert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Count connected desktops for a user via SCAN over
 * `desktop:presence:{userId}:*`. SCAN (cursor-based) is used instead of KEYS
 * so we never block Redis on large keyspaces.
 */
async function countPresence(redis: AnyObject, userId: string): Promise<number> {
  const match = `${PRESENCE_PREFIX}${userId}:*`;
  let cursor = '0';
  let count = 0;
  // Bound the walk so a pathological keyspace can't spin forever.
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

const alertDesktopTool: NativeToolDefinition = {
  description:
    "Send an alert (OS notification + optional spoken TTS) to all of the current user's connected desktop machines (redAgent). Fire-and-forget over Redis pub/sub — targets every connected desktop, no environmentId needed. Returns how many desktops were connected at send time.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Short notification title. Required.',
      },
      body: {
        type: 'string',
        description: 'Notification body text. Also the text spoken aloud when speak is true. Required.',
      },
      speak: {
        type: 'boolean',
        description: 'If true (default), the desktop also speaks the body aloud via TTS.',
        default: true,
      },
      voiceId: {
        type: 'string',
        description: "Optional TTS voice id. Defaults to the desktop's configured voice when omitted.",
      },
      level: {
        type: 'string',
        enum: ['info', 'success', 'warning', 'error'],
        description:
          "Severity hint for styling/sound. Mapped onto the connector's wire enum (success→info, error→critical). Default info.",
        default: 'info',
      },
      speed: {
        type: 'number',
        description: 'Optional TTS speed multiplier (1.0 = normal).',
      },
    },
    required: ['title', 'body'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<AlertDesktopArgs>;
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';

    if (!title || !body) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Both title and body are required non-empty strings',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // Resolve the target user from run state (same pattern as the other
    // native tools — userId is injected onto the graph state at run start).
    const userId =
      (context?.state?.userId as string | undefined) ||
      (context?.state?.data?.userId as string | undefined) ||
      (context?.state?.options?.userId as string | undefined);

    if (!userId) {
      // No user context → nothing to target. Fail safe: return delivered:0,
      // never throw.
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered: 0,
              channel: null,
              note: 'No userId available in run context; cannot target any desktop.',
            }),
          },
        ],
      };
    }

    const channel = `${ALERT_CHANNEL_PREFIX}${userId}`;
    const speak = args.speak !== false; // default true
    const level = toWireLevel(args.level);

    // Build the wire alert message (matches redAgent AlertMessage shape).
    const alert: AnyObject = {
      kind: 'alert',
      id: makeAlertId(),
      title,
      body,
      level,
      speak,
    };
    if (typeof args.voiceId === 'string' && args.voiceId.trim()) {
      alert.voiceId = args.voiceId.trim();
    }
    if (typeof args.speed === 'number' && Number.isFinite(args.speed)) {
      alert.speed = args.speed;
    }

    const { publisher } = context;
    publisher?.emit?.('log', `alert_desktop → ${channel}: ${title}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let redis: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const IORedis = require('ioredis');
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      redis = new IORedis(redisUrl, { maxRetriesPerRequest: 3 });

      // Count connected desktops (best-effort — a SCAN failure must not block
      // the publish).
      let delivered = 0;
      try {
        delivered = await countPresence(redis, userId);
      } catch (scanErr) {
        const m = scanErr instanceof Error ? scanErr.message : String(scanErr);
        publisher?.emit?.('log', `alert_desktop presence scan failed (continuing): ${m}`);
      }

      // Publish the alert. The gateway relays it to every connected socket
      // subscribed to this channel.
      await redis.publish(channel, JSON.stringify(alert));

      const note =
        delivered === 0
          ? 'No desktops currently connected; the alert was published but may not be delivered.'
          : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered,
              channel,
              alert,
              ...(note ? { note } : {}),
            }),
          },
        ],
      };
    } catch (err: unknown) {
      // Fail-safe: never throw into the run. Surface delivered:0 + a note.
      const msg = err instanceof Error ? err.message : String(err);
      publisher?.emit?.('log', `alert_desktop failed: ${msg}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered: 0,
              channel,
              alert,
              note: `Failed to deliver alert: ${msg}`,
            }),
          },
        ],
      };
    } finally {
      if (redis) {
        try {
          await redis.quit();
        } catch {
          /* ignore */
        }
      }
    }
  },
};

export default alertDesktopTool;
module.exports = alertDesktopTool;
