/**
 * neuronExecutor — fallback neuron dispatch.
 *
 * # What this covers
 *
 * A neuron step may name a `fallbackNeuronId`. When the primary fails in a way
 * a DIFFERENT neuron would plausibly survive, the same step is re-run once
 * against that neuron. The motivating case is a subscription-backed CLI
 * primary — `claude-code` or `agy-cli` — a child process that can fail to
 * spawn, fail its startup guard, sit out the worker's slot queue or hit a
 * subscription rate limit, none of which is a statement about the prompt.
 *
 * The tests below pin the three things that make this safe rather than merely
 * convenient:
 *
 *   1. The trigger set is CLOSED. Operational failures hop; request defects
 *      (bad schema, provider 4xx) and cancellation do not.
 *   2. Exactly one hop, ever. A fallback that also fails is the end of it.
 *   3. The hop is honest: the primary's partial stream is replaced rather than
 *      appended to, usage is attributed to the neuron that actually answered,
 *      and the run carries a `_fallback` record saying what happened.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import {
  classifyFallbackTrigger,
  resolveFallbackNeuronId,
  CLAUDE_CODE_FALLBACK_CODES,
  AGY_FALLBACK_CODES,
} from '../../src/lib/nodes/universal/executors/neuronFallback';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Build an error carrying a machine-readable `code`, like ClaudeCodeError. */
function codedError(code: string, message = `failure: ${code}`): Error {
  const err = new Error(message);
  (err as Any).code = code;
  (err as Any).name = 'ClaudeCodeError';
  return err;
}

/** The same, shaped like an AgyCliError. */
function agyError(code: string, message = `failure: ${code}`): Error {
  const err = new Error(message);
  (err as Any).code = code;
  (err as Any).name = 'AgyCliError';
  return err;
}

/** Build a provider-SDK-shaped HTTP error. */
function httpError(status: number, message = `HTTP ${status}`): Error {
  const err = new Error(message);
  (err as Any).status = status;
  return err;
}

/** Let the fire-and-forget metering emit settle before asserting on it. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

interface NeuronSpec {
  provider?: string;
  model?: string;
  /** When set, this neuron's call rejects with it. */
  fail?: Error;
  /** Text the neuron answers with when it succeeds. */
  answer?: string;
}

/**
 * A registry over a map of neuron id -> behaviour, recording every id the
 * executor actually called. Mirrors the shape used by the existing
 * neuron-executor tests (state-level infrastructure, no RunControlRegistry).
 */
function makeState(neurons: Record<string, NeuronSpec>, stateOver: Any = {}) {
  const called: string[] = [];
  const recordNeuronCall = vi.fn();
  const replaceOutputContent = vi.fn(async () => {});
  const chunk = vi.fn(async () => {});

  const spec = (id: string): NeuronSpec | undefined => neurons[id];

  const neuronRegistry = {
    getConfig: vi.fn(async (id: string) => {
      const s = spec(id);
      if (!s) throw new Error(`Neuron '${id}' not found`);
      return { id, neuronId: id, provider: s.provider ?? 'google', model: s.model ?? `model-${id}` };
    }),
    getModel: vi.fn(async (id: string) => {
      const s = spec(id);
      if (!s) throw new Error(`Neuron '${id}' not found`);
      return {};
    }),
    callNeuron: vi.fn(async (id: string, _userId: Any, _messages: Any, opts: Any) => {
      called.push(id);
      const s = spec(id);
      if (s?.fail) throw s.fail;
      const text = s?.answer ?? 'ok';
      if (opts?.stream) {
        return (async function* () {
          yield { content: text, usage_metadata: { input_tokens: 3, output_tokens: 5 } };
        })();
      }
      return { content: text };
    }),
  };

  return {
    called,
    recordNeuronCall,
    replaceOutputContent,
    chunk,
    neuronRegistry,
    state: {
      neuronRegistry,
      userId: 'user_1',
      runPublisher: { replaceOutputContent, chunk },
      meteringClient: { neuron: { recordNeuronCall } },
      data: { runId: 'run_fallback_test' },
      parameters: {},
      ...stateOver,
    } as Any,
  };
}

const baseConfig = {
  userPrompt: 'hello',
  outputField: 'data.out',
  stream: false,
};

