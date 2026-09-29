/**
 * Fleet-wide leases for the shared GitHub Copilot SDK subscription.
 *
 * All Copilot SDK sessions share one Redis sorted set, irrespective of user or
 * credential. Entries
 * expire by score and are renewed while held. Workers fail closed when Redis is
 * unavailable; a local semaphore would not protect the shared subscription.
 */
import * as crypto from 'crypto';

export const COPILOT_LEASE_TTL_MS = 60_000;
export const COPILOT_LEASE_RENEW_MS = 15_000;
export const COPILOT_LEASE_POLL_MS = 500;
/** Fixed shared-account session ceiling. Never vary per worker/replica. */
export const COPILOT_MAX_CONCURRENT = 10;

export interface CopilotRedisLeaseClient {
  eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

export interface CopilotLeaseHandle {
  startRenewal(onLost: (error: Error) => void): void;
  /** Verify Redis still considers this lease live using Redis TIME. */
  assertOwned(): Promise<boolean>;
  release(): Promise<void>;
}

export interface AcquireCopilotLeaseOptions {
  signal?: AbortSignal;
  maxWaitMs: number;
  onWaiting?: (reason: string) => void;
  redisFactory?: (options?: { signal?: AbortSignal; timeoutMs: number }) => Promise<CopilotRedisLeaseClient>;
  ttlMs?: number;
  renewMs?: number;
  pollMs?: number;
}

export const COPILOT_LEASE_ACQUIRE_SCRIPT = `
  local time = redis.call('TIME')
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local ttl = tonumber(ARGV[1])
  redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[3])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return 1
`;

export const COPILOT_LEASE_RENEW_SCRIPT = `
  local time = redis.call('TIME')
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if not expires or tonumber(expires) <= now then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end
  local ttl = tonumber(ARGV[2])
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return 1
`;

export const COPILOT_LEASE_ASSERT_SCRIPT = `
  local time = redis.call('TIME')
  local now = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)
  local expires = redis.call('ZSCORE', KEYS[1], ARGV[1])
  if not expires or tonumber(expires) <= now then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end
  return 1
`;

export const COPILOT_LEASE_RELEASE_SCRIPT = `
  return redis.call('ZREM', KEYS[1], ARGV[1])
`;

function abortError(): Error {
  const error = new Error('Copilot SDK lease acquisition aborted');
  error.name = 'AbortError';
  return error;
}

async function defaultRedisFactory(options: { signal?: AbortSignal; timeoutMs: number }): Promise<CopilotRedisLeaseClient> {
  const redisUrl = process.env.REDIS_URL;
  if (typeof redisUrl !== 'string' || redisUrl.trim() === '') {
    const error = new Error('REDIS_URL is required for the fleet-wide Copilot SDK lease');
    (error as Error & { code?: string }).code = 'copilot_sdk_redis_url_missing';
    throw error;
  }
  // Keep Redis an optional peer dependency for engine consumers that do not
  // start workers, matching the rest of the engine's Redis integrations.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const Redis = require('ioredis');
  const client = new Redis(redisUrl, {
    lazyConnect: true,
    connectTimeout: Math.max(1, Math.min(2_000, options.timeoutMs)),
    commandTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  let abortHandler: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    if (options.signal?.aborted) {
      client.disconnect();
      reject(abortError());
      return;
    }
    abortHandler = () => {
      client.disconnect();
      reject(abortError());
    };
    options.signal?.addEventListener('abort', abortHandler, { once: true });
  });
  try {
    await Promise.race([client.connect(), abort]);
    return client as CopilotRedisLeaseClient;
  } catch (error) {
    client.disconnect();
    throw error;
  } finally {
    if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
  }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Acquire a lease against all workers that use this exact credential. */
export async function acquireCopilotLease(
  options: AcquireCopilotLeaseOptions,
): Promise<CopilotLeaseHandle> {
  const startedAt = Date.now(); // queue deadline only; never sent to Redis or used for lease expiry.
  const factory = options.redisFactory ?? defaultRedisFactory;
  let client: CopilotRedisLeaseClient;
  try {
    client = await factory({ signal: options.signal, timeoutMs: options.maxWaitMs });
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (Date.now() - startedAt >= options.maxWaitMs) {
      const timeout = new Error(`timed out waiting ${options.maxWaitMs} ms to connect to Redis for the Copilot SDK lease`);
      (timeout as Error & { code?: string }).code = 'copilot_sdk_queue_timeout';
      throw timeout;
    }
    throw error;
  }
  // This single key is the globally shared pool across credentials, accounts,
  // workers, and containers. Never include authentication material in Redis.
  const key = 'redbtn:copilot-sdk:leases';
  const token = crypto.randomUUID();
  const ttlMs = options.ttlMs ?? COPILOT_LEASE_TTL_MS;
  const renewMs = options.renewMs ?? COPILOT_LEASE_RENEW_MS;
  const pollMs = options.pollMs ?? COPILOT_LEASE_POLL_MS;
  let acquired = false;

  try {
    while (!acquired) {
      if (options.signal?.aborted) throw abortError();
      const now = Date.now();
      if (now - startedAt >= options.maxWaitMs) {
        const error = new Error(`timed out waiting ${options.maxWaitMs} ms for a Copilot SDK subscription lease`);
        (error as Error & { code?: string }).code = 'copilot_sdk_queue_timeout';
        throw error;
      }
      const result = await client.eval(
        COPILOT_LEASE_ACQUIRE_SCRIPT,
        1,
        key,
        ttlMs,
        COPILOT_MAX_CONCURRENT,
        token,
      );
      acquired = Number(result) === 1;
      if (!acquired) {
        const waited = Date.now() - startedAt;
        options.onWaiting?.(`waiting for a shared Copilot subscription lease (${waited} ms)`);
        await sleep(Math.min(pollMs, Math.max(1, options.maxWaitMs - waited)), options.signal);
      }
    }
  } catch (error) {
    try { await client.quit?.(); } catch { client.disconnect?.(); }
    throw error;
  }

  let renewalTimer: NodeJS.Timeout | null = null;
  let released = false;
  const handle: CopilotLeaseHandle = {
    async assertOwned() {
      const result = await client.eval(COPILOT_LEASE_ASSERT_SCRIPT, 1, key, token);
      return Number(result) === 1;
    },
    startRenewal(onLost) {
      if (renewalTimer || released) return;
      let lossReported = false;
      renewalTimer = setInterval(() => {
        void client.eval(
          COPILOT_LEASE_RENEW_SCRIPT,
          1,
          key,
          token,
          ttlMs,
        ).then((result) => {
          if (Number(result) !== 1 && !lossReported) {
            lossReported = true;
            onLost(new Error('Copilot SDK subscription lease was lost'));
          }
        }).catch((error: unknown) => {
          if (!lossReported) {
            lossReported = true;
            onLost(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }, renewMs);
      renewalTimer.unref?.();
    },
    async release() {
      if (released) return;
      released = true;
      if (renewalTimer) clearInterval(renewalTimer);
      renewalTimer = null;
      try {
        await client.eval(COPILOT_LEASE_RELEASE_SCRIPT, 1, key, token);
      } finally {
        try { await client.quit?.(); } catch { client.disconnect?.(); }
      }
    },
  };
  return handle;
}
