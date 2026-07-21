/**
 * @file message_user prop tests
 * @description GitHub issue redbtn-io/webapp#1060 — an LLM tool_call may carry
 * an optional `message_user` string alongside its real arguments. The engine
 * must (1) strip it out of the args a tool handler receives, (2) publish it
 * to the conversation stream *before* the tool dispatches, and (3) do both
 * uniformly regardless of tool source (native/MCP/graph share one
 * `resolved.invoke()` dispatch path in the loop, so a native fake tool here
 * exercises the same code path all three sources go through).
 */

import { describe, it, expect } from 'vitest';
import { runNativeToolUseLoop } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import type { ResolvedTool } from '../../src/lib/tools/tool-resolver';

function makeHarness(toolCallArgs: Record<string, unknown>, toolName = 'test_tool') {
  const callOrder: string[] = [];
  const chunks: string[] = [];
  const toolStartInputs: Array<Record<string, unknown>> = [];
  let capturedInvokeArgs: Record<string, unknown> | undefined;

  const runPublisher = {
    chunk: async (content: string) => {
      chunks.push(content);
      callOrder.push('chunk');
    },
    toolStart: async (_toolId: string, _toolName: string, _source: string, meta: any) => {
      toolStartInputs.push(meta?.input);
      callOrder.push('toolStart');
    },
    toolComplete: async () => {
      callOrder.push('toolComplete');
    },
    toolError: async () => {
      callOrder.push('toolError');
    },
  };

  const resolvedTools: ResolvedTool[] = [
    {
      name: toolName,
      description: 'A fake tool for tests',
      inputSchema: {
        type: 'object',
        properties: { foo: { type: 'string' } },
      },
      source: 'native',
      invoke: async (args) => {
        capturedInvokeArgs = args;
        callOrder.push('invoke');
        return { ok: true };
      },
    },
  ];

  let callCount = 0;
  const neuronRegistry = {
    callNeuron: async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          content: '',
          tool_calls: [{ id: 'call_1', name: toolName, args: toolCallArgs }],
        };
      }
      return { content: 'All done.', tool_calls: [] };
    },
  };

  const model = { bindTools: () => ({}) };
  const state: any = { runPublisher, data: {} };

  const run = () =>
    runNativeToolUseLoop({
      config: { userPrompt: 'test', outputField: 'result', maxToolIterations: 3 } as any,
      state,
      model,
      baseMessages: [{ role: 'user', content: 'hi' }],
      resolvedTools,
      neuronId: 'test-neuron',
      userId: 'user-1',
      callRunId: undefined,
      abortSignal: undefined,
      neuronRegistry,
    });

  return {
    run,
    callOrder,
    chunks,
    toolStartInputs,
    getCapturedInvokeArgs: () => capturedInvokeArgs,
  };
}

describe('message_user tool-call prop', () => {
  it('strips message_user from args the tool handler sees, and publishes it before dispatch', async () => {
    const harness = makeHarness({ foo: 'bar', message_user: 'Doing the thing...' });

    await harness.run();

    // Tool handler never sees message_user, but does see the real arg untouched.
    expect(harness.getCapturedInvokeArgs()).toEqual({ foo: 'bar' });

    // The narration was published to the conversation stream.
    expect(harness.chunks).toEqual(['Doing the thing...']);

    // ...and the tool_start event's recorded input also excludes it (the
    // stripped parsedArgs feeds both the UI event and the dispatch call).
    expect(harness.toolStartInputs[0]).toEqual({ foo: 'bar' });

    // Published before the tool ever executes.
    expect(harness.callOrder.indexOf('chunk')).toBeGreaterThanOrEqual(0);
    expect(harness.callOrder.indexOf('invoke')).toBeGreaterThan(harness.callOrder.indexOf('chunk'));
  });

  it('leaves behavior unchanged when message_user is absent', async () => {
    const harness = makeHarness({ foo: 'bar' });

    await harness.run();

    expect(harness.getCapturedInvokeArgs()).toEqual({ foo: 'bar' });
    expect(harness.chunks).toEqual([]);
    expect(harness.callOrder).not.toContain('chunk');
  });

  it('redacts send_email message content from emitted tool_start telemetry', async () => {
    const harness = makeHarness({
      to: 'george@redbtn.io',
      subject: 'private subject',
      body: 'private body',
    }, 'send_email');

    await harness.run();

    expect(harness.toolStartInputs).toEqual([{
      recipient: 'george@redbtn.io',
      content: 'redacted',
    }]);
    expect(JSON.stringify(harness.toolStartInputs)).not.toContain('private subject');
    expect(JSON.stringify(harness.toolStartInputs)).not.toContain('private body');
  });
});