// =============================================================================
// The classifier
// =============================================================================

describe('classifyFallbackTrigger — claude-code codes', () => {
  const triggering = [
    'claude_code_spawn_failed',
    'claude_code_init_failed',
    'claude_code_rate_limited',
    'claude_code_queue_timeout',
    'claude_code_auth_401',
    'claude_code_timeout',
    'claude_code_failed',
    'claude_code_error_result',
  ];

  it('exports exactly the documented trigger set', () => {
    expect([...CLAUDE_CODE_FALLBACK_CODES].sort()).toEqual([...triggering].sort());
  });

  it.each(triggering)('falls back on %s', (code) => {
    expect(classifyFallbackTrigger(codedError(code))).toBe(code);
  });

  it.each([
    'claude_code_bad_model',
    'claude_code_bad_structured_output',
    'claude_code_schema_too_large',
    'claude_code_api_key_leak',
    'claude_code_no_token',
  ])('does NOT fall back on %s (config / security defect)', (code) => {
    expect(classifyFallbackTrigger(codedError(code))).toBeNull();
  });

  it('sees a code through the executor cause chain', () => {
    const inner = codedError('claude_code_rate_limited');
    const wrapped = new Error(`Neuron step failed: ${inner.message}`);
    (wrapped as Any).cause = inner;
    expect(classifyFallbackTrigger(wrapped)).toBe('claude_code_rate_limited');
  });
});

describe('classifyFallbackTrigger — agy-cli codes', () => {
  const triggering = [
    'agy_spawn_failed',
    'agy_rate_limited',
    'agy_queue_timeout',
    'agy_timeout',
    'agy_failed',
    'agy_error_result',
  ];
  const notTriggering = [
    'agy_auth_required',
    'agy_tool_denied',
    'agy_no_token',
    'agy_bad_model',
    'agy_prompt_too_large',
    'agy_schema_too_large',
    'agy_bad_structured_output',
  ];

  it('exports exactly the documented trigger set', () => {
    expect([...AGY_FALLBACK_CODES].sort()).toEqual([...triggering].sort());
  });

  it.each(triggering)('falls back on %s', (code) => {
    expect(classifyFallbackTrigger(agyError(code))).toBe(code);
  });

  it.each(notTriggering)('does NOT fall back on %s', (code) => {
    expect(classifyFallbackTrigger(agyError(code))).toBeNull();
  });

  it('refuses agy_auth_required even though its MESSAGE mentions a login', () => {
    // The code decides, not the text. A human has to redo a Google OAuth flow;
    // hopping around that keeps every graph green while the subscription this
    // provider exists to spend quietly stops being used at all.
    expect(
      classifyFallbackTrigger(
        agyError(
          'agy_auth_required',
          'the Antigravity subscription needs an interactive Google login — rotate the secret',
        ),
      ),
    ).toBeNull();
  });

  it('refuses agy_tool_denied even though its MESSAGE mentions a denied action', () => {
    // A tripped security guard is the one thing that must never be routed
    // around quietly.
    expect(
      classifyFallbackTrigger(
        agyError('agy_tool_denied', 'the CLI reached for RunCommand and the turn ended'),
      ),
    ).toBeNull();
  });

  it('does not let a text heuristic rescue an excluded agy code', () => {
    // `agy_bad_model`'s message quotes the CLI, which lists "Gemini 3.1 Pro"
    // and other prose; nothing in the generic ladder below may claim it.
    expect(
      classifyFallbackTrigger(
        agyError('agy_bad_model', 'model gemini-9 is not recognized. Available models: ...'),
      ),
    ).toBeNull();
  });

  it('sees an agy code through the executor cause chain', () => {
    const wrapped = new Error('step failed');
    (wrapped as Any).cause = agyError('agy_rate_limited');
    expect(classifyFallbackTrigger(wrapped)).toBe('agy_rate_limited');
  });
});

