/**
 * desktop-presence — "is this push connector still on the hub?" for the
 * `desktop-agent` / `cli` relay.
 *
 * ## Why this exists
 *
 * A `DesktopAgentSession` has no socket. Its readiness check used to be the
 * relay's own round-trip timeout, which is fine when that timeout is a few
 * seconds and catastrophic when it is ten minutes: on 2026-09-15 the hub was
 * redeployed under a workspace runner, the runner's `redbtn connect` WebSocket
 * hung mid-handshake and never re-registered, and the engine kept dispatching
 * tool calls at the environment it had already lost. Each one sat for the full
 * `No desktop responded within 630000ms` — 27 minutes of a 40-minute run — on a
 * connector the hub knew was gone within 70 seconds.
 *
 * The hub already publishes the answer. The `/ws/desktop` gateway SETs a
 * presence key per connected install on register and refreshes it on every
 * heartbeat ping, with a TTL comfortably longer than the ping cadence:
 *
 *     desktop:presence:{userId}:{installId}      (webapp desktop-gateway.ts)
 *
 * Keyed by userId + installId — NOT by environmentId. The engine shares that
 * Redis (`REDIS_URL`), so a single `EXISTS` is an authoritative, ~1 ms answer.
 *
 * ## Verdicts
 *
 * Three, not two. `unknown` exists so a probe failure can never fail a healthy
 * run: if we cannot tell, the caller proceeds exactly as it did before this
 * module existed, and the relay timeout remains the backstop.
 *
 *   online   — the gateway holds a live presence key (or, with Redis
 *              unreachable, the environment doc was touched within
 *              `PRESENCE_STALE_MS`)
 *   offline  — the key is gone (or, with Redis unreachable, `lastSeenAt` is
 *              older than `PRESENCE_STALE_MS`)
 *   unknown  — no identity to key on, or the probe itself failed
 *
 * @module lib/environments/desktop-presence
 */

/** Key prefix the `/ws/desktop` gateway writes presence under. Must match webapp `desktop-gateway.ts`. */
export const PRESENCE_PREFIX = 'desktop:presence:';

/**
 * TTL (seconds) the gateway sets on a presence key. Mirrors
 * `PRESENCE_TTL_SECONDS` in the webapp gateway. Used only to describe HOW LONG
 * an environment has been absent when there is no `lastSeenAt` to measure from:
 * a missing key means at least this long has passed since the last heartbeat.
 */
export const PRESENCE_TTL_SECONDS = 70;

/**
 * How stale `lastSeenAt` may get before the fallback calls an environment
 * offline, in ms. Deliberately wider than the gateway's 70 s presence TTL: the
 * `lastSeenAt` bump is a best-effort, non-blocking Mongo write on the ping path,
 * so it lags the Redis key and must not be read as tightly.
 */
export const PRESENCE_STALE_MS = 90_000;

/** Hard ceiling on a single probe, in ms. A wedged Redis must never extend the wait it is policing. */
export const PROBE_TIMEOUT_MS = 3_000;

export type LivenessVerdict = 'online' | 'offline' | 'unknown';

export interface LivenessResult {
  verdict: LivenessVerdict;
  /**
   * Seconds since the environment was last seen, when that is knowable.
   * Present only on an `offline` verdict derived from a `lastSeenAt`.
   */
  offlineForSeconds?: number;
  /** Which signal produced the verdict — for logs and tests. */
  source: 'redis' | 'lastSeenAt' | 'unavailable';
}

export interface ProbeDesktopPresenceArgs {
  userId: string;
  installId: string;
  /** The environment document's `lastSeenAt`, used when Redis cannot answer. */
  lastSeenAt?: Date | string | number | null;
}

/** The sliver of ioredis this module uses. Small enough to fake in a test. */
export interface PresenceRedis {
  exists(key: string): Promise<number>;
  disconnect?(): void;
  quit?(): Promise<unknown>;
}

/**
 * How a probe gets its Redis client. Injectable so tests can hand over a fake
 * instead of mocking the `ioredis` module graph — the same seam
 * `EnvironmentManagerOptions.clientFactory` provides for ssh2.
 */
export type PresenceRedisFactory = () => PresenceRedis;

/** The presence key the gateway writes for one connected install. */
export function presenceKey(userId: string, installId: string): string {
  return `${PRESENCE_PREFIX}${userId}:${installId}`;
}

/** Default factory — a short-lived ioredis client on the shared `REDIS_URL`. */
function defaultRedisFactory(): PresenceRedis {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const IORedis = require('ioredis');
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  // One retry and a short connect budget: a probe that cannot answer quickly is
  // worth less than the time it costs, and `unknown` is a safe answer.
  return new IORedis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: PROBE_TIMEOUT_MS,
  }) as PresenceRedis;
}

/** Milliseconds since `value`, or `null` when it is not a usable instant. */
function ageMs(value: Date | string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Date.now() - t);
}

/** Verdict from `lastSeenAt` alone — the fallback when Redis cannot answer. */
function fromLastSeenAt(lastSeenAt: ProbeDesktopPresenceArgs['lastSeenAt']): LivenessResult {
  const age = ageMs(lastSeenAt);
  if (age === null) return { verdict: 'unknown', source: 'unavailable' };
  if (age > PRESENCE_STALE_MS) {
    return { verdict: 'offline', offlineForSeconds: Math.round(age / 1000), source: 'lastSeenAt' };
  }
  return { verdict: 'online', source: 'lastSeenAt' };
}

/**
 * Is the push connector behind (userId, installId) still registered on the hub?
 *
 * Never throws and never waits longer than `PROBE_TIMEOUT_MS`. Redis is
 * authoritative when it answers; `lastSeenAt` is the degrade path; "cannot
 * tell" resolves to `unknown`, which callers must treat as online.
 */
export async function probeDesktopPresence(
  args: ProbeDesktopPresenceArgs,
  redisFactory: PresenceRedisFactory = defaultRedisFactory,
): Promise<LivenessResult> {
  const userId = (args.userId || '').trim();
  const installId = (args.installId || '').trim();
  // Nothing to key on — an SSH-shaped env, or a doc that never registered.
  if (!userId || !installId) return { verdict: 'unknown', source: 'unavailable' };

  let redis: PresenceRedis | null = null;
  try {
    redis = redisFactory();
    const key = presenceKey(userId, installId);
    const exists = await withDeadline(redis.exists(key), PROBE_TIMEOUT_MS);
    if (exists > 0) return { verdict: 'online', source: 'redis' };
    // The key is genuinely absent: the gateway either never registered this
    // install or let its TTL lapse ~70 s after the last heartbeat. Describe the
    // gap from `lastSeenAt` when we have one, else from that TTL.
    const age = ageMs(args.lastSeenAt);
    return {
      verdict: 'offline',
      offlineForSeconds: age === null ? PRESENCE_TTL_SECONDS : Math.round(age / 1000),
      source: 'redis',
    };
  } catch {
    // Redis is unreachable, slow, or not configured here. Fall back to the
    // environment document rather than guessing.
    return fromLastSeenAt(args.lastSeenAt);
  } finally {
    if (redis) {
      try {
        redis.disconnect?.();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Reject if `work` has not settled within `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`presence probe timed out after ${ms}ms`)), ms);
    if (typeof timer.unref === 'function') timer.unref();
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
