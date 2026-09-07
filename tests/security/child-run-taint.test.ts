/**
 * `trigger_automation` and `start_stream_session` — the two sub-run entry
 * points the taint marker never reached.
 *
 * # What this closes
 *
 * PR #378 made `invoke_graph` stamp `MODEL_DRIVEN_STATE_KEY` into the child run
 * it starts, so a model that picks a `graphId` cannot re-enter the graph engine
 * as a TRUSTED caller and get `X-Internal-Key` attached inside the child. Its
 * round-3 review then enumerated every other sub-run entry point (§2b) and
 * found two more that start a run from model-chosen arguments with no marker at
 * all:
 *
 *   trigger_automation    — model-chosen `automationId` + `input`
 *   start_stream_session  — model-chosen `streamId` + `metadata`
 *
 * Both now stamp, on the same condition `invoke-graph.ts:390-397` uses: the
 * caller's own arguments were model-chosen, or the parent run is already
 * tainted. Not a blanket stamp — an authored step firing a fixed automation is
 * composing work and stays trusted, and blanket-tainting would strip internal
 * auth from every authored composition.
 *
 * # Be precise about what each one buys
 *
 * `trigger_automation` rides on `input`, which the webapp route spreads into
 * the run's input (`buildRunInputForAutomation`) and therefore into
 * `state.data.input` — the exact surface `isModelDrivenState` reads. It is an
 * ACTIVE control end to end, and needs no webapp change.
 *
 * `start_stream_session` rides on `metadata`, which the webapp stores as the
 * session's `triggerData`. The webapp does NOT currently spread `triggerData`
 * into the input of the runs a session later starts, so that stamp is
 * provenance plus a forward guarantee, not an active control on that path
 * today. The tests below assert the stamp, and say so rather than implying more
 * — see the module header of `start-stream-session.ts`.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { MODEL_DRIVEN_STATE_KEY, isModelDrivenState } from '../../src/lib/tools/caller-trust';
import triggerAutomationTool from '../../src/lib/tools/native/trigger-automation';
import startStreamSessionTool from '../../src/lib/tools/native/start-stream-session';
import invokeToolTool from '../../src/lib/tools/native/invoke-tool';

let captured: Array<{ url: string; body: Record<string, unknown> }>;

function baseState(extraData: Record<string, unknown> = {}) {
  return {
    runId: 'run-taint',
    authToken: 'jwt-abc',
    userId: 'user-1',
    data: {
      userId: 'user-1',
      ...extraData,
    },
  };
}

/** The body of the request the tool made, parsed. */
function sentBody(index = 0): Record<string, unknown> {
  expect(captured[index]).toBeDefined();
  return captured[index].body;
}

