/**
 * alert_desktop — Native Tool (redAgent push connector)
 *
 * Sends an OS-notification / spoken alert to one targeted desktop machine
 * (redAgent connector).
 *
 * # How delivery works
 *
 * This tool is fire-and-forget over Redis pub/sub — it does NOT open an
 * EnvironmentSession, but it DOES require an `environmentId` so the caller
 * targets one desktop install. The webapp runs a `/ws/desktop` gateway: each
 * connected desktop holds an outbound WebSocket, and the gateway subscribes a
 * Redis client to `desktop:cmd:{userId}:{installId}` for that socket. When this
 * tool PUBLISHes an alert to that targeted channel, only that desktop receives
 * it and pops a native notification (optionally speaking the body via TTS).
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
 * We check the targeted presence key to report whether the target appeared
 * online at send time. Redis `PUBLISH` gives the actual subscriber count.
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
import { loadAndResolveEnvironment } from '../../environments/loadAndResolveEnvironment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

/** Protocol-level severity (matches redAgent AlertMessage.level). */
type WireLevel = 'info' | 'warning' | 'critical';
/** Broader input enum for tool ergonomics. */
type InputLevel = 'info' | 'success' | 'warning' | 'error';

interface AlertDesktopArgs {
  environmentId: string;
  title: string;
  body: string;
  speak?: boolean;
  voiceId?: string;
  level?: InputLevel;
  speed?: number;
}

const CMD_CHANNEL_PREFIX = 'desktop:cmd:';
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

function resolveUserId(context: NativeToolContext): string | null {
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined) ||
    (context?.state?.options?.userId as string | undefined);
  return userId && String(userId).trim() ? String(userId).trim() : null;
}

async function resolveInstallId(context: NativeToolContext, environmentId: string): Promise<string | undefined> {
  const userId = resolveUserId(context);
  if (!userId) return undefined;

  try {
    const { env } = await loadAndResolveEnvironment(environmentId, userId);
    return env.installId;
  } catch (err) {
    throw new Error(`Failed to resolve environment ${environmentId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const alertDesktopTool: NativeToolDefinition = {
  description:
    "Send an alert (OS notification + optional spoken TTS) to a targeted desktop machine (redAgent). Fire-and-forget over Redis pub/sub. Requires environmentId and fails if the desktop environment cannot be resolved.",
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      environmentId: {
        type: 'string',
        description: 'environmentId of the target desktop agent.',
      },
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
    required: ['environmentId', 'title', 'body'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<AlertDesktopArgs>;
    const environmentId = typeof args.environmentId === 'string' ? args.environmentId.trim() : '';
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    const body = typeof args.body === 'string' ? args.body.trim() : '';

    if (!environmentId || !title || !body) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'environmentId, title, and body are required non-empty strings',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const userId = resolveUserId(context);

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

    let installId: string | undefined;
    try {
      installId = await resolveInstallId(context, environmentId);
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered: 0,
              channel: null,
              error: {
                code: 'desktop_failed',
                message: err instanceof Error ? err.message : String(err),
              },
            }),
          },
        ],
        isError: true,
      };
    }

    if (!installId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered: 0,
              channel: null,
              error: {
                code: 'desktop_failed',
                message: `Target environment ${environmentId} does not have an active desktop connection (missing installId).`,
              },
            }),
          },
        ],
        isError: true,
      };
    }

    const channel = `${CMD_CHANNEL_PREFIX}${userId}:${installId}`;
    const presenceKey = `${PRESENCE_PREFIX}${userId}:${installId}`;
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

      // Best-effort presence check. PUBLISH's subscriber count below remains
      // the source of truth for whether a connected gateway socket received it.
      let targetOnline = false;
      try {
        targetOnline = (await redis.exists(presenceKey)) > 0;
      } catch (scanErr) {
        const m = scanErr instanceof Error ? scanErr.message : String(scanErr);
        publisher?.emit?.('log', `alert_desktop presence check failed (continuing): ${m}`);
      }

      const delivered = await redis.publish(channel, JSON.stringify(alert));

      const note =
        delivered === 0
          ? 'Target desktop is not currently connected; the alert was published but no gateway socket received it.'
          : undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              delivered,
              channel,
              environmentId,
              installId,
              targetOnline,
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