describe('classifyFallbackTrigger — API providers', () => {
  it('falls back on 429', () => {
    expect(classifyFallbackTrigger(httpError(429))).toBe('http_429');
  });

  it.each([500, 502, 503, 504])('falls back on %i', (status) => {
    expect(classifyFallbackTrigger(httpError(status))).toBe('http_5xx');
  });

  it.each([400, 401, 403, 404, 422])('does NOT fall back on %i', (status) => {
    expect(classifyFallbackTrigger(httpError(status))).toBeNull();
  });

  it('falls back on a network error code', () => {
    const err = new Error('socket problem');
    (err as Any).code = 'ECONNRESET';
    expect(classifyFallbackTrigger(err)).toBe('network');
  });

  it('falls back on undici "fetch failed"', () => {
    expect(classifyFallbackTrigger(new Error('fetch failed'))).toBe('network');
  });

  it('falls back on a stream stall (our own watchdog)', () => {
    expect(
      classifyFallbackTrigger(new Error('LLM stream stalled — no output for 120 seconds')),
    ).toBe('timeout');
  });

  it('falls back on a rate-limit message with no status field', () => {
    expect(
      classifyFallbackTrigger(new Error('[GoogleGenerativeAI Error] 429 Too Many Requests')),
    ).toBe('http_429');
  });

  it('does NOT fall back on a content refusal', () => {
    expect(
      classifyFallbackTrigger(new Error("I can't help with that request.")),
    ).toBeNull();
  });

  it('does NOT fall back on a schema validation error', () => {
    expect(
      classifyFallbackTrigger(new Error('Invalid schema: properties must be an object')),
    ).toBeNull();
  });
});

describe('classifyFallbackTrigger — cancellation is never a fallback', () => {
  it('refuses RunInterruptedError', () => {
    const err = new Error('Run interrupted: cancelled');
    (err as Any).name = 'RunInterruptedError';
    expect(classifyFallbackTrigger(err)).toBeNull();
  });

  it('refuses AbortError', () => {
    const err = new Error('Neuron stream aborted');
    (err as Any).name = 'AbortError';
    expect(classifyFallbackTrigger(err)).toBeNull();
  });

  it('refuses an abort reached through the cause chain', () => {
    const inner = new Error('aborted');
    (inner as Any).name = 'AbortError';
    const wrapped = new Error('Neuron step failed: aborted');
    (wrapped as Any).cause = inner;
    expect(classifyFallbackTrigger(wrapped)).toBeNull();
  });

  it('refuses a timeout-shaped message that is really an abort', () => {
    // Cancellation is checked BEFORE any text heuristic, so an abort whose
    // message happens to say "timed out" still does not hop.
    const err = new Error('request timed out');
    (err as Any).name = 'AbortError';
    expect(classifyFallbackTrigger(err)).toBeNull();
  });
});

// =============================================================================
// Precedence: step literal > step template > node parameter
// =============================================================================

describe('resolveFallbackNeuronId — precedence', () => {
  const resolve = (v: Any, s: Any) =>
    typeof v === 'string' && v === '{{parameters.fallbackNeuronId}}'
      ? s?.parameters?.fallbackNeuronId
      : v;

  it('prefers the step literal over the node parameter', () => {
    const got = resolveFallbackNeuronId(
      { fallbackNeuronId: 'step-neuron' },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
      resolve,
    );
    expect(got).toBe('step-neuron');
  });

  it('uses the node parameter when the step says nothing', () => {
    const got = resolveFallbackNeuronId(
      {},
      { parameters: { fallbackNeuronId: 'param-neuron' } },
      resolve,
    );
    expect(got).toBe('param-neuron');
  });

  it('resolves a {{parameters.fallbackNeuronId}} template on the step', () => {
    const got = resolveFallbackNeuronId(
      { fallbackNeuronId: '{{parameters.fallbackNeuronId}}' },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
      resolve,
    );
    expect(got).toBe('param-neuron');
  });

  it('treats an explicit null on the step as OFF, ignoring the parameter', () => {
    const got = resolveFallbackNeuronId(
      { fallbackNeuronId: null },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
      resolve,
    );
    expect(got).toBeUndefined();
  });

  it('treats a null parameter as OFF', () => {
    const got = resolveFallbackNeuronId({}, { parameters: { fallbackNeuronId: null } }, resolve);
    expect(got).toBeUndefined();
  });

  it('ignores an unresolved template and falls through to the parameter', () => {
    const got = resolveFallbackNeuronId(
      { fallbackNeuronId: '{{parameters.missing}}' },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
      (v: Any) => v,
    );
    expect(got).toBe('param-neuron');
  });

  it('returns nothing when no fallback is configured anywhere', () => {
    expect(resolveFallbackNeuronId({}, { parameters: {} }, resolve)).toBeUndefined();
  });
});

