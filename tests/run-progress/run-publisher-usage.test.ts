import { describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';

function makeRedis() {
  const values = new Map<string, string>();
  const published: Array<Record<string, unknown>> = [];

  const redis = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) values.delete(key);
      return keys.length;
    }),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const pipeline = {
        rpush: vi.fn((_key: string, value: string) => {
          ops.push(() => published.push(JSON.parse(value)));
          return pipeline;
        }),
        expire: vi.fn(() => pipeline),
        publish: vi.fn(() => pipeline),
        exec: vi.fn(async () => {
          ops.forEach((op) => op());
          return [];
        }),
      };
      return pipeline;
    }),
  };

  return { redis, published, values };
}

describe('RunPublisher usage tracking', () => {
  it('accumulates usage samples and publishes usage on run_complete', async () => {
    const { redis, published, values } = makeRedis();
    const publisher = new RunPublisher({
      runId: 'run_usage_test_1',
      userId: 'usr_test',
      redis: redis as any,
    });

    await publisher.init('graph_test', 'Graph Test', {});

    publisher.recordUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      model: 'anthropic/claude-3-5-sonnet',
    });

    publisher.recordUsage({
      inputTokens: 200,
      outputTokens: 75,
      totalTokens: 275,
      model: 'anthropic/claude-3-5-sonnet',
      cacheReadInputTokens: 50,
    });

    await publisher.complete({ content: 'Hello' });

    const completeEvent = published.find((e) => e.type === 'run_complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.usage).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      totalTokens: 425,
      model: 'anthropic/claude-3-5-sonnet',
      cacheReadInputTokens: 50,
    });

    // Check state persisted in Redis
    const stateJson = values.get('run:run_usage_test_1');
    expect(stateJson).toBeDefined();
    const state = JSON.parse(stateJson!);
    expect(state.usage).toEqual({
      inputTokens: 300,
      outputTokens: 125,
      totalTokens: 425,
      model: 'anthropic/claude-3-5-sonnet',
      cacheReadInputTokens: 50,
    });
    expect(state.metadata?.tokens).toEqual({
      input: 300,
      output: 125,
      total: 425,
    });
  });

  it('extracts fallback usage from finalState._cli when not recorded incrementally', async () => {
    const { redis, published } = makeRedis();
    const publisher = new RunPublisher({
      runId: 'run_usage_fallback_cli',
      userId: 'usr_test',
      redis: redis as any,
    });

    await publisher.init('graph_test', 'Graph Test', {});

    await publisher.complete(
      { content: 'Done' },
      {
        data: {
          _cli: {
            step1: {
              model: 'opencode/gemini-2.5-pro',
              usage: { prompt_tokens: 500, completion_tokens: 120, total_tokens: 620 },
            },
          },
        },
      },
    );

    const completeEvent = published.find((e) => e.type === 'run_complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.usage).toEqual({
      inputTokens: 500,
      outputTokens: 120,
      totalTokens: 620,
      model: 'opencode/gemini-2.5-pro',
    });
  });
});
