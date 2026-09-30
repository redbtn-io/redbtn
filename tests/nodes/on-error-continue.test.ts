/**
 * `errorHandling.onError: 'continue'`.
 *
 * 'continue' was never a valid strategy: errorHandler's switch sent it to the
 * 'throw' default, so ~50 prod nodes (all tool steps) that meant "log it and
 * carry on" killed their node instead. Now a 'continue' step leaves an error
 * marker at its outputField and the node's remaining steps run.
 *
 * The other strategies ('throw', 'fallback', 'skip', unset) are pinned too, so
 * this change cannot move them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { END, START, StateGraph } from '@langchain/langgraph';
import {
  buildContinueValue,
  executeWithErrorHandling,
  executeWithErrorHandlingDetailed,
} from '../../src/lib/nodes/universal/executors/errorHandler';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import { universalNode, validateUniversalNodeConfig } from '../../src/lib/nodes/universal/universalNode';
import { RedGraphState } from '../../src/lib/graphs/state';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let seq = 0;
function failingTool(message = 'ssh: connect to host 10.0.0.9 port 22: Connection refused'): string {
  const name = `test_on_error_continue_fail_${Date.now()}_${seq++}`;
  getNativeRegistry().register(name, {
    description: name,
    inputSchema: { type: 'object' },
    handler: async () => {
      throw new Error(message);
    },
  } as Any);
  return name;
}

function okTool(payload: unknown): string {
  const name = `test_on_error_continue_ok_${Date.now()}_${seq++}`;
  getNativeRegistry().register(name, {
    description: name,
    inputSchema: { type: 'object' },
    handler: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
  } as Any);
  return name;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('executeWithErrorHandlingDetailed', () => {
  it("reports a 'continue' recovery instead of throwing", async () => {
    let calls = 0;
    const outcome = await executeWithErrorHandlingDetailed(
      async () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
      { onError: 'continue', retry: 1, retryDelay: 0 },
    );
    expect(outcome.value).toBeUndefined();
    expect(outcome.recovered).toMatchObject({ strategy: 'continue', attempts: 2 });
    expect(outcome.recovered?.error.message).toBe('boom 2');
  });

  it("still rethrows the same error for 'throw', unset, and an unknown value", async () => {
    const err = new Error('fatal');
    const failing = async () => {
      throw err;
    };
    await expect(executeWithErrorHandling(failing, { onError: 'throw', retryDelay: 0 })).rejects.toBe(err);
    await expect(executeWithErrorHandling(failing)).rejects.toBe(err);
    await expect(executeWithErrorHandling(failing, { onError: 'contine' as Any })).rejects.toBe(err);
  });

  it("leaves 'fallback' and 'skip' exactly as they were", async () => {
    const failing = async () => {
      throw new Error('x');
    };
    expect(await executeWithErrorHandling(failing, { onError: 'fallback', fallbackValue: 'FB' })).toBe('FB');
    expect(await executeWithErrorHandling(failing, { onError: 'skip' })).toBeUndefined();
  });
});

describe('buildContinueValue', () => {
  const failure = { error: new Error('down'), attempts: 1, strategy: 'continue' as const };
  const now = new Date('2026-09-30T12:00:00.000Z');

  it('is the marker when there is no fallbackValue', () => {
    expect(buildContinueValue(failure, { stepType: 'tool', toolName: 't' }, undefined, now)).toEqual({
      _stepError: true,
      error: 'down',
      code: null,
      stepType: 'tool',
      toolName: 't',
      attempts: 1,
      at: '2026-09-30T12:00:00.000Z',
    });
  });

  it("keeps a plain-object fallbackValue's keys under the marker, without mutating it", () => {
    const fb = { success: false, error: 'ssh_shell failed' };
    const out: Any = buildContinueValue(failure, { stepType: 'tool', toolName: 'ssh_shell' }, fb, now);
    expect(out).toMatchObject({ success: false, _stepError: true, error: 'down', toolName: 'ssh_shell' });
    expect(fb).toEqual({ success: false, error: 'ssh_shell failed' });
  });

  it('writes a primitive / null / array fallbackValue as-is', () => {
    const subject = { stepType: 'tool' as const, toolName: 't' };
    expect(buildContinueValue(failure, subject, '')).toBe('');
    expect(buildContinueValue(failure, subject, null)).toBeNull();
    expect(buildContinueValue(failure, subject, [1])).toEqual([1]);
  });

  it('redacts credentials in the message', () => {
    const leak = { error: new Error('auth failed for rpat_abcdefghijklmnopqrstuvwxyz0123'), attempts: 1, strategy: 'continue' as const };
    const out: Any = buildContinueValue(leak, { stepType: 'tool', toolName: 't' }, undefined);
    expect(out.error).not.toContain('rpat_abcdef');
  });
});

describe('tool step', () => {
  it("'continue' writes the marker to outputField and records the error", async () => {
    const toolName = failingTool();
    const state: Any = { runId: 'run_continue', data: {} };
    const result: Any = await executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'data.cliResult',
        errorHandling: { onError: 'continue', fallbackValue: { success: false, error: 'ssh_shell failed' }, retryDelay: 0 },
      } as Any,
      state,
    );
    expect(result['data.cliResult']).toEqual({
      success: false,
      _stepError: true,
      error: 'Tool step failed: ssh: connect to host 10.0.0.9 port 22: Connection refused',
      code: null,
      stepType: 'tool',
      toolName,
      attempts: 1,
      at: expect.stringMatching(ISO_8601),
    });
    expect(result['data._stepErrors']['data.cliResult']).toMatchObject({ stepType: 'tool', toolName, attempts: 1 });
  });

  it("'fallback' still merges the fallbackValue as the update (unchanged)", async () => {
    const toolName = failingTool();
    const result: Any = await executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'data.cliResult',
        errorHandling: { onError: 'fallback', fallbackValue: { 'data.fb': true }, retryDelay: 0 },
      } as Any,
      { data: {} },
    );
    expect(result['data.fb']).toBe(true);
    expect(result).not.toHaveProperty('data.cliResult');
  });

  it("'throw' and no errorHandling still reject", async () => {
    const toolName = failingTool('denied');
    await expect(
      executeTool({ toolName, parameters: {}, outputField: 'o', errorHandling: { onError: 'throw', retryDelay: 0 } } as Any, { data: {} }),
    ).rejects.toThrow('Tool step failed: denied');
    await expect(executeTool({ toolName, parameters: {}, outputField: 'o' } as Any, { data: {} })).rejects.toThrow(
      'Tool step failed: denied',
    );
  });
});

describe('neuron step', () => {
  it("'continue' writes the marker to outputField", async () => {
    const neuronRegistry = {
      getConfig: vi.fn(async (id: string) => ({ id, neuronId: id, provider: 'google', model: 'm' })),
      getModel: vi.fn(async () => ({})),
      callNeuron: vi.fn(async () => {
        throw new Error('provider down');
      }),
    };
    const state: Any = { neuronRegistry, userId: 'u', data: { runId: 'r' }, parameters: {} };
    const result: Any = await executeNeuron(
      {
        neuronId: 'n1',
        userPrompt: 'hi',
        outputField: 'data.response',
        stream: false,
        errorHandling: { onError: 'continue', retryDelay: 0 },
      } as Any,
      state,
    );
    expect(result['data.response']).toMatchObject({
      _stepError: true,
      error: expect.stringContaining('provider down'),
      stepType: 'neuron',
      neuronId: 'n1',
    });
    expect(result['data._stepErrors']['data.response']).toMatchObject({ stepType: 'neuron' });
  });
});

describe('through universalNode and a real graph', () => {
  function graphOf(steps: Any[]): Any {
    const builder: Any = new StateGraph(RedGraphState);
    builder.addNode('n', (s: Any) => universalNode({ ...s, nodeConfig: { steps }, userId: 'u' }));
    builder.addEdge(START, 'n');
    builder.addEdge('n', END);
    return builder.compile();
  }

  it("a failing 'continue' step does not stop the node: later steps run and see the marker", async () => {
    const bad = failingTool('probe transport failure');
    const good = okTool({ ok: true });
    const final: Any = await graphOf([
      {
        type: 'tool',
        config: { toolName: bad, parameters: {}, outputField: 'data.probe', errorHandling: { onError: 'continue', retryDelay: 0 } },
      },
      { type: 'tool', config: { toolName: good, parameters: {}, outputField: 'data.after' } },
    ]).invoke({ data: { runId: 'run_continue_e2e' } });

    expect(final.data.probe).toMatchObject({ _stepError: true, error: 'Tool step failed: probe transport failure' });
    expect(final.data.after).toEqual({ ok: true });
    expect(final.data._stepErrors['data.probe']).toMatchObject({ toolName: bad });
  });

  it("the same step with 'throw' still fails the node: later steps never run, error routing is set", async () => {
    const bad = failingTool('probe transport failure');
    const good = okTool({ ok: true });
    const final: Any = await graphOf([
      { type: 'tool', config: { toolName: bad, parameters: {}, outputField: 'data.probe', errorHandling: { onError: 'throw', retryDelay: 0 } } },
      { type: 'tool', config: { toolName: good, parameters: {}, outputField: 'data.after' } },
    ]).invoke({ data: { runId: 'run_throw_e2e' } });
    expect(final.data.error).toMatch(/Step 1 \(tool\) failed: .*probe transport failure/);
    expect(final.data.nextGraph).toBe('error_handler');
    expect(final.data.after).toBeUndefined();
    expect(final.data.probe).toBeUndefined();
  });
});

describe('validateUniversalNodeConfig', () => {
  const step = (onError: string): Any => ({
    steps: [{ type: 'tool', config: { toolName: 't', parameters: {}, outputField: 'o', errorHandling: { onError } } }],
  });

  it("accepts 'continue'", () => {
    expect(() => validateUniversalNodeConfig(step('continue'))).not.toThrow();
  });

  it('still rejects an unknown value', () => {
    expect(() => validateUniversalNodeConfig(step('contine'))).toThrow(/invalid errorHandling.onError/);
  });
});
