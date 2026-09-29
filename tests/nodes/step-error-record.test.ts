/**
 * Step error records: `state.data._stepErrors[<outputField>]`.
 *
 * A neuron or tool step with `errorHandling.onError: 'fallback'` (or 'skip')
 * used to swallow its error. The run carried on with the fallbackValue and the
 * message reached only the worker's stdout, so a redBoard card whose agent
 * never started said "Red stopped without a written report" and nothing about
 * the workspace container that had failed to boot.
 *
 * These tests pin where the error lands now, what the record holds, that it is
 * redacted and bounded, that a later success clears it, and that 'throw' is
 * exactly what it was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { END, START, StateGraph } from '@langchain/langgraph';
import {
  STEP_ERROR_MESSAGE_MAX,
  classifyStepErrorCode,
  executeWithErrorHandling,
  executeWithErrorHandlingDetailed,
} from '../../src/lib/nodes/universal/executors/errorHandler';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { universalNode } from '../../src/lib/nodes/universal/universalNode';
import { RedGraphState } from '../../src/lib/graphs/state';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { WorkspaceSpawnError } from '../../src/lib/workspaces/WorkspaceLifecycle';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The shape of what the redBoard executor's workspace spawn threw. */
const SPAWN_MESSAGE =
  'spawn failed on workspace-lifecycle: Workspace container redbtn-ws-abc123 exited before becoming ready: ' +
  '/run/secrets/npmrc not mounted';

type Turn = { fail: Error } | { answer: string };

/**
 * A neuron registry that plays `turns` in order, one per call, repeating the
 * last one. Same shape as the other neuron-executor tests: `callNeuron`
 * returns an async iterable when the executor streams.
 */
function neuronState(turns: Turn[], over: Any = {}) {
  const script = [...turns];
  const neuronRegistry = {
    getConfig: vi.fn(async (id: string) => ({ id, neuronId: id, provider: 'google', model: `model-${id}` })),
    getModel: vi.fn(async () => ({})),
    callNeuron: vi.fn(async (_id: string, _userId: Any, _messages: Any, opts: Any) => {
      const turn = script.length > 1 ? script.shift()! : script[0];
      if ('fail' in turn) throw turn.fail;
      if (opts?.stream) {
        return (async function* () {
          yield { content: turn.answer };
        })();
      }
      return { content: turn.answer };
    }),
  };
  return {
    neuronRegistry,
    state: {
      neuronRegistry,
      userId: 'user_1',
      data: { runId: 'run_step_errors' },
      parameters: {},
      ...over,
    } as Any,
  };
}

const neuronStep = (over: Any = {}): Any => ({
  neuronId: 'red-executor',
  userPrompt: 'work the card',
  outputField: 'data.response',
  stream: false,
  ...over,
});

const FALLBACK_TO_EMPTY = { onError: 'fallback', fallbackValue: '', retryDelay: 0 };

function registerTool(name: string, handler: Any) {
  getNativeRegistry().register(name, {
    description: name,
    inputSchema: { type: 'object' },
    handler,
  });
}