// =============================================================================
// End-to-end dispatch through executeNeuron
// =============================================================================

describe('executeNeuron — fallback dispatch', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    'claude_code_spawn_failed',
    'claude_code_init_failed',
    'claude_code_rate_limited',
    'claude_code_queue_timeout',
    'claude_code_auth_401',
    'claude_code_timeout',
    'claude_code_failed',
    'claude_code_error_result',
  ])('re-runs the step on the fallback neuron after %s', async (code) => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError(code) },
      'red-neuron': { answer: 'from gemini' },
    });

    const result = await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'red-neuron']);
    expect(result['data.out']).toBe('from gemini');
  });

  it.each([
    'agy_spawn_failed',
    'agy_rate_limited',
    'agy_queue_timeout',
    'agy_timeout',
    'agy_failed',
    'agy_error_result',
  ])('re-runs the step on the fallback neuron after %s', async (code) => {
    // The shape George actually ships: an `agy-cli` primary on the flat-rate
    // Antigravity subscription, with a metered `sonnet-5` behind it.
    //
    // The registry stub keeps the harness's default provider on purpose. What
    // is under test is the CLASSIFIER's reading of the error code; giving the
    // stub `provider: 'agy-cli'` would route it into the real executor, which
    // would then fail on a missing credential and prove nothing about fallback.
    const { state, called } = makeState({
      'agy-flash-3-8': { model: 'gemini-3.8-flash', fail: agyError(code) },
      'sonnet-5': { answer: 'from sonnet' },
    });

    const result = await executeNeuron(
      { ...baseConfig, neuronId: 'agy-flash-3-8', fallbackNeuronId: 'sonnet-5' } as Any,
      state,
    );

    expect(called).toEqual(['agy-flash-3-8', 'sonnet-5']);
    expect(result['data.out']).toBe('from sonnet');
  });

  it('does NOT fall back when the agy subscription needs a human to log in', async () => {
    const { state, called } = makeState({
      'agy-flash-3-8': {
        fail: agyError('agy_auth_required', 'rotate the agy-oauth-token secret'),
      },
      'sonnet-5': { answer: 'from sonnet' },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'agy-flash-3-8', fallbackNeuronId: 'sonnet-5' } as Any,
        state,
      ),
    ).rejects.toThrow(/rotate the agy-oauth-token secret/);

    expect(called).toEqual(['agy-flash-3-8']);
  });

  it('does NOT fall back when the agy permission policy blocked the turn', async () => {
    const { state, called } = makeState({
      'agy-flash-3-8': {
        fail: agyError('agy_tool_denied', 'the CLI reached for RunCommand'),
      },
      'sonnet-5': { answer: 'from sonnet' },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'agy-flash-3-8', fallbackNeuronId: 'sonnet-5' } as Any,
        state,
      ),
    ).rejects.toThrow(/RunCommand/);

    expect(called).toEqual(['agy-flash-3-8']);
  });

  it('re-runs the step after a provider 429', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: httpError(429) },
      'red-neuron': { answer: 'from gemini' },
    });

    await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'red-neuron']);
  });

  it('does NOT fall back on a validation error — the original failure stands', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_bad_structured_output', 'schema rejected') },
      'red-neuron': { answer: 'from gemini' },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
        state,
      ),
    ).rejects.toThrow(/schema rejected/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('does NOT fall back on a provider 400', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: httpError(400, 'bad request') },
      'red-neuron': { answer: 'from gemini' },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
        state,
      ),
    ).rejects.toThrow(/bad request/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('does NOT fall back when the run was interrupted', async () => {
    const abort = new Error('Run interrupted: cancelled');
    (abort as Any).name = 'RunInterruptedError';
    const { state, called } = makeState({
      'sonnet-5': { fail: abort },
      'red-neuron': { answer: 'from gemini' },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
        state,
      ),
    ).rejects.toThrow(/interrupted/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('preserves the RunInterruptedError name so the run reports cancellation', async () => {
    const abort = new Error('Run interrupted: cancelled');
    (abort as Any).name = 'RunInterruptedError';
    const { state } = makeState({ 'sonnet-5': { fail: abort } });

    await expect(
      executeNeuron({ ...baseConfig, neuronId: 'sonnet-5' } as Any, state),
    ).rejects.toMatchObject({ name: 'RunInterruptedError' });
  });

  it('takes the step literal over the node parameter', async () => {
    const { state, called } = makeState(
      {
        'sonnet-5': { fail: codedError('claude_code_rate_limited') },
        'step-neuron': { answer: 'step' },
        'param-neuron': { answer: 'param' },
      },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
    );

    await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'step-neuron' } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'step-neuron']);
  });

  it('uses the graph-level parameters.fallbackNeuronId when the step names none', async () => {
    const { state, called } = makeState(
      {
        'sonnet-5': { fail: codedError('claude_code_rate_limited') },
        'param-neuron': { answer: 'param' },
      },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
    );

    await executeNeuron({ ...baseConfig, neuronId: 'sonnet-5' } as Any, state);

    expect(called).toEqual(['sonnet-5', 'param-neuron']);
  });

  it('resolves a {{parameters.fallbackNeuronId}} template on the step', async () => {
    const { state, called } = makeState(
      {
        'sonnet-5': { fail: codedError('claude_code_rate_limited') },
        'param-neuron': { answer: 'param' },
      },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
    );

    await executeNeuron(
      {
        ...baseConfig,
        neuronId: 'sonnet-5',
        fallbackNeuronId: '{{parameters.fallbackNeuronId}}',
      } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'param-neuron']);
  });

  it('is disabled by an explicit null even when a node parameter offers one', async () => {
    const { state, called } = makeState(
      {
        'sonnet-5': { fail: codedError('claude_code_rate_limited') },
        'param-neuron': { answer: 'param' },
      },
      { parameters: { fallbackNeuronId: 'param-neuron' } },
    );

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: null } as Any,
        state,
      ),
    ).rejects.toThrow(/claude_code_rate_limited/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('refuses a fallback that points at the primary', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited') },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'sonnet-5' } as Any,
        state,
      ),
    ).rejects.toThrow(/claude_code_rate_limited/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('refuses a fallback the caller cannot resolve, keeping the original error', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited', 'subscription exhausted') },
    });

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'does-not-exist' } as Any,
        state,
      ),
    ).rejects.toThrow(/subscription exhausted/);

    expect(called).toEqual(['sonnet-5']);
  });

  it('hops exactly once — a failing fallback is the end of it', async () => {
    const { state, called } = makeState(
      {
        'sonnet-5': { fail: codedError('claude_code_rate_limited') },
        'red-neuron': { fail: httpError(503, 'gemini unavailable') },
        'third-neuron': { answer: 'never reached' },
      },
      // A node parameter that a second hop would have picked up.
      { parameters: { fallbackNeuronId: 'third-neuron' } },
    );

    await expect(
      executeNeuron(
        { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
        state,
      ),
    ).rejects.toThrow(/gemini unavailable/);

    expect(called).toEqual(['sonnet-5', 'red-neuron']);
    expect(called).not.toContain('third-neuron');
  });

  it('records the hop on the run as data._fallback[stepId]', async () => {
    const { state } = makeState({
      'sonnet-5': { fail: codedError('claude_code_queue_timeout', 'no slot on this worker') },
      'red-neuron': { answer: 'from gemini' },
    });

    const result = await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );

    expect(result['data._fallback']).toEqual({
      'data.out': {
        from: 'sonnet-5',
        to: 'red-neuron',
        reason: expect.stringContaining('no slot on this worker'),
        code: 'claude_code_queue_timeout',
      },
    });
  });

  it('writes no _fallback record when the primary succeeds', async () => {
    const { state } = makeState({
      'sonnet-5': { answer: 'primary answered' },
      'red-neuron': { answer: 'unused' },
    });

    const result = await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );

    expect(result['data._fallback']).toBeUndefined();
    expect(result['data.out']).toBe('primary answered');
  });
});

