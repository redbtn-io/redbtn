/**
 * Phase 2 of `chat-interactive-widgets` — locks in `RunPublisher.publishComponent`:
 *
 *   (a) a valid spec is published to the run stream AND forwarded to the
 *       conversation stream with `type: 'component'`;
 *   (b) an invalid spec throws `ChatComponentSpecValidationError` and emits
 *       nothing — neither run stream nor conversation stream sees the bad spec;
 *   (c) the assembled event survives a JSON round-trip (no circular refs, all
 *       fields preserved).
 *
 * Uses the same in-memory Redis mock as `run-publisher-heartbeat.test.ts` so
 * BullMQ archive and StreamPublisher writes route through the captured
 * `published` array.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';
import { ChatComponentSpecValidationError } from '../../src/lib/chat-components/spec-schema';

interface PublishedMsg {
  channel: string;
  message: string;
}

function makeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const published: PublishedMsg[] = [];
  const counters = new Map<string, number>();

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
    // ConversationPublisher uses redis.publish / rpush directly (NOT through pipeline)
    // — see conversation-publisher.ts:514. The run-archive path uses pipeline.
    publish: vi.fn(async (channel: string, message: string) => {
      published.push({ channel, message });
      return 1;
    }),
    rpush: vi.fn(async (key: string, value: string) => {
      const list = lists.get(key) ?? [];
      list.push(value);
      lists.set(key, list);
      return list.length;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipeline = {
        rpush: vi.fn((key: string, value: string) => {
          ops.push(() => {
            const list = lists.get(key) ?? [];
            list.push(value);
            lists.set(key, list);
          });
          return pipeline;
        }),
        expire: vi.fn(() => pipeline),
        publish: vi.fn((channel: string, message: string) => {
          ops.push(() => published.push({ channel, message }));
          return pipeline;
        }),
        exec: vi.fn(async () => {
          ops.forEach((op) => op());
          return [];
        }),
      };
      return pipeline;
    }),
  };

  return { redis, values, lists, published };
}

describe('RunPublisher.publishComponent — chat-interactive-widgets phase 2', () => {
  const originalArchiveDisabled = process.env.ARCHIVE_QUEUE_DISABLED;

  beforeEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-27T00:00:00.000Z'));
  });

  afterEach(() => {
    if (originalArchiveDisabled === undefined) delete process.env.ARCHIVE_QUEUE_DISABLED;
    else process.env.ARCHIVE_QUEUE_DISABLED = originalArchiveDisabled;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('publishes a valid spec to the run stream and forwards to the conversation stream', async () => {
    const { redis, published } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-1',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {}, 'conv-1');

    published.length = 0; // ignore run_start

    await publisher.publishComponent({
      componentId: 'cmp_abc',
      type: 'button-group',
      config: { buttons: [{ label: 'Yes' }, { label: 'No' }] },
    });
    // The conversation forward is fire-and-forget (matches publishAttachment's
    // pattern at run-publisher.ts:844). Drain microtasks so its publish lands.
    await vi.runAllTimersAsync();
    await Promise.resolve();
    await Promise.resolve();

    const runStreamMsgs = published.filter((p) => p.channel.startsWith('run:stream:'));
    const convStreamMsgs = published.filter((p) => p.channel.startsWith('conversation:stream:'));

    expect(runStreamMsgs.length).toBeGreaterThanOrEqual(1);
    const runEvt = JSON.parse(runStreamMsgs[0].message);
    expect(runEvt.type).toBe('component');
    expect(runEvt.componentId).toBe('cmp_abc');
    expect(runEvt.runId).toBe('run-cmp-1');
    expect(runEvt.messageId).toMatch(/^msg_/);
    expect(runEvt.spec.type).toBe('button-group');
    expect(runEvt.spec.surfaces).toEqual(['chat']);
    expect(runEvt.spec.runId).toBe('run-cmp-1');
    expect(runEvt.spec.emittedAt).toBe('2026-05-27T00:00:00.000Z');

    expect(convStreamMsgs.length).toBeGreaterThanOrEqual(1);
    const convEvt = JSON.parse(convStreamMsgs[convStreamMsgs.length - 1].message);
    expect(convEvt.type).toBe('component');
    expect(convEvt.componentId).toBe('cmp_abc');
    expect(convEvt.runId).toBe('run-cmp-1');
    expect(convEvt.messageId).toMatch(/^msg_/);
    expect(convEvt.spec.type).toBe('button-group');
  });

  it('throws ChatComponentSpecValidationError on an invalid spec and emits nothing', async () => {
    const { redis, published } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-bad',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {}, 'conv-bad');

    const beforeCount = published.length;

    await expect(
      publisher.publishComponent({
        // missing componentId — schema invalid
        type: 'button-group',
        config: { buttons: [] },
      }),
    ).rejects.toBeInstanceOf(ChatComponentSpecValidationError);

    // Nothing new on either channel — no `type: 'component'` event ever published.
    const after = published.slice(beforeCount);
    const componentEvents = after.filter((p) => {
      try {
        return JSON.parse(p.message).type === 'component';
      } catch {
        return false;
      }
    });
    expect(componentEvents).toHaveLength(0);
  });

  it('rejects an unknown spec.type without publishing', async () => {
    const { redis, published } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-unknown',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {}, 'conv-unknown');
    const beforeCount = published.length;

    await expect(
      publisher.publishComponent({
        componentId: 'cmp_oops',
        type: 'evil-widget',
        config: {},
      }),
    ).rejects.toBeInstanceOf(ChatComponentSpecValidationError);

    const after = published.slice(beforeCount);
    const componentEvents = after.filter((p) => {
      try {
        return JSON.parse(p.message).type === 'component';
      } catch {
        return false;
      }
    });
    expect(componentEvents).toHaveLength(0);
  });

  it('rejects a followup spec missing required text', async () => {
    const { redis } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-fup',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {}, 'conv-fup');

    await expect(
      publisher.publishComponent({
        componentId: 'cmp_fup',
        type: 'button-group',
        config: { buttons: [] },
        interaction: { channel: 'followup' },
      }),
    ).rejects.toBeInstanceOf(ChatComponentSpecValidationError);
  });

  it('published event survives JSON round-trip with all fields intact', async () => {
    const { redis, published } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-rt',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {}, 'conv-rt');
    published.length = 0;

    const inputSpec = {
      componentId: 'cmp_rt',
      type: 'form' as const,
      config: {
        fields: [
          { id: 'name', kind: 'text-input', label: 'Name' },
          { id: 'opt', kind: 'switch', label: 'Opt in' },
        ],
      },
      interaction: {
        channel: 'state-write' as const,
        namespace: 'user-prefs',
        key: 'profile',
        path: '/name',
        label: 'Save',
      },
    };

    await publisher.publishComponent(inputSpec);

    const runStreamMsgs = published.filter((p) => p.channel.startsWith('run:stream:'));
    expect(runStreamMsgs.length).toBeGreaterThanOrEqual(1);
    const raw = runStreamMsgs[0].message;
    const parsed = JSON.parse(raw);

    // Round-trip: serialize → parse → re-serialize → parse — same output.
    const reparsed = JSON.parse(JSON.stringify(parsed));
    expect(reparsed).toEqual(parsed);

    // All input fields survived. The engine-injected fields (surfaces, runId,
    // emittedAt) are on `spec`. The top-level `messageId` is auto-injected.
    expect(parsed.type).toBe('component');
    expect(parsed.componentId).toBe('cmp_rt');
    expect(parsed.runId).toBe('run-cmp-rt');
    expect(parsed.spec.componentId).toBe('cmp_rt');
    expect(parsed.spec.type).toBe('form');
    expect(parsed.spec.config).toEqual(inputSpec.config);
    expect(parsed.spec.interaction).toEqual(inputSpec.interaction);
    expect(parsed.spec.surfaces).toEqual(['chat']);
    expect(parsed.spec.runId).toBe('run-cmp-rt');
    expect(parsed.spec.emittedAt).toBe('2026-05-27T00:00:00.000Z');
  });

  it('counts component events as forward progress for the heartbeat', async () => {
    const { redis, values } = makeRedis();
    const publisher = new RunPublisher({
      redis: redis as any,
      runId: 'run-cmp-progress',
      userId: 'user-1',
    });
    await publisher.init('graph-1', 'Graph 1', {});
    const stateKey = `run:run-cmp-progress`;
    expect(JSON.parse(values.get(stateKey)!).lastProgressAt).toBe('2026-05-27T00:00:00.000Z');

    vi.setSystemTime(new Date('2026-05-27T00:00:30.000Z'));
    await publisher.publishComponent({
      componentId: 'cmp_p1',
      type: 'info-panel',
      config: { title: 'Hi' },
    });
    expect(JSON.parse(values.get(stateKey)!).lastProgressAt).toBe('2026-05-27T00:00:30.000Z');
  });
});