function hasOwn(obj: Any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// The error handler
// =============================================================================

describe('executeWithErrorHandlingDetailed', () => {
  it('reports no recovery when an attempt succeeds', async () => {
    let calls = 0;
    const outcome = await executeWithErrorHandlingDetailed(
      async () => {
        calls++;
        if (calls === 1) throw new Error('transient');
        return 'ok';
      },
      { retry: 1, retryDelay: 0, onError: 'fallback', fallbackValue: 'FB' },
    );
    expect(outcome).toEqual({ value: 'ok', recovered: null });
  });

  it('reports the final error and every attempt behind a fallback', async () => {
    let calls = 0;
    const outcome = await executeWithErrorHandlingDetailed(
      async () => {
        calls++;
        throw new Error(`boom ${calls}`);
      },
      { retry: 2, retryDelay: 0, onError: 'fallback', fallbackValue: 'FB' },
    );
    expect(outcome.value).toBe('FB');
    expect(outcome.recovered).toMatchObject({ attempts: 3, strategy: 'fallback' });
    expect(outcome.recovered?.error.message).toBe('boom 3');
  });

  it('reports a skip', async () => {
    const outcome = await executeWithErrorHandlingDetailed(
      async () => {
        throw new Error('nope');
      },
      { onError: 'skip' },
    );
    expect(outcome.value).toBeUndefined();
    expect(outcome.recovered).toMatchObject({ attempts: 1, strategy: 'skip' });
  });

  it("rethrows the very same error for 'throw', as executeWithErrorHandling always did", async () => {
    const err = new Error('fatal');
    const failing = async () => {
      throw err;
    };
    await expect(executeWithErrorHandling(failing, { onError: 'throw', retryDelay: 0 })).rejects.toBe(err);
    await expect(executeWithErrorHandling(failing)).rejects.toBe(err);
    await expect(executeWithErrorHandlingDetailed(failing, { onError: 'throw' })).rejects.toBe(err);
  });
});

describe('classifyStepErrorCode', () => {
  it("finds a CLI executor's code under the neuron executor's wrapper", () => {
    for (const code of ['claude_code_timeout', 'agy_timeout', 'opencode_spawn_failed']) {
      const original = Object.assign(new Error('the CLI gave up'), { code });
      const wrapped = Object.assign(new Error('Neuron step failed: the CLI gave up'), { cause: original });
      expect(classifyStepErrorCode(wrapped)).toBe(code);
    }
  });

  it('names a WorkspaceSpawnError, whose class carries no code', () => {
    const wrapped = Object.assign(new Error(`Neuron step failed: ${SPAWN_MESSAGE}`), {
      cause: new WorkspaceSpawnError(SPAWN_MESSAGE),
    });
    expect(classifyStepErrorCode(wrapped)).toBe('WorkspaceSpawnError');
  });

  it("prefers the class name over a numeric legacy code (DOMException's AbortError is 20)", () => {
    expect(classifyStepErrorCode(Object.assign(new Error('aborted'), { name: 'AbortError', code: 20 }))).toBe('AbortError');
  });

  it('is null for an error that carries nothing to classify', () => {
    expect(classifyStepErrorCode(new Error('plain'))).toBeNull();
    expect(classifyStepErrorCode(new TypeError('x is undefined'))).toBeNull();
  });
});

// =============================================================================
// Neuron steps
// =============================================================================

describe('neuron step', () => {
  it('records the error when the step falls back, and keeps the fallback value', async () => {
    const { state } = neuronState([{ fail: new WorkspaceSpawnError(SPAWN_MESSAGE) }]);

    const result: Any = await executeNeuron(
      neuronStep({ errorHandling: { ...FALLBACK_TO_EMPTY, retry: 1 } }),
      state,
    );

    expect(result['data.response']).toBe('');
    const record = result['data._stepErrors']['data.response'];
    expect(record).toEqual({
      message: `Neuron step failed: ${SPAWN_MESSAGE}`,
      code: 'WorkspaceSpawnError',
      stepType: 'neuron',
      neuronId: 'red-executor',
      attempts: 2,
      at: expect.stringMatching(ISO_8601),
    });
    // Also on the live state, for a later step of the same node.
    expect(state.data._stepErrors['data.response']).toEqual(record);
  });

  it("keeps other steps' entries when it records its own", async () => {
    const other = { message: 'probe failed', code: null, stepType: 'tool', toolName: 'get_run', attempts: 1, at: '2026-09-29T00:00:00.000Z' };
    const { state } = neuronState([{ fail: new Error('provider down') }], {
      data: { runId: 'run_step_errors', _stepErrors: { 'data.probe': other } },
    });

    const result: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);

    expect(Object.keys(result['data._stepErrors']).sort()).toEqual(['data.probe', 'data.response']);
    expect(result['data._stepErrors']['data.probe']).toEqual(other);
  });

  it('records the classified code of a CLI failure', async () => {
    const cliError = Object.assign(new Error("claude-code step 'data.response' timed out"), {
      name: 'ClaudeCodeError',
      code: 'claude_code_timeout',
    });
    const { state } = neuronState([{ fail: cliError }]);

    const result: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);

    expect(result['data._stepErrors']['data.response'].code).toBe('claude_code_timeout');
  });

  it('records a skipped step without writing its outputField', async () => {
    const { state } = neuronState([{ fail: new Error('provider down') }]);

    const result: Any = await executeNeuron(neuronStep({ errorHandling: { onError: 'skip' } }), state);

    expect(hasOwn(result, 'data.response')).toBe(false);
    expect(result['data._stepErrors']['data.response']).toMatchObject({
      message: 'Neuron step failed: provider down',
      stepType: 'neuron',
      attempts: 1,
    });
  });

  it('redacts credentials in the recorded message', async () => {
    const leaky =
      'git clone https://x-access-token:ghs_AbCdEf0123456789xyz@github.com/redbtn-io/redbtn.git failed; ' +
      'auth rpat_live_abcdef0123456789 pat github_pat_11ABCDEFG0123456789_abcdefghijklmnop ' +
      'registration rreg_eyJzdWIiOiJ3cyJ9.c2lnbmF0dXJlLXZhbHVl';
    const { state } = neuronState([{ fail: new Error(leaky) }]);

    const result: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);

    const { message } = result['data._stepErrors']['data.response'];
    expect(message).toContain('git clone https://x-access-token:[REDACTED]@github.com');
    expect(message).toContain('[REDACTED]');
    for (const leaked of ['ghs_AbCdEf', 'rpat_live', 'github_pat_11', 'rreg_eyJ', 'c2lnbmF0dXJl']) {
      expect(message).not.toContain(leaked);
    }
  });

  it('caps the recorded message at 2000 characters', async () => {
    const { state } = neuronState([{ fail: new Error(`container log: ${'x'.repeat(5000)}`) }]);

    const result: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);

    const { message } = result['data._stepErrors']['data.response'];
    expect(STEP_ERROR_MESSAGE_MAX).toBe(2000);
    expect(message).toHaveLength(2000);
    expect(message.startsWith('Neuron step failed: container log: xxx')).toBe(true);
    expect(message.endsWith('…')).toBe(true);
  });

  it('redacts before capping, so a token the cap cuts through cannot leak', async () => {
    // A JWT whose payload straddles character 2000. Capping first would leave
    // "header.payload-prefix", which no longer looks like a JWT to the redactor.
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const padding = 'a'.repeat(2000 - 'Neuron step failed: '.length - 30);
    const { state } = neuronState([{ fail: new Error(`${padding} ${jwt} ${'b'.repeat(500)}`) }]);

    const result: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);

    const { message } = result['data._stepErrors']['data.response'];
    expect(message.length).toBeLessThanOrEqual(2000);
    expect(message).not.toContain('eyJ');
    expect(message).toContain('[REDACTED]');
  });

  it('clears the entry when a later run of the step succeeds', async () => {
    const { state } = neuronState([{ fail: new Error('provider down') }, { answer: 'the report' }]);
    const step = neuronStep({ errorHandling: FALLBACK_TO_EMPTY });

    await executeNeuron(step, state);
    expect(state.data._stepErrors['data.response']).toBeDefined();

    // The same step again (a retry node, a later loop iteration), this time succeeding.
    const result: Any = await executeNeuron(step, state);

    expect(result['data.response']).toBe('the report');
    // An explicit undefined, not a missing key: the data reducer deep-merges,
    // so only an explicit value replaces the old record.
    expect(hasOwn(result['data._stepErrors'], 'data.response')).toBe(true);
    expect(result['data._stepErrors']['data.response']).toBeUndefined();
    expect(state.data._stepErrors['data.response']).toBeUndefined();
  });

  it("clears only its own outputField's entry", async () => {
    const other = { message: 'summary failed', code: null, stepType: 'neuron', attempts: 1, at: '2026-09-29T00:00:00.000Z' };
    const { state } = neuronState([{ answer: 'fine' }], {
      data: {
        runId: 'run_step_errors',
        _stepErrors: { 'data.response': { ...other, message: 'stale' }, 'data.summary': other },
      },
    });

    const result: Any = await executeNeuron(neuronStep(), state);

    expect(result['data._stepErrors']['data.response']).toBeUndefined();
    expect(result['data._stepErrors']['data.summary']).toEqual(other);
  });

  it('adds nothing to a successful update when there is no entry to clear', async () => {
    const { state } = neuronState([{ answer: 'fine' }]);

    const withHandling: Any = await executeNeuron(neuronStep({ errorHandling: FALLBACK_TO_EMPTY }), state);
    const without: Any = await executeNeuron(neuronStep(), state);

    expect(withHandling).toEqual({ 'data.response': 'fine' });
    expect(without).toEqual({ 'data.response': 'fine' });
    expect(hasOwn(withHandling, 'data._stepErrors')).toBe(false);
    expect(state.data._stepErrors).toBeUndefined();
  });

  it('records nothing when a retry succeeds', async () => {
    const { state } = neuronState([{ fail: new Error('transient') }, { answer: 'second try' }]);

    const result: Any = await executeNeuron(
      neuronStep({ errorHandling: { ...FALLBACK_TO_EMPTY, retry: 1 } }),
      state,
    );

    expect(result).toEqual({ 'data.response': 'second try' });
    expect(state.data._stepErrors).toBeUndefined();
  });

  it("'throw' rejects exactly as before and leaves _stepErrors untouched", async () => {
    const stale = { message: 'older failure', code: null, stepType: 'neuron', attempts: 1, at: '2026-09-29T00:00:00.000Z' };
    const { state } = neuronState([{ fail: new Error('provider down') }], {
      data: { runId: 'run_step_errors', _stepErrors: { 'data.response': stale } },
    });
    const before = state.data._stepErrors;

    await expect(
      executeNeuron(neuronStep({ errorHandling: { onError: 'throw', retryDelay: 0 } }), state),
    ).rejects.toThrow('Neuron step failed: provider down');
    await expect(executeNeuron(neuronStep(), state)).rejects.toThrow('Neuron step failed: provider down');

    expect(state.data._stepErrors).toBe(before);
    expect(state.data._stepErrors['data.response']).toBe(stale);
  });
});