beforeEach(() => {
  getNativeRegistry().register('trigger_automation', triggerAutomationTool as never);
  getNativeRegistry().register('start_stream_session', startStreamSessionTool as never);
  getNativeRegistry().register('invoke_tool', invokeToolTool as never);

  captured = [];
  process.env.WEBAPP_URL = 'https://app.redbtn.io';
  process.env.INTERNAL_SERVICE_KEY = 'svc-key';

  globalThis.fetch = vi.fn(async (url: unknown, init: Record<string, unknown> = {}) => {
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    } catch {
      body = { unparseable: String(init.body) };
    }
    captured.push({ url: String(url), body });

    if (String(url).includes('/sessions')) {
      return new Response(
        JSON.stringify({ sessionId: 'sess-1', session: { sessionId: 'sess-1', status: 'queued' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ runId: 'run-child-1', run: { status: 'queued' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.WEBAPP_URL;
  delete process.env.INTERNAL_SERVICE_KEY;
  vi.restoreAllMocks();
});

describe('trigger_automation stamps the child run', () => {
  test('an UNTRUSTED caller taints the run — end to end through executeTool', async () => {
    // The real dispatch path a model takes: `invoke_tool` with a templated
    // `args` that renders to an OBJECT is untrusted (PR #378's own control),
    // and `invoke_tool` forwards the context unchanged, so the inner tool sees
    // `untrustedCaller: true`.
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'trigger_automation', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({
        call: { automationId: 'auto-1', input: { task: 'exfiltrate' } },
      }) as never,
    );

    const input = sentBody().input as Record<string, unknown>;
    expect(input.task).toBe('exfiltrate');
    expect(input[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('an already-tainted PARENT run taints the child, even with literal args', async () => {
    // The step's own parameters are literals — the author typed them — but the
    // run they execute in was itself entered with model-chosen arguments.
    // Without this branch the taint would stop at the first hop.
    await executeTool(
      {
        toolName: 'trigger_automation',
        parameters: { automationId: 'auto-1', input: { task: 'nightly' } },
        outputField: 'out',
      } as never,
      baseState({ [MODEL_DRIVEN_STATE_KEY]: true }) as never,
    );

    expect((sentBody().input as Record<string, unknown>)[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('an AUTHORED step in a clean run is NOT tainted — no over-blocking', async () => {
    // The control. Blanket-tainting would strip internal auth from every
    // authored composition, which is an availability regression, not a fix.
    await executeTool(
      {
        toolName: 'trigger_automation',
        parameters: { automationId: 'auto-1', input: { task: 'nightly' } },
        outputField: 'out',
      } as never,
      baseState() as never,
    );

    const input = sentBody().input as Record<string, unknown>;
    expect(input.task).toBe('nightly');
    expect(input[MODEL_DRIVEN_STATE_KEY]).toBeUndefined();
  });

  test('a model cannot CLEAR the marker by passing it as false', async () => {
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'trigger_automation', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({
        call: { automationId: 'auto-1', input: { [MODEL_DRIVEN_STATE_KEY]: false, task: 'x' } },
      }) as never,
    );

    // Stamped AFTER the caller's spread, so `false` is overwritten.
    expect((sentBody().input as Record<string, unknown>)[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('a NON-OBJECT input cannot be used to dodge the stamp', async () => {
    // `input: "text"` has no key to carry the marker. The webapp spreads the
    // override (`{ ...defaults, ...triggerData }`), so a string input already
    // arrived as `{0:'t',1:'e',...}` — replacing it costs nothing real, and
    // failing closed is the only safe direction.
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'trigger_automation', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({ call: { automationId: 'auto-1', input: 'just a string' } }) as never,
    );

    expect((sentBody().input as Record<string, unknown>)[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('with no input at all, the marker is still the whole input', async () => {
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'trigger_automation', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({ call: { automationId: 'auto-1' } }) as never,
    );

    expect(sentBody().input).toEqual({ [MODEL_DRIVEN_STATE_KEY]: true });
  });

  test('the marker the child receives is one `isModelDrivenState` actually reads', async () => {
    // The stamp is worthless if it lands somewhere the reader does not look.
    // `buildInitialState` puts a run's `input` at `state.data.input`.
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'trigger_automation', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({ call: { automationId: 'auto-1', input: { a: 1 } } }) as never,
    );

    const childInput = sentBody().input as Record<string, unknown>;
    expect(isModelDrivenState({ data: { input: childInput } })).toBe(true);
  });
});

describe('start_stream_session stamps the session', () => {
  test('an UNTRUSTED caller taints the session metadata', async () => {
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'start_stream_session', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({ call: { streamId: 'stream-1', metadata: { source: 'agent' } } }) as never,
    );

    const triggerData = sentBody().triggerData as Record<string, unknown>;
    expect(triggerData.source).toBe('agent');
    expect(triggerData[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });

  test('an already-tainted PARENT run taints the session', async () => {
    await executeTool(
      {
        toolName: 'start_stream_session',
        parameters: { streamId: 'stream-1' },
        outputField: 'out',
      } as never,
      baseState({ [MODEL_DRIVEN_STATE_KEY]: true }) as never,
    );

    expect(sentBody().triggerData).toEqual({ [MODEL_DRIVEN_STATE_KEY]: true });
  });

  test('an AUTHORED step in a clean run is NOT tainted', async () => {
    await executeTool(
      {
        toolName: 'start_stream_session',
        parameters: { streamId: 'stream-1', metadata: { source: 'cron' } },
        outputField: 'out',
      } as never,
      baseState() as never,
    );

    expect(sentBody().triggerData).toEqual({ source: 'cron' });
  });

  test('a model cannot CLEAR the marker by passing it as false', async () => {
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'start_stream_session', args: '{{state.data.call}}' },
        outputField: 'out',
      } as never,
      baseState({
        call: { streamId: 'stream-1', metadata: { [MODEL_DRIVEN_STATE_KEY]: false } },
      }) as never,
    );

    expect((sentBody().triggerData as Record<string, unknown>)[MODEL_DRIVEN_STATE_KEY]).toBe(true);
  });
});
