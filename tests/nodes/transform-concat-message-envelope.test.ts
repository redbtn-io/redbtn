import { describe, expect, it } from 'vitest';
import {
  executeTransform,
  unwrapMessageEnvelope,
  concatMessagesDeduped,
} from '../../src/lib/nodes/universal/executors/transformExecutor';
import type { TransformStepConfig } from '../../src/lib/nodes/universal/types';

/**
 * Step 2 of the immutable system `context` node (used by red-chat,
 * red-assistant, ...), verbatim from prod. Its input is the JSON-parsed
 * get_context_history(format:'llm') result, i.e. `{messages, metadata}`, not
 * an array: before the fix, fallbackToConcat silently dropped all history.
 */
const CONTEXT_NODE_CONCAT = {
  operation: 'concat',
  inputField: 'data.contextMessages',
  concatWith: 'data.messages',
  outputField: 'data.messages',
  fallbackToConcat: true,
} as unknown as TransformStepConfig;

/** god-context / coder-ctx-chat variant: points straight at `.messages`. */
const GOD_CONTEXT_CONCAT = {
  ...CONTEXT_NODE_CONCAT,
  inputField: 'data.contextMessages.messages',
} as unknown as TransformStepConfig;

const envelope = (messages: any[]) => ({
  messages,
  metadata: { conversationId: 'conv_1', messageCount: messages.length },
});

async function run(config: TransformStepConfig, data: Record<string, any>) {
  const out: any = await executeTransform(config, { data });
  return out['data.messages'];
}

describe('concat: get_context_history {messages} envelope', () => {
  it('dispatch path (web chat / CLI): history already holds the current turn -> no duplicate', async () => {
    // run-conversation-agent stores the user message before the run, so the
    // loaded history ends with it; data.messages is seeded from input.message.
    const history = [
      { role: 'user', content: 'My favourite colour is teal.' },
      { role: 'assistant', content: 'Noted: teal.' },
      { role: 'user', content: 'What is my favourite colour?' },
    ];
    const result = await run(CONTEXT_NODE_CONCAT, {
      contextMessages: envelope(history),
      messages: [{ role: 'user', content: 'What is my favourite colour?' }],
    });
    expect(result).toEqual(history);
  });

  it('stream/voice subgraph path: history lacks the current turn -> plain join', async () => {
    const history = [
      { role: 'user', content: 'Yo, plans this weekend?' },
      { role: 'assistant', content: 'Ramen?' },
    ];
    const current = [{ role: 'user', content: 'The cobalt lantern is 17.' }];
    const result = await run(CONTEXT_NODE_CONCAT, {
      contextMessages: envelope(history),
      messages: current,
    });
    expect(result).toEqual([...history, ...current]);
  });

  it('keeps the trailing-summary pseudo message and matches multi-party name prefixes', async () => {
    const history = [
      { role: 'user', content: '[Previous conversation context: earlier stuff]' },
      { role: 'user', content: 'Alice: hi', name: 'Alice' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'Bob: what did Alice say?', name: 'Bob' },
    ];
    const result = await run(CONTEXT_NODE_CONCAT, {
      contextMessages: envelope(history),
      messages: [{ role: 'user', content: 'what did Alice say?' }],
    });
    expect(result).toHaveLength(4);
    expect(result[0].content).toContain('Previous conversation context');
    expect(result[3]).toEqual({ role: 'user', content: 'what did Alice say?' });
  });

  it('does not drop an earlier turn that merely repeats the current text', async () => {
    const history = [
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'done' },
    ];
    const result = await run(CONTEXT_NODE_CONCAT, {
      contextMessages: envelope(history),
      messages: [{ role: 'user', content: 'again' }],
    });
    expect(result).toEqual([...history, { role: 'user', content: 'again' }]);
  });

  it('empty envelope (new conversation) -> just the current message', async () => {
    const result = await run(CONTEXT_NODE_CONCAT, {
      contextMessages: envelope([]),
      messages: [{ role: 'user', content: 'first' }],
    });
    expect(result).toEqual([{ role: 'user', content: 'first' }]);
  });

  it('missing history / tool error string -> falls back to data.messages', async () => {
    const current = [{ role: 'user', content: 'hi' }];
    expect(await run(CONTEXT_NODE_CONCAT, { messages: current })).toEqual(current);
    expect(
      await run(CONTEXT_NODE_CONCAT, { contextMessages: 'Forbidden', messages: current }),
    ).toEqual(current);
    expect(
      await run(CONTEXT_NODE_CONCAT, { contextMessages: { metadata: {} }, messages: current }),
    ).toEqual(current);
  });

  it('both sides missing -> empty array', async () => {
    expect(await run(CONTEXT_NODE_CONCAT, {})).toEqual([]);
  });

  it('unwraps an envelope on the concatWith side too', async () => {
    const out: any = await executeTransform(
      {
        operation: 'concat',
        inputField: 'data.a',
        concatWith: 'data.b',
        outputField: 'data.out',
      } as unknown as TransformStepConfig,
      { data: { a: [{ role: 'system', content: 's' }], b: envelope([{ role: 'user', content: 'u' }]) } },
    );
    expect(out['data.out']).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
    ]);
  });

  it('strict mode (no fallback) accepts an envelope input instead of throwing', async () => {
    const out: any = await executeTransform(
      {
        operation: 'concat',
        inputField: 'data.contextMessages',
        concatWith: 'data.messages',
        outputField: 'data.messages',
      } as unknown as TransformStepConfig,
      {
        data: {
          contextMessages: envelope([{ role: 'assistant', content: 'prev' }]),
          messages: [{ role: 'user', content: 'now' }],
        },
      },
    );
    expect(out['data.messages']).toHaveLength(2);
  });
});