// =============================================================================
// Tool steps
// =============================================================================

describe('tool step', () => {
  it('records the error when the step falls back, and merges the fallback value exactly as before', async () => {
    const toolName = `test_step_error_fail_${Date.now()}`;
    registerTool(toolName, async () => {
      throw new Error('ssh: connect to host 10.0.0.9 port 22: Connection refused');
    });
    const fallbackValue = { 'data.cliFallback': true };
    const state: Any = { runId: 'run_tool_step_errors', data: {} };

    const result: Any = await executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'data.cliResult',
        errorHandling: { onError: 'fallback', fallbackValue, retry: 1, retryDelay: 0 },
      } as Any,
      state,
    );

    expect(result).toEqual({
      'data.cliFallback': true,
      'data._stepErrors': {
        'data.cliResult': {
          message: 'Tool step failed: ssh: connect to host 10.0.0.9 port 22: Connection refused',
          code: null,
          stepType: 'tool',
          toolName,
          attempts: 2,
          at: expect.stringMatching(ISO_8601),
        },
      },
    });
    expect(state.data._stepErrors['data.cliResult']).toEqual(result['data._stepErrors']['data.cliResult']);
    // The configured fallbackValue is shared by every run; it must not be written to.
    expect(fallbackValue).toEqual({ 'data.cliFallback': true });
  });

  it('clears the entry after a later success', async () => {
    const toolName = `test_step_error_ok_${Date.now()}`;
    registerTool(toolName, async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }));
    const state: Any = {
      runId: 'run_tool_step_errors',
      data: {
        _stepErrors: {
          'data.cliResult': { message: 'Tool step failed: earlier', code: null, stepType: 'tool', toolName, attempts: 1, at: '2026-09-29T00:00:00.000Z' },
        },
      },
    };

    const result: Any = await executeTool(
      {
        toolName,
        parameters: {},
        outputField: 'data.cliResult',
        errorHandling: { onError: 'fallback', fallbackValue: {}, retryDelay: 0 },
      } as Any,
      state,
    );

    expect(result['data.cliResult']).toEqual({ ok: true });
    expect(hasOwn(result['data._stepErrors'], 'data.cliResult')).toBe(true);
    expect(result['data._stepErrors']['data.cliResult']).toBeUndefined();
    expect(state.data._stepErrors['data.cliResult']).toBeUndefined();
  });

  it("'throw' rejects exactly as before and records nothing", async () => {
    const toolName = `test_step_error_throw_${Date.now()}`;
    registerTool(toolName, async () => {
      throw new Error('denied');
    });
    const state: Any = { runId: 'run_tool_step_errors', data: {} };

    await expect(
      executeTool(
        { toolName, parameters: {}, outputField: 'data.cliResult', errorHandling: { onError: 'throw', retryDelay: 0 } } as Any,
        state,
      ),
    ).rejects.toThrow('Tool step failed: denied');
    await expect(
      executeTool({ toolName, parameters: {}, outputField: 'data.cliResult' } as Any, state),
    ).rejects.toThrow('Tool step failed: denied');

    expect(state.data._stepErrors).toBeUndefined();
  });
});

