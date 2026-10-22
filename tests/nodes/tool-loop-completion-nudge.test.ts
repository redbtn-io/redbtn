/**
 * Native tool loop — opt-in completion check (`config.completion`).
 *
 * A no-tool-call turn whose text does NOT match `completion.requireMatch` is
 * treated as narration, not the final answer: the loop appends the assistant
 * turn plus a `user` nudge and continues. Covers: nudge-then-finish,
 * nudge exhaustion, no-config passthrough, and invalid-regex passthrough.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_COMPLETION_NUDGE,
  runNativeToolUseLoop,
} from '../../src/lib/nodes/universal/executors/neuronExecutor';
import type { ResolvedTool } from '../../src/lib/tools/tool-resolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FINAL = '```json\n{"status": "done"}\n```';

function toolTurn(id: string, tool = 'read_file', args: Any = { path: 'f.ts' }): Any {
  return { content: '', tool_calls: [{ id, name: tool, args }] };
}

function textTurn(text: string): Any {
  return { content: text, tool_calls: [] };
}

const tools: ResolvedTool[] = [
  {
    name: 'read_file',
    description: 'Read a workspace file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    source: 'native',
    invoke: async (args: Any) => ({ content: `contents of ${args.path}` }),
  },
];

async function runLoop(script: Any[], configExtra: Any = {}) {
  const seenMessages: Any[][] = [];
  let calls = 0;
  const neuronRegistry = {
    callNeuron: async (...a: Any[]) => {
      seenMessages.push([...(a[2] as Any[])]);
      const next = script[Math.min(calls, script.length - 1)];
      calls += 1;
      return next;
    },
  };
  const model = { bindTools: (..._a: Any[]) => ({}) };
  const out = await runNativeToolUseLoop({
    config: {
      userPrompt: 'x',
      outputField: 'data.response',
      maxToolIterations: 10,
      ...configExtra,
    } as Any,
    state: { data: {}, parameters: { environmentId: 'env-1' } } as Any,
    model,
    baseMessages: [
      { role: 'system', content: 'You are the card executor.' },
      { role: 'user', content: 'Do the work, then finish with the json report.' },
    ],
    resolvedTools: tools,
    neuronId: 'muse',
    userId: 'u1',
    callRunId: undefined,
    abortSignal: undefined,
    neuronRegistry,
  });
  return { out, calls, seenMessages };
}

function lastUserMessage(messages: Any[]): Any {
  return messages[messages.length - 1];
}

describe('native tool loop — opt-in completion check', () => {
  it('nudges a narration turn and returns the later matching final report', async () => {
    const { out, calls, seenMessages } = await runLoop(
      [textTurn('Now verifying typecheck and lint...'), toolTurn('call_1'), textTurn(FINAL)],
      { completion: { requireMatch: '```json[\\s\\S]*"status"' } },
    );
    expect(out).toBe(FINAL);
    expect(calls).toBe(3);
    // The second model call saw the injected user nudge.
    expect(lastUserMessage(seenMessages[1])).toEqual({ role: 'user', content: DEFAULT_COMPLETION_NUDGE });
    // The transcript stayed append-only: the third call still carries the nudge.
    expect(seenMessages[2].some((m: Any) => m?.role === 'user' && m?.content === DEFAULT_COMPLETION_NUDGE)).toBe(true);
  });

  it('returns the last text after maxNudges nudges are exhausted', async () => {
    const { out, calls, seenMessages } = await runLoop(
      [textTurn('Still working...'), textTurn('Almost there...'), textTurn('Gave up, no report.')],
      { completion: { requireMatch: '```json[\\s\\S]*"status"', maxNudges: 2 } },
    );
    expect(out).toBe('Gave up, no report.');
    expect(calls).toBe(3);
    expect(lastUserMessage(seenMessages[1])).toEqual({ role: 'user', content: DEFAULT_COMPLETION_NUDGE });
    expect(lastUserMessage(seenMessages[2])).toEqual({ role: 'user', content: DEFAULT_COMPLETION_NUDGE });
  });

  it('with no completion config a narration turn returns immediately (unchanged)', async () => {
    const { out, calls } = await runLoop([textTurn('Now verifying...'), toolTurn('call_1'), textTurn(FINAL)]);
    expect(out).toBe('Now verifying...');
    expect(calls).toBe(1);
  });

  it('an invalid regex behaves like no config', async () => {
    const { out, calls } = await runLoop([textTurn('Now verifying...'), toolTurn('call_1'), textTurn(FINAL)], {
      completion: { requireMatch: '([invalid' },
    });
    expect(out).toBe('Now verifying...');
    expect(calls).toBe(1);
  });
});
