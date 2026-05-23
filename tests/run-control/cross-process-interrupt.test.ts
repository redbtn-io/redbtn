import { afterEach, describe, expect, it, vi } from 'vitest';

const redisMocks = vi.hoisted(() => {
  type Handler = (channel: string, payload: string) => void | Promise<void>;
  const subscribers = new Map<string, Set<FakeRedis>>();
  const published: Array<{ channel: string; payload: string }> = [];
  const instances: FakeRedis[] = [];

  class FakeRedis {
    readonly url: string;
    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Handler>();
    readonly subscriptions = new Set<string>();

    constructor(url: string, options: Record<string, unknown>) {
      this.url = url;
      this.options = options;
      instances.push(this);
    }

    async subscribe(channel: string): Promise<number> {
      let channelSubscribers = subscribers.get(channel);
      if (!channelSubscribers) {
        channelSubscribers = new Set();
        subscribers.set(channel, channelSubscribers);
      }
      channelSubscribers.add(this);
      this.subscriptions.add(channel);
      return channelSubscribers.size;
    }

    on(event: string, handler: Handler): this {
      this.handlers.set(event, handler);
      return this;
    }

    async publish(channel: string, payload: string): Promise<number> {
      published.push({ channel, payload });
      const channelSubscribers = subscribers.get(channel);
      if (!channelSubscribers) return 0;
      for (const subscriber of channelSubscribers) {
        subscriber.handlers.get('message')?.(channel, payload);
      }
      return channelSubscribers.size;
    }

    async rpush(): Promise<number> { return 1; }
    async expire(): Promise<number> { return 1; }

    async unsubscribe(channel: string): Promise<number> {
      subscribers.get(channel)?.delete(this);
      this.subscriptions.delete(channel);
      return subscribers.get(channel)?.size ?? 0;
    }

    async quit(): Promise<string> {
      for (const channel of this.subscriptions) {
        subscribers.get(channel)?.delete(this);
      }
      this.subscriptions.clear();
      return 'OK';
    }
  }

  return {
    FakeRedis,
    instances,
    published,
    reset: () => {
      subscribers.clear();
      instances.length = 0;
      published.length = 0;
    },
  };
});

describe('cross-process run interrupt pub/sub', () => {
  afterEach(async () => {
    const { runControlRegistry } = await import('../../src/lib/run/RunControlRegistry');
    for (const runId of runControlRegistry.runIds()) {
      runControlRegistry.unregister(runId);
    }
    redisMocks.reset();
  });

  it('publishes from one process and cancels the RunControlRegistry context owned by another', async () => {
    const { __test__ } = await import('../../src/functions/run');
    const { publishRunInterrupt, RunKeys } = await import('../../src/lib/run');
    const { runControlRegistry } = await import('../../src/lib/run/RunControlRegistry');

    const runId = 'run-cross-process-force-fail';
    const reason = 'automationrun-status:failed';
    const ctx = runControlRegistry.register(runId, 'target-worker');
    runControlRegistry.setCurrentStep(runId, 'node-a', { type: 'tool', index: 3 });
    const legacyController = new AbortController();
    const eventsRedis = new redisMocks.FakeRedis('redis://events', {});

    const subscriber = await __test__.subscribeForInterrupt(
      runId,
      legacyController,
      eventsRedis,
      redisMocks.FakeRedis as any,
    );
    const remoteRedis = new redisMocks.FakeRedis('redis://remote-worker', {});
    const delivered = await publishRunInterrupt(remoteRedis as any, runId, reason);
    await new Promise((resolve) => setImmediate(resolve));

    expect(delivered).toBe(1);
    expect(ctx.controller.signal.aborted).toBe(true);
    expect((ctx.controller.signal.reason as any)?.reason).toBe(reason);
    expect(legacyController.signal.aborted).toBe(true);
    expect((legacyController.signal.reason as any)?.reason).toBe(reason);

    const ack = redisMocks.published.find((entry) => entry.channel === RunKeys.interruptAck(runId));
    expect(ack).toBeDefined();
    expect(JSON.parse(ack!.payload)).toMatchObject({
      ack: true,
      runId,
      reason,
      workerId: 'target-worker',
      currentNodeId: 'node-a',
      currentStep: { type: 'tool', index: 3 },
    });

    await subscriber.quit();
  });
});