// =============================================================================
// Streaming + metering honesty
// =============================================================================

describe('executeNeuron — fallback does not leak the primary output or its billing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('replaces the streamed output instead of appending to it', async () => {
    const { state, replaceOutputContent } = makeState({
      'sonnet-5': { fail: codedError('claude_code_error_result') },
      'red-neuron': { answer: 'the real answer' },
    });

    await executeNeuron(
      {
        ...baseConfig,
        stream: true,
        neuronId: 'sonnet-5',
        fallbackNeuronId: 'red-neuron',
      } as Any,
      state,
    );

    // Reset to empty BEFORE the fallback writes — a replacement, never a splice.
    expect(replaceOutputContent).toHaveBeenCalledWith('');
  });

  it('does not touch the published output when no fallback happens', async () => {
    const { state, replaceOutputContent } = makeState({
      'sonnet-5': { answer: 'fine' },
      'red-neuron': { answer: 'unused' },
    });

    await executeNeuron(
      {
        ...baseConfig,
        stream: true,
        neuronId: 'sonnet-5',
        fallbackNeuronId: 'red-neuron',
      } as Any,
      state,
    );

    expect(replaceOutputContent).not.toHaveBeenCalled();
  });

  it('meters the neuron that actually answered, and does not re-bill the primary', async () => {
    const { state, recordNeuronCall } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited'), model: 'claude-sonnet-5' },
      'red-neuron': { answer: 'from gemini', model: 'gemini-2.5-flash' },
    });

    await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );
    await flushMicrotasks();

    // The primary never produced a usable response, so it emitted nothing; the
    // single event belongs to the fallback and carries ITS model string.
    expect(recordNeuronCall).toHaveBeenCalledTimes(1);
    expect(recordNeuronCall.mock.calls[0][0]).toMatchObject({ model: 'gemini-2.5-flash' });
  });

  it('bills only the primary when it succeeds', async () => {
    const { state, recordNeuronCall } = makeState({
      'sonnet-5': { answer: 'primary', model: 'claude-sonnet-5' },
      'red-neuron': { answer: 'unused', model: 'gemini-2.5-flash' },
    });

    await executeNeuron(
      { ...baseConfig, neuronId: 'sonnet-5', fallbackNeuronId: 'red-neuron' } as Any,
      state,
    );
    await flushMicrotasks();

    expect(recordNeuronCall).toHaveBeenCalledTimes(1);
    expect(recordNeuronCall.mock.calls[0][0]).toMatchObject({ model: 'claude-sonnet-5' });
  });
});

