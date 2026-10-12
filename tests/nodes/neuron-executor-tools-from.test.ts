/**
 * neuronExecutor — `toolsFrom` end to end through `executeNeuron`.
 *
 * Proves the merged list (literal `tools` + runtime refs from run state) is
 * what every execution path is actually handed:
 *   - API neurons: the native tool loop binds exactly the merged, resolved
 *     list (`model.bindTools`), including a step whose literal `tools` is [];
 *   - CLI neurons (claude-code, agy-cli, copilot-sdk, opencode): the CLI
 *     executor receives `config.tools` = merged list, which is the list its
 *     run bridge resolves and offers;
 *   - the fallback neuron re-runs with the same merged list;
 *   - missing / non-array values are run-log warnings and the step still runs.
 *
 * The CLI executors are replaced with recorders (partial module mocks), so no
 * child process, slot queue or bridge socket is involved. No DB, no network.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const cliCalls = vi.hoisted(() => ({
  claude: [] as unknown[],
  agy: [] as unknown[],
  copilot: [] as unknown[],
  opencode: [] as unknown[],
  claudeFail: null as Error | null,
}));

vi.mock('../../src/lib/nodes/universal/executors/claudeCodeExecutor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runClaudeCodeStep: vi.fn(async (args: { config: { tools?: unknown; outputField: string } }) => {
    cliCalls.claude.push(args.config.tools);
    if (cliCalls.claudeFail) throw cliCalls.claudeFail;
    return { [args.config.outputField]: 'claude ok' };
  }),
}));
vi.mock('../../src/lib/nodes/universal/executors/agyCliExecutor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runAgyCliStep: vi.fn(async (args: { config: { tools?: unknown; outputField: string } }) => {
    cliCalls.agy.push(args.config.tools);
    return { [args.config.outputField]: 'agy ok' };
  }),
}));
vi.mock('../../src/lib/nodes/universal/executors/copilotSdkExecutor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCopilotSdkStep: vi.fn(async (args: { config: { tools?: unknown; outputField: string } }) => {
    cliCalls.copilot.push(args.config.tools);
    return { [args.config.outputField]: 'copilot ok' };
  }),
}));
vi.mock('../../src/lib/nodes/universal/executors/opencodeExecutor', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runOpencodeStep: vi.fn(async (args: { config: { tools?: unknown; outputField: string } }) => {
    cliCalls.opencode.push(args.config.tools);
    return { [args.config.outputField]: 'opencode ok' };
  }),
}));

import { executeNeuron } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const NATIVE_TEST_TOOLS = ['tf_alpha', 'tf_beta', 'tf_gamma'];

beforeAll(() => {
  const reg = getNativeRegistry();
  for (const name of NATIVE_TEST_TOOLS) {
    if (!reg.has(name)) {
      reg.register(name, {
        description: `test tool ${name}`,
        inputSchema: { type: 'object', properties: {} },
        handler: async () => ({ content: [{ type: 'text', text: name }] }),
      });
    }
  }
});

beforeEach(() => {
  cliCalls.claude.length = 0;
  cliCalls.agy.length = 0;
  cliCalls.copilot.length = 0;
  cliCalls.opencode.length = 0;
  cliCalls.claudeFail = null;
});

interface Harness {
  state: Any;
  bound: string[][];
  plainCalls: number;
  logs: Array<{ level: string; message: string; metadata?: Any }>;
}

/**
 * State-level infrastructure (no RunControlRegistry), like the other
 * neuron-executor tests. `providers` maps neuron id -> provider.
 */
function harness(providers: Record<string, string>, data: Record<string, unknown>): Harness {
  const h: Harness = { state: null, bound: [], plainCalls: 0, logs: [] };
  const neuronRegistry = {
    getConfig: vi.fn(async (id: string) => {
      const provider = providers[id];
      if (!provider) throw new Error(`Neuron '${id}' not found`);
      return { id, neuronId: id, provider, model: `model-${id}` };
    }),
    getModel: vi.fn(async () => ({
      bindTools: (payload: Array<{ name: string }>) => {
        h.bound.push(payload.map((t) => t.name));
        return { bound: true };
      },
    })),
    callNeuron: vi.fn(async (_id: string, _userId: Any, _messages: Any, opts: Any) => {
      // The tool loop invokes the BOUND model; the plain path the base one.
      if (opts?.modelOverride?.bound !== true) h.plainCalls++;
      // The tool loop invokes with stream:false; answer without tool calls so
      // the loop ends on its first turn.
      if (opts?.stream) {
        return (async function* () {
          yield { content: 'plain answer' };
        })();
      }
      return { content: 'final answer', tool_calls: [] };
    }),
  };
  h.state = {
    neuronRegistry,
    userId: 'user_tf',
    runPublisher: {
      log: vi.fn(async (level: string, message: string, metadata?: Any) => {
        h.logs.push({ level, message, metadata });
      }),
      chunk: vi.fn(async () => {}),
      replaceOutputContent: vi.fn(async () => {}),
    },
    meteringClient: { neuron: { recordNeuronCall: vi.fn() } },
    data: { runId: 'run_tools_from_test', ...data },
    parameters: {},
  };
  return h;
}

const step = (over: Record<string, unknown>) => ({
  userPrompt: 'Call the tools.',
  outputField: 'data.out',
  stream: false,
  ...over,
}) as Any;

