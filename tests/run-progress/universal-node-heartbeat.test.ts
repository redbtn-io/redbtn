import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';
import { RunKeys } from '../../src/lib/run/types';
import { universalNode } from '../../src/lib/nodes/universal/universalNode';

function makeRedis() {
  const values = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const published: Array<{ channel: string; message: string }> = [];

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    hgetall: vi.fn(async () => ({})),
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

function getRunEvents(lists: Map<string, string[]>, runId: string) {
  return (lists.get(RunKeys.events(runId)) ?? []).map((item) => JSON.parse(item));
}

async function makePublisher(runId: string, automationRunsCollection: { updateOne: ReturnType<typeof vi.fn> }) {
  const { redis, values, lists } = makeRedis();
  const publisher = new RunPublisher({
    redis: redis as any,
    runId,
    userId: 'user-1',
    automationRunId: runId,
    automationRunsCollection,
  });
  await publisher.init('graph-1', 'Graph 1', {});
  return { publisher, redis, values, lists };
}

describe('universalNode progress heartbeat', () => {
  const originalArchiveDisabled = process.env.ARCHIVE_QUEUE_DISABLED;

  beforeEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalArchiveDisabled === undefined) delete process.env.ARCHIVE_QUEUE_DISABLED;
    else process.env.ARCHIVE_QUEUE_DISABLED = originalArchiveDisabled;
    vi.restoreAllMocks();
  });

  it('heartbeats on node start, each sequential step start/complete, and node complete', async () => {
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const { publisher, values, lists } = await makePublisher('run-universal-sequential', automationRunsCollection);

    const result = await universalNode({
      runId: 'run-universal-sequential',
      runPublisher: publisher,
      nodeCounter: 1,
      nodeConfig: {
        graphNodeId: 'graph-node-1',
        nodeId: 'test-node',
        name: 'Test Node',
        steps: [
          { type: 'delay', config: { ms: 0 } },
          { type: 'delay', config: { ms: 0 } },
        ],
      },
    });

    expect(result).toEqual({ nodeCounter: 2 });
    expect(automationRunsCollection.updateOne).toHaveBeenCalledTimes(6);
    expect(JSON.parse(values.get(RunKeys.state('run-universal-sequential'))!).lastProgressAt).toBeTruthy();

    const nodeProgressEvents = getRunEvents(lists, 'run-universal-sequential').filter((event) => event.type === 'node_progress');
    expect(nodeProgressEvents.map((event) => event.data?.phase)).toEqual([
      'start',
      'complete',
      'start',
      'complete',
    ]);
  });

  it('heartbeats skipped conditional step start/complete without adding state output', async () => {
    const automationRunsCollection = {
      updateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
    };
    const { publisher, lists } = await makePublisher('run-universal-skipped', automationRunsCollection);

    const result = await universalNode({
      runId: 'run-universal-skipped',
      runPublisher: publisher,
      nodeCounter: 1,
      nodeConfig: {
        graphNodeId: 'graph-node-2',
        nodeId: 'test-node',
        name: 'Test Node',
        parameters: { shouldRun: false },
        steps: [
          {
            type: 'delay',
            condition: '{{parameters.shouldRun}}',
            config: { ms: 0 },
          },
        ],
      },
    });

    expect(result).toEqual({ nodeCounter: 2 });
    expect(automationRunsCollection.updateOne).toHaveBeenCalledTimes(4);

    const nodeProgressEvents = getRunEvents(lists, 'run-universal-skipped').filter((event) => event.type === 'node_progress');
    expect(nodeProgressEvents).toHaveLength(2);
    expect(nodeProgressEvents.map((event) => event.data?.phase)).toEqual(['start', 'complete']);
    expect(nodeProgressEvents[1].data?.updatedFields).toEqual([]);
  });
});