// =============================================================================
// Ordering against errorHandling
// =============================================================================

describe('executeNeuron — errorHandling applies after the fallback also fails', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not use fallbackValue while the fallback neuron can still answer', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited') },
      'red-neuron': { answer: 'from gemini' },
    });

    const result = await executeNeuron(
      {
        ...baseConfig,
        neuronId: 'sonnet-5',
        fallbackNeuronId: 'red-neuron',
        errorHandling: { onError: 'fallback', fallbackValue: 'CANNED' },
      } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'red-neuron']);
    expect(result['data.out']).toBe('from gemini');
  });

  it('falls through to fallbackValue once both neurons have failed', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited') },
      'red-neuron': { fail: httpError(503) },
    });

    const result = await executeNeuron(
      {
        ...baseConfig,
        neuronId: 'sonnet-5',
        fallbackNeuronId: 'red-neuron',
        errorHandling: { onError: 'fallback', fallbackValue: 'CANNED' },
      } as Any,
      state,
    );

    expect(called).toEqual(['sonnet-5', 'red-neuron']);
    expect(result['data.out']).toBe('CANNED');
  });

  it('retries the primary+fallback pair, not just the primary', async () => {
    const { state, called } = makeState({
      'sonnet-5': { fail: codedError('claude_code_rate_limited') },
      'red-neuron': { fail: httpError(503) },
    });

    await expect(
      executeNeuron(
        {
          ...baseConfig,
          neuronId: 'sonnet-5',
          fallbackNeuronId: 'red-neuron',
          errorHandling: { retry: 1, retryDelay: 0 },
        } as Any,
        state,
      ),
    ).rejects.toThrow();

    expect(called).toEqual(['sonnet-5', 'red-neuron', 'sonnet-5', 'red-neuron']);
  });
});
