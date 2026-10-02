/**
 * Native tool loop — OpenAI-compatible prompt caching, on the wire.
 *
 * OpenRouter / OpenAI cache implicitly, but only per replica: a turn reads the
 * previous turn's cache only if (a) its prompt is a byte-for-byte extension of
 * the previous prompt and (b) it lands on the same replica, which is what
 * `prompt_cache_key` routes. Measured 2026-10-02 on Meta Muse Spark via
 * OpenRouter: without the key the native loop read ~0% from cache.
 *
 * These tests drive the REAL request builder (`NeuronRegistry.createModel` ->
 * `ChatOpenAI`) through `runNativeToolUseLoop` against a fake `fetch`, and
 * assert on the HTTP bodies that would leave the worker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNativeToolUseLoop } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import { NeuronRegistry } from '../../src/lib/neurons/NeuronRegistry';
import type { ResolvedTool } from '../../src/lib/tools/tool-resolver';
import { derivePromptCacheKey } from '../../src/lib/neurons/prompt-cache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const SYSTEM = 'You are the card executor. Work in the workspace.\n' + 'Rules. '.repeat(200);
const USER = '# NP-162 Send feedback from native Settings\n' + 'Card body. '.repeat(200);

function completion(turn: number, body: Any) {
  // Turns 1-3 call tools (the 2nd with two parallel calls); turn 4 answers.
  const base = {
    id: `gen-test-${turn}`,
    object: 'chat.completion',
    created: 1790950000 + turn,
    model: body.model,
    usage: {
      prompt_tokens: 1000 * turn,
      completion_tokens: 50,
      total_tokens: 1000 * turn + 50,
      prompt_tokens_details: { cached_tokens: turn === 1 ? 0 : 1000 * (turn - 1) },
    },
  };
  if (turn === 4) {
    return { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] };
  }
  const calls =
    turn === 2
      ? [
          { id: 'call_2a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'call_2b', type: 'function', function: { name: 'read_file', arguments: '{"path": "b.ts", "message_user": "Reading b"}' } },
        ]
      : [{ id: `call_${turn}`, type: 'function', function: { name: 'read_file', arguments: `{"path":"f${turn}.ts"}` } }];
  return {
    ...base,
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: calls } }],
  };
}

function installFakeFetch() {
  const bodies: Any[] = [];
  const fetchMock = vi.fn(async (_url: Any, init: Any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    return new Response(JSON.stringify(completion(bodies.length, body)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return bodies;
}

const tools: ResolvedTool[] = [
  {
    name: 'read_file',
    description: 'Read a workspace file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, environmentId: { type: 'string' } },
      required: ['path'],
    },
    source: 'native',
    invoke: async (args: Any) => ({ content: `contents of ${args.path}\n` + 'x'.repeat(500) }),
  },
  {
    name: 'run_command',
    description: 'Run a shell command',
    inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    source: 'native',
    invoke: async () => ({ exitCode: 0 }),
  },
];

async function runLoop(neuron: { provider: Any; endpoint?: string }, promptCacheKeyScope?: string) {
  const bodies = installFakeFetch();
  const model = (NeuronRegistry.prototype as Any).createModel.call({}, {
    id: 'muse',
    name: 'muse',
    provider: neuron.provider,
    endpoint: neuron.endpoint,
    model: 'meta/muse-spark-1.3-contributor',
    apiKey: 'sk-test',
    maxTokens: 32768,
  });
  const registry = { callNeuron: (...a: Any[]) => (NeuronRegistry.prototype as Any).callNeuron.apply({}, a) };
  const out = await runNativeToolUseLoop({
    config: { userPrompt: 'x', outputField: 'data.response', maxToolIterations: 10 } as Any,
    state: { data: {}, parameters: { environmentId: 'env-1' } } as Any,
    model,
    baseMessages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: USER },
    ],
    resolvedTools: tools,
    promptCacheKeyScope,
    neuronId: 'muse',
    userId: 'u1',
    callRunId: undefined,
    abortSignal: undefined,
    neuronRegistry: registry,
  });
  return { out, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native tool loop — OpenAI-compatible prompt caching', () => {
  it('every turn request is a byte-identical extension of the previous one', async () => {
    const { out, bodies } = await runLoop(
      { provider: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
      'muse',
    );
    expect(out).toBe('Done.');
    expect(bodies).toHaveLength(4);

    for (let i = 1; i < bodies.length; i++) {
      const prev = bodies[i - 1];
      const cur = bodies[i];
      // Same tool block, same order, same bytes.
      expect(JSON.stringify(cur.tools)).toBe(JSON.stringify(prev.tools));
      // Every message the previous turn sent is re-sent unchanged, in place.
      expect(cur.messages.length).toBeGreaterThan(prev.messages.length);
      expect(JSON.stringify(cur.messages.slice(0, prev.messages.length))).toBe(
        JSON.stringify(prev.messages),
      );
      // ...and nothing that shapes the prompt moved either.
      for (const k of ['model', 'tool_choice', 'parallel_tool_calls', 'temperature', 'max_tokens', 'max_completion_tokens']) {
        expect(cur[k], k).toEqual(prev[k]);
      }
    }
  });

  it('sends one stable prompt_cache_key on every turn', async () => {
    const { bodies } = await runLoop(
      { provider: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
      'muse',
    );
    const keys = bodies.map((b) => b.prompt_cache_key);
    expect(keys[0]).toMatch(/^rb-[0-9a-f]{32}$/);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(
      derivePromptCacheKey('muse', [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: USER },
      ]),
    );
  });

  it('sends no prompt_cache_key when the loop is not given a scope', async () => {
    const { bodies } = await runLoop({ provider: 'custom', endpoint: 'http://vllm.local/v1' });
    expect(bodies.every((b) => !('prompt_cache_key' in b) || b.prompt_cache_key === undefined)).toBe(true);
  });
});
