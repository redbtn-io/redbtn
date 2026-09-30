/**
 * Error / fallback turns are persisted with `metadata.kind` and kept out of
 * prompt history.
 *
 * The bug: red-code's "Red Code stopped before calling the model: ..." reply
 * (a graph-declared error written through data.directResponse) and neuron
 * `fallbackValue` texts were stored as ordinary assistant turns, so
 * get_context_history fed them back and the model repeated the exact error
 * text, env id included, after the machine was fixed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mongo = vi.hoisted(() => ({
  updateOne: vi.fn(async (..._args: unknown[]) => ({ matchedCount: 1, modifiedCount: 1 })),
  findOne: vi.fn(async (..._args: unknown[]) => null as unknown),
}));

// The engine reaches Mongo via `require('mongoose')` (not an import vi.mock
// can intercept), so point the real module's connection at a fake db.
import mongoose from 'mongoose';
const fakeDb = {
  collection() {
    return { updateOne: mongo.updateOne, findOne: mongo.findOne };
  },
};
vi.spyOn(mongoose.connection, 'readyState', 'get').mockReturnValue(1 as any);
Object.defineProperty(mongoose.connection, 'db', { value: fakeDb, configurable: true, writable: true });

import {
  resolveResponseKind,
  storedMessageKind,
  errorTurnNote,
} from '../../src/lib/conversation/response-kind';
import { ConversationPublisher } from '../../src/lib/conversation/conversation-publisher';
import { MemoryManager } from '../../src/lib/memory/memory';

function mockRedis() {
  const published: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  return {
    published,
    publish: async (channel: string, payload: string) => {
      published.push({ channel, payload: JSON.parse(payload) });
      return 1;
    },
    rpush: async () => 1,
    expire: async () => 1,
    incr: async () => 1,
  };
}

/** Every `$set` / `$push` the publisher sent to user_conversations. */
function updates(): Array<Record<string, any>> {
  return mongo.updateOne.mock.calls.map((c) => c[1] as Record<string, any>);
}

describe('resolveResponseKind', () => {
  it('reads a graph-declared data.responseKind', () => {
    expect(resolveResponseKind({ responseKind: 'error', response: 'x' })).toBe('error');
    expect(resolveResponseKind({ responseKind: 'fallback' })).toBe('fallback');
    expect(resolveResponseKind({ responseKind: ' Error ' })).toBe('error');
  });

  it('infers fallback from a step error record on the response field', () => {
    const rec = { message: 'HTTP 401', code: 'auth', stepType: 'neuron', attempts: 1, at: '' };
    expect(resolveResponseKind({ response: 'fallback text', _stepErrors: { 'data.response': rec } })).toBe('fallback');
    expect(resolveResponseKind({ _stepErrors: { response: rec } })).toBe('fallback');
  });

  it('ignores records for other fields and cleared (undefined) records', () => {
    const rec = { message: 'x', code: null, stepType: 'tool', attempts: 1, at: '' };
    expect(resolveResponseKind({ response: 'ok', _stepErrors: { 'data.workspace': rec } })).toBeUndefined();
    expect(resolveResponseKind({ response: 'ok', _stepErrors: { 'data.response': undefined } })).toBeUndefined();
  });

  it("'normal' overrides an inferred kind; junk and empty values mark nothing", () => {
    const rec = { message: 'x', code: null, stepType: 'neuron', attempts: 1, at: '' };
    expect(resolveResponseKind({ responseKind: 'normal', _stepErrors: { 'data.response': rec } })).toBeUndefined();
    expect(resolveResponseKind({ responseKind: '' })).toBeUndefined();
    expect(resolveResponseKind({ responseKind: 'warning' })).toBeUndefined();
    expect(resolveResponseKind(undefined)).toBeUndefined();
    expect(resolveResponseKind([])).toBeUndefined();
  });

  it('storedMessageKind reads metadata.kind only', () => {
    expect(storedMessageKind({ metadata: { kind: 'error' } })).toBe('error');
    expect(storedMessageKind({ metadata: { kind: 'fallback' } })).toBe('fallback');
    expect(storedMessageKind({ metadata: { runError: 'Run interrupted' } })).toBeUndefined();
    expect(storedMessageKind({ metadata: { kind: 'other' } })).toBeUndefined();
    expect(storedMessageKind({})).toBeUndefined();
  });

  it('the stand-in note never carries the original text', () => {
    expect(errorTurnNote('error')).toMatch(/^\[.*omitted\.\]$/);
    expect(errorTurnNote('fallback')).toMatch(/fallback/);
  });
});