// =============================================================================
// End to end: universalNode + the real LangGraph `data` reducer
// =============================================================================

describe('through universalNode and the graph state reducer', () => {
  /** A linear graph over RedGraphState whose nodes run the given steps. */
  function linearGraph(nodes: Array<[string, Any[]]>, neuronRegistry: Any): Any {
    const builder: Any = new StateGraph(RedGraphState);
    for (const [name, steps] of nodes) {
      builder.addNode(name, (s: Any) =>
        universalNode({ ...s, nodeConfig: { steps }, neuronRegistry, userId: 'user_1' }),
      );
    }
    builder.addEdge(START, nodes[0][0]);
    for (let i = 1; i < nodes.length; i++) builder.addEdge(nodes[i - 1][0], nodes[i][0]);
    builder.addEdge(nodes[nodes.length - 1][0], END);
    return builder.compile();
  }

  it("lands at data._stepErrors['data.response'] with the dotted key intact", async () => {
    const { neuronRegistry } = neuronState([{ fail: new WorkspaceSpawnError(SPAWN_MESSAGE) }]);
    const graph = linearGraph(
      [['executor', [{ type: 'neuron', config: neuronStep({ errorHandling: FALLBACK_TO_EMPTY }) }]]],
      neuronRegistry,
    );

    const final: Any = await graph.invoke({ data: { runId: 'run_e2e_record' } });

    expect(final.data.response).toBe('');
    expect(Object.keys(final.data._stepErrors)).toEqual(['data.response']);
    expect(final.data._stepErrors['data.response']).toMatchObject({
      message: `Neuron step failed: ${SPAWN_MESSAGE}`,
      code: 'WorkspaceSpawnError',
      stepType: 'neuron',
      neuronId: 'red-executor',
    });
  });

  it('keeps every step of a node, and a later node clears only the field it rewrote', async () => {
    const toolName = `test_step_error_probe_${Date.now()}`;
    registerTool(toolName, async () => {
      throw new Error('probe transport failure');
    });
    const { neuronRegistry } = neuronState([{ fail: new Error('provider down') }, { answer: 'second pass report' }]);
    const failingNeuron = { type: 'neuron', config: neuronStep({ errorHandling: FALLBACK_TO_EMPTY }) };
    const failingTool = {
      type: 'tool',
      config: {
        toolName,
        parameters: {},
        outputField: 'data.probe',
        errorHandling: { onError: 'fallback', fallbackValue: {}, retryDelay: 0 },
      },
    };

    const graph = linearGraph(
      [
        ['executor', [failingNeuron, failingTool]],
        ['retry', [failingNeuron]],
      ],
      neuronRegistry,
    );
    const final: Any = await graph.invoke({ data: { runId: 'run_e2e_clear' } });

    expect(final.data.response).toBe('second pass report');
    expect(final.data._stepErrors['data.response']).toBeUndefined();
    expect(final.data._stepErrors['data.probe']).toMatchObject({
      message: 'Tool step failed: probe transport failure',
      stepType: 'tool',
      toolName,
    });
  });

  it('is cleared by a later loop iteration that succeeds', async () => {
    const { neuronRegistry } = neuronState([{ fail: new Error('provider down') }, { answer: 'recovered' }]);
    const loop = {
      type: 'loop',
      config: {
        maxIterations: 3,
        exitCondition: "state.data.response === 'recovered'",
        steps: [{ type: 'neuron', config: neuronStep({ errorHandling: FALLBACK_TO_EMPTY }) }],
      },
    };

    const final: Any = await linearGraph([['looper', [loop]]], neuronRegistry).invoke({
      data: { runId: 'run_e2e_loop' },
    });

    expect(neuronRegistry.callNeuron).toHaveBeenCalledTimes(2);
    expect(final.data.response).toBe('recovered');
    expect(final.data._stepErrors['data.response']).toBeUndefined();
  });
});
