import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunKeys } from '../../src/lib/run/types';

let capturedSubscriberOpts: {
  terminalEvents: string[];
  isAlive: () => Promise<boolean>;
} | null = null;

vi.mock('@redbtn/redstream', async () => {
  const actual = await vi.importActual<any>('@redbtn/redstream');
  return {
    ...actual,
    StreamSubscriber: class {
      subscribe(opts: { terminalEvents: string[]; isAlive: () => Promise<boolean> }) {
        capturedSubscriberOpts = {
          terminalEvents: opts.terminalEvents,
          isAlive: opts.isAlive,
        };
        return {
          [Symbol.asyncIterator]: async function* () {
            return;
          },
          return: async () => ({ done: true, value: undefined }),
        } as AsyncGenerator;
      }
    },
  };
});

import { RunPublisher } from '../../src/lib/run/run-publisher';

function makeRedis(runState?: Record<string, unknown>) {
  const values = new Map<string, string>();
  if (runState) {
    const runId = String(runState.runId);
    values.set(RunKeys.state(runId), JSON.stringify(runState));
  }
  return {
    values,
    redis: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
    },
  };
}

describe('RunPublisher.subscribe', () => {
  beforeEach(() => {
    capturedSubscriberOpts = null;
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
  });

  afterEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
    vi.restoreAllMocks();
  });

  it('treats interrupted as terminal (including run_interrupted terminal event)', async () => {
    const runId = 'run-subscribe-terminal';
    const interruptedState = {
      runId,
      userId: 'user-1',
      graphId: 'graph-1',
      graphName: 'Graph',
      status: 'interrupted',
      startedAt: Date.now() - 1000,
      completedAt: Date.now(),
      input: {},
      output: { content: '', thinking: '', data: {} },
      graph: { executionPath: [], nodesExecuted: 0, nodeProgress: {} },
      tools: [],
    };
    const { redis, values } = makeRedis(interruptedState);
    const publisher = new RunPublisher({ redis: redis as any, runId, userId: 'user-1' });
    (publisher as any).initialized = true;
    (publisher as any).state = interruptedState;

    publisher.subscribe();

    expect(capturedSubscriberOpts).not.toBeNull();
    expect(capturedSubscriberOpts!.terminalEvents).toContain('run_interrupted');
    await expect(capturedSubscriberOpts!.isAlive()).resolves.toBe(false);
  });
});