describe('ConversationPublisher persists the kind', () => {
  beforeEach(() => {
    mongo.updateOne.mockClear();
  });

  function publisher(redis = mockRedis()) {
    return new ConversationPublisher({ redis: redis as any, conversationId: 'conv-kind-1', userId: 'u1' });
  }

  it('run_complete with a responseKind: pushes metadata.kind, backfills it in place, and forwards it on the event', async () => {
    const redis = mockRedis();
    await publisher(redis).publishRunComplete('run-1', 'msg-1', 'Red Code stopped before calling the model: ...', [], undefined, undefined, 'error');

    const push = updates().find((u) => u.$push);
    expect(push!.$push.messages.metadata).toEqual({ runId: 'run-1', kind: 'error' });
    // In-place $set so the mark lands even when the archiver wrote the row first.
    expect(updates().some((u) => u.$set?.['messages.$.metadata.kind'] === 'error')).toBe(true);
    const event = redis.published.map((p) => p.payload).find((p) => p.type === 'run_complete');
    expect(event?.responseKind).toBe('error');
  });

  it('a normal completion writes no kind anywhere', async () => {
    const redis = mockRedis();
    await publisher(redis).publishRunComplete('run-2', 'msg-2', 'a real answer', []);
    const push = updates().find((u) => u.$push);
    expect(push!.$push.messages.metadata).toEqual({ runId: 'run-2' });
    expect(updates().some((u) => u.$set && 'messages.$.metadata.kind' in u.$set)).toBe(false);
    const event = redis.published.map((p) => p.payload).find((p) => p.type === 'run_complete');
    expect(event && 'responseKind' in event).toBe(false);
  });

  it('a failed run is marked error; an interrupted one is not', async () => {
    await publisher().publishRunError('run-3', 'msg-3', 'boom', [], undefined, true);
    const failed = updates().find((u) => u.$push);
    expect(failed!.$push.messages.metadata).toMatchObject({ runError: 'boom', kind: 'error' });

    mongo.updateOne.mockClear();
    await publisher().publishRunError('run-4', 'msg-4', 'Run interrupted', [], 'agent-1');
    const interrupted = updates().find((u) => u.$push);
    expect(interrupted!.$push.messages.metadata.kind).toBeUndefined();
    expect(updates().some((u) => u.$set && 'messages.$.metadata.kind' in u.$set)).toBe(false);
  });
});

describe('MemoryManager keeps error turns out of context', () => {
  function manager(): MemoryManager {
    const mm = Object.create(MemoryManager.prototype) as any;
    mm.MAX_CONTEXT_TOKENS = 30000;
    mm.REDIS_MESSAGE_LIMIT = 100;
    mm.MESSAGE_ID_INDEX_TTL = 60;
    mm.redis = {
      pipeline: () => ({ del() {}, rpush() {}, sadd() {}, expire() {}, exec: async () => [] }),
      lrange: async () => [],
    };
    mm.countMessageTokens = async () => 10;
    return mm as MemoryManager;
  }

  const stored = [
    { id: 'm1', role: 'user', content: 'fix the tests', timestamp: 1 },
    {
      id: 'm2',
      role: 'assistant',
      content: 'Red Code stopped before calling the model: ... (environment env_abc)',
      metadata: { runId: 'r1', kind: 'error' },
      timestamp: 2,
    },
    { id: 'm3', role: 'user', content: 'try again', timestamp: 3 },
    { id: 'm4', role: 'assistant', content: 'Red Code could not get a reply from its model.', metadata: { kind: 'fallback' }, timestamp: 4 },
    { id: 'm5', role: 'user', content: 'and now?', timestamp: 5 },
    { id: 'm6', role: 'assistant', content: 'All 12 tests pass.', metadata: { runId: 'r3' }, timestamp: 6 },
  ];

  beforeEach(() => {
    mongo.findOne.mockResolvedValue({ messages: stored });
  });

  it('getMessages carries the stored kind', async () => {
    const msgs = await manager().getMessages('conv-kind-1');
    expect(msgs.map((m) => m.kind)).toEqual([undefined, 'error', undefined, 'fallback', undefined, undefined]);
  });

  it('getContextForConversation omits error/fallback turns by default', async () => {
    const msgs = await manager().getContextForConversation('conv-kind-1');
    expect(msgs.map((m) => m.id)).toEqual(['m1', 'm3', 'm5', 'm6']);
    expect(msgs.some((m) => /stopped before calling/.test(m.content))).toBe(false);
  });

  it('includeErrorTurns opts back in', async () => {
    const msgs = await manager().getContextForConversation('conv-kind-1', { includeErrorTurns: true });
    expect(msgs).toHaveLength(6);
  });
});
