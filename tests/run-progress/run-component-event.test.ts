/**
 * Phase 10 — engine-side helpers for the live in-run interaction channel.
 *
 * Locks in:
 *   - `RunKeys.componentEvent` + `RunKeys.componentEventsInbox` channel/list
 *     conventions (the engine ↔ webapp contract).
 *   - `publishRunComponentEvent` RPUSHes into the inbox AND PUBLISHes to the
 *     channel — both happen, both keep the run-state TTL invariant.
 *   - `drainRunComponentEvents` returns the queued payloads in order,
 *     deletes the list (drain semantics) by default, and honours
 *     `peek: true` for non-destructive reads.
 *   - Empty inbox returns `[]` (no errors).
 *   - Malformed list entries are filtered (defensive against external
 *     producers).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  publishRunComponentEvent,
  drainRunComponentEvents,
  type ComponentInteractionEvent,
} from '../../src/lib/run/run-publisher';
import { RunKeys } from '../../src/lib/run/types';

function makeRedis() {
  const lists = new Map<string, string[]>();
  const expires = new Map<string, number>();
  const publishes: Array<{ channel: string; message: string }> = [];

  const redis = {
    rpush: vi.fn(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    }),
    expire: vi.fn(async (key: string, seconds: number) => {
      expires.set(key, seconds);
      return 1;
    }),
    publish: vi.fn(async (channel: string, message: string) => {
      publishes.push({ channel, message });
      return 3;
    }),
    lrange: vi.fn(async (key: string) => lists.get(key) ?? []),
    del: vi.fn(async (key: string) => {
      const had = lists.delete(key) ? 1 : 0;
      return had;
    }),
  };
  return { redis, lists, expires, publishes };
}

function event(overrides: Partial<ComponentInteractionEvent> = {}): ComponentInteractionEvent {
  return {
    componentId: 'cmp_x',
    messageId: 'msg_y',
    payload: { picked: 'yes' },
    userId: 'user-1',
    timestamp: '2026-05-27T00:00:00.000Z',
    ...overrides,
  };
}

describe('RunKeys.componentEvent / componentEventsInbox channel conventions', () => {
  it('uses `run:component-event:{runId}` for the pub/sub channel', () => {
    expect(RunKeys.componentEvent('run-1')).toBe('run:component-event:run-1');
  });
  it('uses `run:component-events:{runId}` for the buffered inbox list (plural)', () => {
    expect(RunKeys.componentEventsInbox('run-1')).toBe('run:component-events:run-1');
    // Distinct from the channel — single vs plural — so SUBSCRIBE on the
    // channel doesn't accidentally match the LIST key.
    expect(RunKeys.componentEvent('run-1')).not.toBe(RunKeys.componentEventsInbox('run-1'));
  });
});

describe('publishRunComponentEvent', () => {
  it('RPUSHes onto the inbox and PUBLISHes to the channel', async () => {
    const { redis, lists, publishes } = makeRedis();
    const subscribers = await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event());
    expect(subscribers).toBe(3);

    const inbox = lists.get('run:component-events:run-1');
    expect(inbox).toBeDefined();
    expect(inbox).toHaveLength(1);
    expect(JSON.parse(inbox![0])).toMatchObject({ componentId: 'cmp_x' });

    expect(publishes).toHaveLength(1);
    expect(publishes[0].channel).toBe('run:component-event:run-1');
    expect(JSON.parse(publishes[0].message).componentId).toBe('cmp_x');
  });

  it('sets the inbox TTL on first append, leaves it on subsequent appends', async () => {
    const { redis, expires } = makeRedis();
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_1' }));
    expect(expires.get('run:component-events:run-1')).toBeDefined();
    expect(redis.expire).toHaveBeenCalledTimes(1);

    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_2' }));
    expect(redis.expire).toHaveBeenCalledTimes(1); // not re-set
  });

  it('returns 0 subscribers when PUBLISH throws', async () => {
    const { redis } = makeRedis();
    redis.publish.mockRejectedValueOnce(new Error('boom'));
    const res = await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event());
    expect(res).toBe(0);
  });

  it('still attempts PUBLISH even if RPUSH fails', async () => {
    const { redis } = makeRedis();
    redis.rpush.mockRejectedValueOnce(new Error('rpush down'));
    const res = await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event());
    expect(redis.publish).toHaveBeenCalledTimes(1);
    expect(res).toBe(3);
  });
});

describe('drainRunComponentEvents', () => {
  it('returns an empty array when nothing is queued', async () => {
    const { redis } = makeRedis();
    const out = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1');
    expect(out).toEqual([]);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('returns queued events in order and deletes the list (drain semantics)', async () => {
    const { redis, lists } = makeRedis();
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_a' }));
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_b' }));
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_c' }));

    const out = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1');
    expect(out.map((e) => e.componentId)).toEqual(['cmp_a', 'cmp_b', 'cmp_c']);
    // Drained — list cleared.
    expect(lists.get('run:component-events:run-1')).toBeUndefined();
    // Second drain returns empty.
    const again = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1');
    expect(again).toEqual([]);
  });

  it('peek:true returns events but leaves the list intact', async () => {
    const { redis, lists } = makeRedis();
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_a' }));
    await publishRunComponentEvent(redis as unknown as Parameters<typeof publishRunComponentEvent>[0], 'run-1', event({ componentId: 'cmp_b' }));

    const peeked = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1', { peek: true });
    expect(peeked.map((e) => e.componentId)).toEqual(['cmp_a', 'cmp_b']);
    expect(lists.get('run:component-events:run-1')).toBeDefined();
    expect(lists.get('run:component-events:run-1')).toHaveLength(2);
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('filters malformed JSON entries (defensive against rogue producers)', async () => {
    const { redis, lists } = makeRedis();
    lists.set('run:component-events:run-1', [
      JSON.stringify(event({ componentId: 'cmp_ok' })),
      'this is not json {',
      JSON.stringify(event({ componentId: 'cmp_also_ok' })),
    ]);
    const out = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1');
    expect(out.map((e) => e.componentId)).toEqual(['cmp_ok', 'cmp_also_ok']);
  });

  it('survives LRANGE failure without throwing', async () => {
    const { redis } = makeRedis();
    redis.lrange.mockRejectedValueOnce(new Error('lrange down'));
    const out = await drainRunComponentEvents(redis as unknown as Parameters<typeof drainRunComponentEvents>[0], 'run-1');
    expect(out).toEqual([]);
  });
});
