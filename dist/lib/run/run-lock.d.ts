/**
 * Run Lock
 *
 * Distributed lock for run execution. Ensures only one run per conversation
 * can execute at a time. Uses Redis with automatic expiration and renewal.
 *
 * Key pattern: `run:lock:{conversationId}`
 *
 * @module lib/run/run-lock
 */
import type { Redis } from 'ioredis';
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
    release: () => Promise<boolean>;
    stopRenewal: () => void;
}
export declare class RunLock {
    private readonly redis;
    constructor(redis: Redis);
    acquire(conversationId: string, options?: AcquireLockOptions): Promise<RunLockHandle | null>;
    release(conversationId: string, token: string): Promise<boolean>;
    renew(conversationId: string, token: string, ttlSeconds?: number): Promise<boolean>;
    isLocked(conversationId: string): Promise<boolean>;
    getLockInfo(conversationId: string): Promise<{
        token: string;
        ttl: number;
    } | null>;
    forceRelease(conversationId: string): Promise<boolean>;
}
export declare function createRunLock(redis: Redis): RunLock;
export declare function acquireRunLock(redis: Redis, conversationId: string, options?: AcquireLockOptions): Promise<RunLockHandle | null>;
export declare function isConversationLocked(redis: Redis, conversationId: string): Promise<boolean>;
/** @deprecated Use isConversationLocked instead */
export declare function isGraphLocked(_redis: Redis, _userId: string, _graphId: string): Promise<boolean>;