describe('concat: real arrays are unchanged', () => {
  it('god-context style (.messages path) keeps plain concat semantics, duplicates included', async () => {
    const history = [
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'now' },
    ];
    const result = await run(GOD_CONTEXT_CONCAT, {
      contextMessages: envelope(history),
      messages: [{ role: 'user', content: 'now' }],
    });
    expect(result).toEqual([...history, { role: 'user', content: 'now' }]);
  });

  it('dedupeMessages: true opts a real-array concat into boundary dedupe', async () => {
    const history = [
      { role: 'assistant', content: 'prev' },
      { role: 'user', content: 'now' },
    ];
    const result = await run({ ...(GOD_CONTEXT_CONCAT as any), dedupeMessages: true }, {
      contextMessages: envelope(history),
      messages: [{ role: 'user', content: 'now' }],
    });
    expect(result).toEqual(history);
  });

  it('non-message arrays concat exactly as before', async () => {
    const out: any = await executeTransform(
      { operation: 'concat', inputField: 'data.a', value: 'data.b', outputField: 'data.c' } as unknown as TransformStepConfig,
      { data: { a: ['x', 'y'], b: ['y', 'z'] } },
    );
    expect(out['data.c']).toEqual(['x', 'y', 'y', 'z']);
  });

  it('strict mode still throws for a non-array, non-envelope input with no second array', async () => {
    await expect(
      executeTransform(
        { operation: 'concat', inputField: 'data.a', value: 'data.b', outputField: 'data.c' } as unknown as TransformStepConfig,
        { data: { a: { foo: 1 } } },
      ),
    ).rejects.toThrow();
  });
});

describe('helpers', () => {
  it('unwrapMessageEnvelope only unwraps plain objects with an array `messages`', () => {
    expect(unwrapMessageEnvelope([1]).unwrapped).toBe(false);
    expect(unwrapMessageEnvelope({ messages: 'x' }).unwrapped).toBe(false);
    expect(unwrapMessageEnvelope(null).unwrapped).toBe(false);
    expect(unwrapMessageEnvelope({ messages: [] })).toEqual({ value: [], unwrapped: true });
  });

  it('concatMessagesDeduped matches by id when both sides carry one', () => {
    const a = [{ id: 'm1', role: 'user', content: 'x' }];
    expect(concatMessagesDeduped(a, [{ id: 'm1', role: 'user', content: 'x' }])).toHaveLength(1);
    expect(concatMessagesDeduped(a, [{ id: 'm2', role: 'user', content: 'x' }])).toHaveLength(2);
  });

  it('concatMessagesDeduped removes a multi-message boundary overlap', () => {
    const a = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
    ];
    const b = [
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
    ];
    expect(concatMessagesDeduped(a, b).map((m) => m.content)).toEqual(['1', '2', '3', '4']);
  });
});
