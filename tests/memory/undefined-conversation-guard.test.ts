/**
 * MemoryManager guard tests (2026-10-09 incident).
 *
 * Every MemoryManager method that builds `conversations:${id}:*` keys must
 * throw {@link InvalidConversationIdError} for unusable ids — read AND
 * write — and never touch a `conversations:undefined*` Redis key.
 *
 * Uses a fake ioredis client that records every key it is asked about.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const fakeRedisState = vi.hoisted(() => ({
  touchedKeys: [] as string[],
}));

const { FakeRedis } = vi.hoisted(() => {
  class FakeRedisInner {
    constructor(_url?: string) {}
    private touch(...keys: (string | undefined)[]) {
      for (const k of keys) {
        if (typeof k === 'string') (fakeRedisState as { touchedKeys: string[] }).touchedKeys.push(k);
      }
    }
    async get(key: string) { this.touch(key); return null; }
    async set(key: string, _v: unknown) { this.touch(key); return 'OK'; }
    async del(...keys: string[]) { this.touch(...keys); return 0; }
    async hset(key: string, ..._rest: unknown[]) { this.touch(key); return 0; }
    async hget(key: string, _f: string) { this.touch(key); return null; }
    async hgetall(key: string) { this.touch(key); return {}; }
    async hdel(key: string, ..._rest: unknown[]) { this.touch(key); return 0; }
    async rpush(key: string, ..._rest: unknown[]) { this.touch(key); return 0; }
    async lrange(key: string, _a: number, _b: number) { this.touch(key); return []; }
    async llen(key: string) { this.touch(key); return 0; }
    async ltrim(key: string, _a: number, _b: number) { this.touch(key); return 'OK'; }
    async sadd(key: string, ..._rest: unknown[]) { this.touch(key); return 1; }
    async srem(key: string, ..._rest: unknown[]) { this.touch(key); return 0; }
    async expire(_key: string, _ttl: number) { return 1; }
    pipeline() {
      const self = this;
      return {
        del(k: string) { self.touch(k); return this; },
        rpush(k: string, _v: unknown) { self.touch(k); return this; },
        sadd(k: string, _v: unknown) { self.touch(k); return this; },
        expire(_k: string, _t: number) { return this; },
        async exec() { return []; },
      };
    }
    async quit() { return 'OK'; }
  }
  return { FakeRedis: FakeRedisInner };
});

vi.mock('ioredis', () => ({ default: FakeRedis }));

import { MemoryManager } from '../../src/lib/memory/memory';
import { InvalidConversationIdError } from '../../src/lib/conversation/conversation-id';

const BAD_IDS: unknown[] = [
  undefined,
  null,
  '',
  '   ',
  'undefined',
  'UNDEFINED',
  'null',
  'NaN',
  '{{state.data.options.conversationId}}',
  12345,
];

function undefinedKeys(): string[] {
  return fakeRedisState.touchedKeys.filter((k) => k.includes('undefined'));
}

describe('MemoryManager refuses unusable conversation ids', () => {
  let mm: MemoryManager;

  beforeEach(() => {
    fakeRedisState.touchedKeys.length = 0;
    mm = new MemoryManager('redis://localhost:6379');
  });

  test('reads throw without touching Redis', async () => {
    for (const bad of BAD_IDS) {
      const id = bad as string;
      await expect(mm.getMessages(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getAllMessagesFromDB(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getContextForConversation(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getContextSummary(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getTrailingSummary(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getExecutiveSummary(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getMetadata(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getContentToSummarize(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.needsSummaryGeneration(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.needsSummarization(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getTokenCount(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.getContextTokenCount(id)).rejects.toThrow(InvalidConversationIdError);
    }
    expect(undefinedKeys()).toEqual([]);
    expect(fakeRedisState.touchedKeys).toEqual([]);
  });

  test('writes throw without touching Redis', async () => {
    const msg = { role: 'user' as const, content: 'hi', timestamp: Date.now() };
    for (const bad of BAD_IDS) {
      const id = bad as string;
      await expect(mm.addMessage(id, { ...msg })).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.setTrailingSummary(id, 's')).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.setExecutiveSummary(id, 's')).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.trimAndSummarize(id)).rejects.toThrow(InvalidConversationIdError);
      await expect(mm.summarizeIfNeeded(id, async () => 's')).rejects.toThrow(
        InvalidConversationIdError,
      );
      await expect(mm.generateExecutiveSummary(id, async () => 's')).rejects.toThrow(
        InvalidConversationIdError,
      );
      await expect(mm.deleteConversation(id)).rejects.toThrow(InvalidConversationIdError);
    }
    expect(undefinedKeys()).toEqual([]);
    expect(fakeRedisState.touchedKeys).toEqual([]);
  });

  test('typed error carries INVALID_CONVERSATION_ID code', async () => {
    const err = await mm.getMessages(undefined as never).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidConversationIdError);
    expect((err as InvalidConversationIdError).code).toBe('INVALID_CONVERSATION_ID');
  });

  test('control: a usable id still builds the real key', async () => {
    await mm.getTrailingSummary('real-convo-123');
    expect(fakeRedisState.touchedKeys).toContain('conversations:real-convo-123:summary:trailing');
    expect(undefinedKeys()).toEqual([]);
  });
});
