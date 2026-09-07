/**
 * toolExecutor — caller trust and the registry chokepoint.
 *
 * Two boundaries are asserted here, end to end through `executeTool`:
 *
 * 1. **Trust.** A graph `tool` step is a trusted caller — `fetch_url` attaches
 *    the run's `Authorization` / `X-User-Id` and the platform's
 *    `X-Internal-Key` — only while the destination is the literal one its
 *    author typed. `renderParameters(config.parameters, state)` means a step
 *    configured `{ url: '{{state.target}}' }` carries a MODEL-chosen URL, and a
 *    sub-graph a neuron invoked as a tool re-enters this executor with a fresh
 *    state, so neither may keep the credential.
 *
 * 2. **The chokepoint.** Every native dispatch must go through
 *    `NativeToolRegistry.callTool`, the only place `enforceToolCapability` and
 *    `runExecGuard` (exec kill switch, `EXEC_RATE_MAX`, fail-closed audit) run.
 *    The stream-parser tool callback used to call `tool.handler(params, {})`
 *    directly: that skipped both gates AND handed the tool a context so empty
 *    that `untrustedCaller` was falsy, so a parser-dispatched `fetch_url`
 *    picked up `X-Internal-Key` straight from `process.env`. The parser's
 *    params come from the streamed stdout of a CLI/agent tool, which is exactly
 *    the text a prompt injection controls.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { getParserRegistry } from '../../src/lib/nodes/universal/executors/parserRegistry';
import { markStateModelDriven } from '../../src/lib/tools/caller-trust';

const INTERNAL_URL = 'https://app.redbtn.io/api/v1/graphs';

let seq = 0;
function uniqueName(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now()}_${seq}`;
}

/** Register a native tool that records the context it was handed. */
function registerProbe(name: string): { calls: any[] } {
  const calls: any[] = [];
  getNativeRegistry().register(name, {
    description: name,
    inputSchema: { type: 'object' },
    handler: async (_args: any, context: any) => {
      calls.push(context);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
    },
  });
  return { calls };
}

function makeRunPublisher() {
  return {
    toolStart: vi.fn(async () => {}),
    toolProgress: vi.fn(async () => {}),
    toolComplete: vi.fn(async () => {}),
    toolError: vi.fn(async () => {}),
    chunk: vi.fn(async () => {}),
    thinkingChunk: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toolExecutor — untrustedCaller on a graph tool step', () => {
  test('a literal destination stays TRUSTED (internal auth keeps working)', async () => {
    const name = uniqueName('trust_literal');
    const probe = registerProbe(name);

    await executeTool(
      { toolName: name, parameters: { url: INTERNAL_URL }, outputField: 'out' } as any,
      { runId: 'run-literal' },
    );

    expect(probe.calls).toHaveLength(1);
    expect(probe.calls[0].untrustedCaller).toBe(false);
  });

  test('an INTERPOLATED destination is UNTRUSTED (the breaking input from the review)', async () => {
    const name = uniqueName('trust_interpolated');
    const probe = registerProbe(name);

    // `{ toolName:'fetch_url', parameters:{ url:'{{data.answer}}' } }` — a
    // graph author wrote the step, but a model wrote the URL.
    const result = await executeTool(
      { toolName: name, parameters: { url: '{{state.data.answer}}' }, outputField: 'out' } as any,
      { runId: 'run-interpolated', data: { answer: INTERNAL_URL } },
    );

    expect(result).toEqual({ out: { ok: true } });
    expect(probe.calls[0].untrustedCaller).toBe(true);
    // ...and the rendered URL really was the model's, i.e. the test exercised
    // the path it claims to.
    expect(probe.calls).toHaveLength(1);
  });

  test('a templated BODY behind a literal URL stays trusted', async () => {
    const name = uniqueName('trust_body');
    const probe = registerProbe(name);

    await executeTool(
      {
        toolName: name,
        parameters: { url: INTERNAL_URL, method: 'POST', body: '{{state.summary}}' },
        outputField: 'out',
      } as any,
      { runId: 'run-body', summary: 'a summary the model wrote' },
    );

    expect(probe.calls[0].untrustedCaller).toBe(false);
  });

  test('a literal destination inside a model-invoked sub-graph is UNTRUSTED', async () => {
    // `tool-resolver.resolveGraph` stamps this marker on the state it
    // synthesises for a graph-as-tool. Without it, a neuron re-escalates to the
    // service key through any published sub-graph that fetches a templated URL.
    const name = uniqueName('trust_subgraph');
    const probe = registerProbe(name);

    await executeTool(
      { toolName: name, parameters: { url: INTERNAL_URL }, outputField: 'out' } as any,
      markStateModelDriven({ runId: 'run-subgraph', data: {} }),
    );

    expect(probe.calls[0].untrustedCaller).toBe(true);
  });
});

