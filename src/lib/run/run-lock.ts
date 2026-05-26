/**
 * Run Lock
 *
 * Distributed lock for run execution. Ensures only one run per (conversation,
 * agent) pair can execute at a time. Uses Redis with automatic expiration
 * and renewal.
 *
 * Key pattern: `run:lock:{conversationId}` or
 *              `run:lock:{conversationId}:{agentId}` when an agentId is
 *              supplied (group-chat / agent-instance flows).
 *
 * @module lib/run/run-lock
 */
import type { Redis } from 'ioredis';
import { RunKeys, RunConfig } from './types';

/**
 * Lock acquisition result
 */
export interface LockResult {
  acquired: boolean;
  token?: string;
  error?: string;
}

/**
 * Options for lock acquisition
 */
export interface AcquireLockOptions {
  ttlSeconds?: number;
  autoRenew?: boolean;
  renewalIntervalMs?: number;
}

/**
 * Run lock handle returned from acquireLock
 */
export interface RunLockHandle {
  token: string;
  conversationId: string;
  /** Set when the lock was acquired with an agentId (agent-instance / group-chat flow). */
  agentId?: string;
  release: () => Promise<boolean>;
  stopRenewal: () => void;
}

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const RENEW_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("expire", KEYS[1], ARGV[2])
  else
    return 0
  end
`;

function generateToken(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

export class RunLock {
  constructor(private readonly redis: Redis) {}

  async acquire(conversationId: string, options?: AcquireLockOptions & { agentId?: string }): Promise<RunLockHandle | null> {
    const agentId = options?.agentId;
    const key = RunKeys.lock(conversationId, agentId);
    const token = generateToken();
    const ttl = options?.ttlSeconds ?? RunConfig.LOCK_TTL_SECONDS;

    const result = await this.redis.set(key, token, 'EX', ttl, 'NX');
    if (result !== 'OK') return null;

    let renewalTimer: ReturnType<typeof setInterval> | null = null;
    const stopRenewal = () => {
      if (renewalTimer) { clearInterval(renewalTimer); renewalTimer = null; }
    };

    if (options?.autoRenew !== false) {
      const renewalInterval = options?.renewalIntervalMs ?? RunConfig.LOCK_RENEWAL_INTERVAL_MS;
      renewalTimer = setInterval(async () => {
        try {
          const renewed = await this.renew(conversationId, token, ttl, agentId);
          if (!renewed) stopRenewal();
        } catch (error) {
          console.error('Lock renewal failed:', error);
          stopRenewal();
        }
      }, renewalInterval);
    }

    const release = async () => {
      stopRenewal();
      return this.release(conversationId, token, agentId);
    };

    return { token, conversationId, agentId, release, stopRenewal };
  }

  async release(conversationId: string, token: string, agentId?: string): Promise<boolean> {
    const key = RunKeys.lock(conversationId, agentId);
    const result = await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, key, token);
    return result === 1;
  }

  async renew(conversationId: string, token: string, ttlSeconds?: number, agentId?: string): Promise<boolean> {
    const key = RunKeys.lock(conversationId, agentId);
    const ttl = ttlSeconds ?? RunConfig.LOCK_TTL_SECONDS;
    const result = await this.redis.eval(RENEW_LOCK_SCRIPT, 1, key, token, ttl.toString());
    return result === 1;
  }

  async isLocked(conversationId: string, agentId?: string): Promise<boolean> {
    const key = RunKeys.lock(conversationId, agentId);
    const value = await this.redis.get(key);
    return value !== null;
  }

  async getLockInfo(conversationId: string, agentId?: string): Promise<{ token: string; ttl: number } | null> {
    const key = RunKeys.lock(conversationId, agentId);
    const [token, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    if (!token || ttl < 0) return null;
    return { token, ttl };
  }

  async forceRelease(conversationId: string, agentId?: string): Promise<boolean> {
    const key = RunKeys.lock(conversationId, agentId);
    const result = await this.redis.del(key);
    return result === 1;
  }
}

export function createRunLock(redis: Redis): RunLock {
  return new RunLock(redis);
}

export async function acquireRunLock(
  redis: Redis,
  conversationId: string,
  options?: AcquireLockOptions & { agentId?: string },
): Promise<RunLockHandle | null> {
  const lock = new RunLock(redis);
  return lock.acquire(conversationId, options);
}

export async function isConversationLocked(redis: Redis, conversationId: string): Promise<boolean> {
  const lock = new RunLock(redis);
  return lock.isLocked(conversationId);
}

/** @deprecated Use isConversationLocked instead */
export async function isGraphLocked(_redis: Redis, _userId: string, _graphId: string): Promise<boolean> {
  console.warn('[RunLock] isGraphLocked is deprecated, use isConversationLocked instead');
  return false;
}