describe('executeNeuron + toolsFrom — API neuron (native tool loop)', () => {
  it('binds literal tools first, then runtime tools, de-duplicated', async () => {
    const h = harness({ api: 'openai' }, { rt: ['tf_beta', 'tf_alpha', { name: 'tf_beta' }] });
    const out = await executeNeuron(
      step({ neuronId: 'api', tools: ['tf_alpha'], toolsFrom: 'data.rt', toolStrategy: 'native' }),
      h.state,
    );
    expect(out['data.out']).toBe('final answer');
    expect(h.bound).toEqual([['tf_alpha', 'tf_beta']]);
    const info = h.logs.find((l) => l.level === 'info');
    expect(info?.message).toMatch(/toolsFrom "data\.rt" added 1 runtime tool: tf_beta \(2 duplicates dropped\)/);
    expect(h.logs.filter((l) => l.level === 'warn')).toEqual([]);
  });

  it('runs the tool loop for a step whose literal tools is [] when toolsFrom supplies them', async () => {
    const h = harness({ api: 'openai' }, { rtTools: ['tf_gamma'] });
    const out = await executeNeuron(
      step({ neuronId: 'api', tools: [], toolsFrom: 'data.rtTools', toolStrategy: 'native' }),
      h.state,
    );
    expect(out['data.out']).toBe('final answer');
    expect(h.bound).toEqual([['tf_gamma']]);
    expect(h.plainCalls).toBe(0);
  });

  it('missing path: warns in the run log and runs with the literal tools only', async () => {
    const h = harness({ api: 'openai' }, {});
    const out = await executeNeuron(
      step({ neuronId: 'api', tools: ['tf_alpha'], toolsFrom: 'data.notThere', toolStrategy: 'native' }),
      h.state,
    );
    expect(out['data.out']).toBe('final answer');
    expect(h.bound).toEqual([['tf_alpha']]);
    const warns = h.logs.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toMatch(/Neuron step 'data\.out': toolsFrom "data\.notThere" is missing from run state/);
    expect(warns[0].metadata).toMatchObject({ toolsFrom: 'data.notThere', added: 0, total: 1 });
  });

  it('non-array value: warns and the step stays a plain call when no literal tools exist', async () => {
    const h = harness({ api: 'openai' }, { rt: 'tf_alpha' });
    const out = await executeNeuron(step({ neuronId: 'api', tools: [], toolsFrom: 'data.rt' }), h.state);
    expect(out['data.out']).toBe('plain answer');
    expect(h.bound).toEqual([]);
    expect(h.plainCalls).toBe(1);
    expect(h.logs.find((l) => l.level === 'warn')?.message).toMatch(/is a string .* not an array of tool refs; ignored/);
  });

  it('without toolsFrom nothing changes and nothing is logged', async () => {
    const h = harness({ api: 'openai' }, { rt: ['tf_beta'] });
    await executeNeuron(step({ neuronId: 'api', tools: ['tf_alpha'], toolStrategy: 'native' }), h.state);
    expect(h.bound).toEqual([['tf_alpha']]);
    expect(h.logs).toEqual([]);
  });

  it('runtime refs go through the same resolver: an unknown runtime tool fails like an unknown literal one', async () => {
    const h = harness({ api: 'openai' }, { rt: ['tf_does_not_exist'] });
    await expect(
      executeNeuron(step({ neuronId: 'api', tools: [], toolsFrom: 'data.rt', toolStrategy: 'native' }), h.state),
    ).rejects.toThrow(/native tool 'tf_does_not_exist' not found/);
  });
});

describe('executeNeuron + toolsFrom — CLI neurons get exactly the merged list', () => {
  const literal = ['get_global_state'];
  const runtime = ['now', 'mcp:redboard.redboard_card_run', { name: 'now' }, 'get_global_state'];
  const merged = ['get_global_state', 'now', 'mcp:redboard.redboard_card_run'];

  it.each([
    ['claude-code', 'claude'],
    ['agy-cli', 'agy'],
    ['copilot-sdk', 'copilot'],
    ['opencode', 'opencode'],
  ] as const)('%s', async (provider, key) => {
    const h = harness({ cli: provider }, { opTools: runtime });
    const out = await executeNeuron(step({ neuronId: 'cli', tools: literal, toolsFrom: 'data.opTools' }), h.state);
    expect(Object.values(out)[0]).toMatch(/ ok$/);
    expect(cliCalls[key]).toEqual([merged]);
    // The literal list in the authored config is untouched.
    expect(literal).toEqual(['get_global_state']);
  });

  it('claude-code with tools: [] and toolsFrom (the smoke-test shape)', async () => {
    const h = harness({ 'sonnet-5': 'claude-code' }, { rtTools: ['now'] });
    await executeNeuron(step({ neuronId: 'sonnet-5', tools: [], toolsFrom: 'data.rtTools' }), h.state);
    expect(cliCalls.claude).toEqual([['now']]);
  });

  it('the fallback neuron re-runs with the same merged list', async () => {
    const err = new Error('rate limited');
    (err as Any).code = 'claude_code_rate_limited';
    (err as Any).name = 'ClaudeCodeError';
    cliCalls.claudeFail = err;
    const h = harness({ cli: 'claude-code', api: 'openai' }, { rt: ['tf_beta'] });
    const out = await executeNeuron(
      step({ neuronId: 'cli', fallbackNeuronId: 'api', tools: ['tf_alpha'], toolsFrom: 'data.rt', toolStrategy: 'native' }),
      h.state,
    );
    expect(cliCalls.claude).toEqual([['tf_alpha', 'tf_beta']]);
    expect(h.bound).toEqual([['tf_alpha', 'tf_beta']]);
    expect(out['data.out']).toBe('final answer');
    // Resolved once: one info line, not one per attempt.
    expect(h.logs.filter((l) => l.level === 'info')).toHaveLength(1);
  });
});
