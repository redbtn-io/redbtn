import { describe, expect, it, vi } from 'vitest';

/**
 * executeStreaming must publish a streamed reply exactly once.
 *
 * Tokens from the respond node wait in an 8-char look-ahead buffer (so <think>
 * tags are never split). A reply of <= 8 chars is still entirely buffered at
 * on_chain_end, where the "response nobody streamed" fallback used to test only
 * `!fullContent`, published the response, and then the post-loop drain
 * published the buffered copy again: "4417" was stored as "44174417".
 */

vi.mock('mongoose', () => ({
  models: {},
  Schema: class Schema {},
  model: () => ({ findById: () => ({ lean: async () => null }) }),
}));
vi.mock('../../src/lib/graphs/MongoCheckpointer', () => ({
  createMongoCheckpointer: () => ({ getTuple: vi.fn(async () => null) }),
}));
class FakeIORedis {
  subscribe = vi.fn(async () => 1);
  unsubscribe = vi.fn(async () => 1);
  quit = vi.fn(async () => undefined);
  publish = vi.fn(async () => 1);
  on = vi.fn(() => this);
}
vi.mock('ioredis', () => ({ default: FakeIORedis }));

function fakePublisher() {
  const chunks: string[] = [];
  const thinking: string[] = [];
  let status = 'running';
  let completed: { content: string } | null = null;
  const publisher = {
    id: 'run_test',
    user: 'u1',
    chunk: vi.fn(async (c: string) => { chunks.push(c); }),
    thinkingChunk: vi.fn(async (c: string) => { thinking.push(c); }),
    thinkingComplete: vi.fn(async () => undefined),
    // Mirrors RunPublisher: output.content is the accumulation of chunk() calls.
    getCachedState: () => ({ status, output: { content: chunks.join(''), thinking: thinking.join('') } }),
    complete: vi.fn(async (out: { content: string }) => { completed = out; status = 'completed'; }),
    fail: vi.fn(async () => { status = 'error'; }),
    interrupt: vi.fn(async () => { status = 'interrupted'; }),
    getState: vi.fn(async () => ({ graphId: 'red-chat', graphName: 'Red Chat', startedAt: 1, completedAt: 2, graph: { nodesExecuted: 2, executionPath: [], nodeProgress: {} } })),
  };
  return { publisher, chunks, thinking, get completed() { return completed; } };
}

function graphStreaming(tokens: string[], response: string) {
  return {
    config: {},
    graph: {
      async *streamEvents() {
        for (const t of tokens) {
          yield { event: 'on_llm_stream', metadata: { langgraph_node: 'respond' }, data: { chunk: { content: t } } };
        }
        yield { event: 'on_chain_end', name: 'LangGraph', data: { output: { data: { response } } } };
      },
    },
  };
}

const initialState = { data: { conversationId: 'c1', options: {} } };
const settings = { defaultNeuronId: 'red-neuron' } as any;

async function runWith(tokens: string[], response: string) {
  const { __test__ } = await import('../../src/functions/run');
  const fp = fakePublisher();
  const result = await __test__.executeStreaming({} as any, graphStreaming(tokens, response), initialState, fp.publisher as any, settings);
  return { fp, result };
}

describe('executeStreaming publishes a streamed reply once', () => {
  it.each([
    ['4417', ['4417']],
    ['lock ok', ['lock', ' ok']],
    ['12345678', ['12345678']],
  ])('short reply %j streamed in %j', async (text, tokens) => {
    const { fp, result } = await runWith(tokens as string[], text);
    expect(fp.chunks.join('')).toBe(text);
    expect(result.content).toBe(text);
    expect(fp.completed?.content).toBe(text);
  });

  it('a longer streamed reply is unchanged', async () => {
    const text = 'dup check, and a bit more';
    const { fp, result } = await runWith(['dup ', 'check, and', ' a bit more'], text);
    expect(fp.chunks.join('')).toBe(text);
    expect(result.content).toBe(text);
  });

  it('a response that was never streamed is still published once via the fallback', async () => {
    const { fp, result } = await runWith([], 'ok');
    expect(fp.chunks.join('')).toBe('ok');
    expect(result.content).toBe('ok');
  });

  it('a short reply after a streamed think block is not duplicated', async () => {
    const { fp, result } = await runWith(['<think>hmm</think>', 'yes'], '<think>hmm</think>yes');
    expect(fp.chunks.join('')).toBe('yes');
    expect(fp.thinking.join('')).toBe('hmm');
    expect(result.content).toBe('yes');
  });
});