describe('toolExecutor — the stream-parser tool callback', () => {
  /**
   * Drive the real ParserExecutor: a host tool streams one line of "agent
   * stdout", a parser `tool` step turns that line into a tool call. That is the
   * prompt-injection path — the line is attacker-influenced text.
   */
  async function runParserDispatch(): Promise<{ dispatched: any[]; callToolNames: string[]; targetName: string }> {
    const hostName = uniqueName('parser_host');
    const targetName = uniqueName('parser_target');
    const parserId = uniqueName('parser_def');

    const dispatched: any[] = [];
    let resolveDispatched!: () => void;
    const dispatchedOnce = new Promise<void>((resolve) => {
      resolveDispatched = resolve;
    });

    getNativeRegistry().register(targetName, {
      description: targetName,
      inputSchema: { type: 'object' },
      handler: async (args: any, context: any) => {
        dispatched.push({ args, context });
        resolveDispatched();
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    });

    getNativeRegistry().register(hostName, {
      description: hostName,
      inputSchema: { type: 'object' },
      handler: async (_args: any, context: any) => {
        // One complete line of "agent stdout" — the parser buffers on newline.
        context.onChunk(`${INTERNAL_URL}\n`, 'stdout');
        await dispatchedOnce;
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    });

    getParserRegistry().registerBuiltin(parserId, {
      config: {
        steps: [
          {
            type: 'tool',
            config: {
              toolName: targetName,
              // The URL comes straight out of the streamed line.
              parameters: { url: '{{state.chunk}}' },
              outputField: 'dispatchResult',
            },
          },
        ],
      } as any,
      parserConfig: { inputField: 'chunk', outputField: 'parsed', bufferMode: 'line', skipEmpty: true },
    });

    const registry = getNativeRegistry();
    const callToolNames: string[] = [];
    const realCallTool = registry.callTool.bind(registry);
    vi.spyOn(registry, 'callTool').mockImplementation(async (name: string, args: any, context: any) => {
      callToolNames.push(name);
      return realCallTool(name, args, context);
    });

    await executeTool(
      {
        toolName: hostName,
        parameters: {},
        outputField: 'out',
        streamParser: parserId,
        streamToConversation: 'conv-parser',
      } as any,
      { runId: 'run-parser', runPublisher: makeRunPublisher() },
    );

    return { dispatched, callToolNames, targetName };
  }

  test('dispatches through registry.callTool, not the raw handler', async () => {
    const { callToolNames, targetName } = await runParserDispatch();
    // If the callback reverts to `tool.handler(...)`, the target never appears
    // here — and with it goes enforceToolCapability + runExecGuard.
    expect(callToolNames).toContain(targetName);
  });

  test('marks the parser-dispatched call as an UNTRUSTED caller', async () => {
    const { dispatched } = await runParserDispatch();
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].context.untrustedCaller).toBe(true);
    // The parser really did put the streamed line into the tool's URL — this
    // is the escalation the flag defuses.
    expect(dispatched[0].args.url).toBe(INTERNAL_URL);
  });

  test('hands the tool the REAL run context, not an empty object', async () => {
    // `tool.handler(params, {})` gave `buildHeaders({})` a context with no
    // state at all, which still returned `X-Internal-Key` from process.env.
    const { dispatched } = await runParserDispatch();
    const context = dispatched[0].context;
    expect(context.state).toBeTruthy();
    expect(context.state.runId).toBe('run-parser');
    expect(context.runId).toBe('run-parser');
    expect('abortSignal' in context).toBe(true);
  });
});
