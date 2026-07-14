/**
 * Red Ops Triage node — quiet-tick gate behaviour.
 *
 * # What's under test
 *
 * `ops/red-ops/red-ops-triage.node.json` is the config deployed to the LIVE
 * Red Coordinator graph (tHXXSTFtOuM9), between the Gate and the CLI
 * Coordinator. The Coordinator fires 96x/day and each run is a full CLI
 * session over SSH; the triage node exists to end a quiet tick before that
 * session starts.
 *
 * The node is entirely made of `{{...}}` templates, so the interesting logic
 * lives in strings and cannot be type-checked. These tests drive the ACTUAL
 * deployed JSON through the engine's OWN evaluator (`resolveValue`) and
 * transform executor, with stubbed tool/neuron steps — so a config change that
 * breaks routing fails here before it reaches the graph that dispatches the
 * fleet.
 *
 * The load-bearing invariant is FAIL OPEN: the tick may only be skipped on a
 * confident, explicit "nothing actionable". Every error path (board fetch
 * failed, no baseline, truncated fetches, unparseable neuron output, spend
 * budget blown) must still route to the coordinator — a false skip stalls the
 * fleet silently, a false run only costs one session.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';
import { executeTransform } from '../../src/lib/nodes/universal/executors/transformExecutor';
import type { TransformStepConfig } from '../../src/lib/nodes/universal/types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const NODE = JSON.parse(
  readFileSync(resolve(__dirname, '../../ops/red-ops/red-ops-triage.node.json'), 'utf8'),
);
const STEPS: Any[] = NODE.config.steps;
const PARAM_DEFAULTS: Record<string, Any> = Object.fromEntries(
  Object.entries(NODE.config.parameters as Record<string, Any>).map(([k, v]) => [k, v.default]),
);

const TODAY = new Date().toISOString().slice(0, 10);
const AGENT = 'agent@redbtn.io';
const GEORGE = 'george@redbtn.io';

/** Snapshot of one tick's side effects — what the driver observed. */
interface TickResult {
  route: string;
  decision: Any;
  signals: Any;
  spend: Any;
  memo: Any;
  response: string;
  neuronCalls: number;
  toolCalls: Array<{ tool: string; params: Any }>;
  globalWrites: Array<{ namespace: string; key: string; value: Any }>;
}

interface TickOpts {
  items?: Any[];
  /** null → simulate a failed /api/board fetch. */
  boardOk?: boolean;
  comments?: Record<string, Any[]>;
  runs?: Record<string, string>;
  memo?: Any;
  cfg?: Any;
  ctl?: Any;
  opsState?: Any;
  /** Raw string the triage neuron returns (undefined → a well-formed "not actionable"). */
  neuronOutput?: string;
  /** false → the automation injected no _secrets (token must fall back to red-ops/config). */
  secrets?: boolean;
}

function setPath(state: Any, path: string, value: Any): void {
  const parts = path.split('.');
  let cur = state;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/** MCP-shaped result, as a native tool returns it. */
const mcp = (payload: Any) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] });
/** fetch_url wraps the HTTP body as a STRING inside its JSON envelope. */
const httpOk = (body: Any) => mcp({ status: 200, statusText: 'OK', headers: {}, body: JSON.stringify(body) });

/**
 * Mirrors the universal-node runtime closely enough to exercise routing:
 * step conditions via resolveValue, `set`/`get-global`/`set-global` transforms
 * via the real executor, and loop steps with the real iteration cap +
 * exitCondition semantics. Tool and neuron steps are stubbed.
 */
async function runTick(opts: TickOpts = {}): Promise<TickResult> {
  const {
    items = [],
    boardOk = true,
    comments = {},
    runs = {},
    memo = null,
    cfg = {},
    ctl = { target: 2, inFlight: 0, operatorDirected: false },
    opsState = { dispatched: [] },
    neuronOutput,
    secrets = true,
  } = opts;

  const globals: Record<string, Any> = {
    'red-ops/config': cfg,
    'red-ops/state': opsState,
    'red-ops/triage': memo,
  };

  const toolCalls: TickResult['toolCalls'] = [];
  const globalWrites: TickResult['globalWrites'] = [];
  let neuronCalls = 0;

  const state: Any = {
    data: {
      input: secrets ? { _secrets: { ATLAS_TOKEN: 'test-token' } } : {},
      ctl,
      runId: 'run_test_1',
    },
    parameters: PARAM_DEFAULTS,
  };

  const callTool = (toolName: string, params: Any): Any => {
    toolCalls.push({ tool: toolName, params });
    if (toolName === 'get_run') {
      const status = runs[String(params.runId)];
      if (!status) return mcp({ error: 'not found', runId: params.runId });
      return mcp({ run: { runId: params.runId, status } });
    }
    if (toolName === 'fetch_url') {
      const url = String(params.url);
      if (/\/api\/board(\?|$)/.test(url)) {
        if (!boardOk) return mcp({ error: 'Request timed out after 30000ms' });
        // The board list must include done cards — see the "done is not deaf" test.
        expect(url).toContain('status=');
        expect(url).toContain('done');
        return httpOk({ items });
      }
      const m = url.match(/\/api\/board\/([^/]+)\/comments$/);
      if (m) return httpOk({ comments: comments[m[1]] || [] });
      if (url.endsWith('/api/notes')) return httpOk({ ok: true });
    }
    return mcp({ error: `unstubbed tool ${toolName}` });
  };

  const shouldRun = (step: Any, s: Any): boolean =>
    !step.condition || Boolean(resolveValue(step.condition, { ...s, parameters: s.parameters }));

  const execStep = async (step: Any, s: Any): Promise<void> => {
    if (!shouldRun(step, s)) return;

    if (step.type === 'transform') {
      const cfgT = step.config as TransformStepConfig & Any;
      if (cfgT.operation === 'get-global') {
        setPath(s, cfgT.outputField, globals[`${cfgT.namespace}/${cfgT.key}`] ?? undefined);
        return;
      }
      if (cfgT.operation === 'set-global') {
        const value = cfgT.inputField
          ? cfgT.inputField.split('.').reduce((a: Any, k: string) => (a ? a[k] : undefined), s)
          : resolveValue(cfgT.value, s);
        globals[`${cfgT.namespace}/${cfgT.key}`] = value;
        globalWrites.push({ namespace: cfgT.namespace, key: cfgT.key, value });
        return;
      }
      // Real executor — keeps the fail-closed `set` semantics honest.
      const update = await executeTransform(cfgT, s);
      for (const [k, v] of Object.entries(update)) setPath(s, k, v);
      return;
    }

    if (step.type === 'tool') {
      const params = JSON.parse(JSON.stringify(step.config.parameters), (_k, v) =>
        typeof v === 'string' ? resolveValue(v, s) : v,
      );
      setPath(s, step.config.outputField, callTool(step.config.toolName, params));
      return;
    }

    if (step.type === 'neuron') {
      neuronCalls++;
      const out = neuronOutput !== undefined
        ? neuronOutput
        : JSON.stringify({ actionable: false, reason: 'stub: informational only', focus: '' });
      setPath(s, step.config.outputField, out);
      return;
    }

    if (step.type === 'loop') {
      const max = Number(resolveValue(step.config.maxIterations, s)) || 5;
      let iteration = 0;
      let done = false;
      while (iteration < max && !done) {
        iteration++;
        s.data.loopIteration = iteration;
        for (const inner of step.config.steps) await execStep(inner, s);
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
        done = Boolean(new Function('state', `return (${step.config.exitCondition})`)(s));
      }
      delete s.data.loopIteration;
      return;
    }

    throw new Error(`unhandled step type ${step.type}`);
  };

  for (const step of STEPS) await execStep(step, state);

  return {
    route: state.data.triageRoute,
    decision: state.data.triageDecision,
    signals: state.data.triageSignals,
    spend: state.data.triageSpendState,
    memo: state.data.triageMemoOut,
    response: state.data.response,
    neuronCalls,
    toolCalls,
    globalWrites,
  };
}

// ── fixtures ────────────────────────────────────────────────────────────────

const T0 = '2026-07-14T18:00:00.000Z'; // baseline "last triage" time
const T1 = '2026-07-14T18:20:00.000Z'; // after the baseline

const card = (over: Any = {}): Any => ({
  id: 'card1',
  title: 'A card',
  status: 'working',
  slug: 'redbtn-engine',
  tags: [],
  urgent: false,
  commentCount: 2,
  updatedAt: T0,
  dispatch: { workerRunId: 'run_w1' },
  ...over,
});

/** A settled board: one worked card, seen exactly as it is now. */
const settledMemo = (over: Any = {}): Any => ({
  v: 1,
  updatedAt: T0,
  ticks: 10,
  skipped: 6,
  escalated: 4,
  seen: { card1: { s: 'working', c: 2, u: T0 } },
  surfacedRuns: {},
  spend: { day: TODAY, calls: 3, estUsd: 0.0004, alertedDay: '' },
  ...over,
});

describe('red-ops-triage — quiet ticks are skipped for free', () => {
  it('skips the coordinator when nothing changed and the worker is still running', async () => {
    const r = await runTick({
      items: [card()],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
    });

    expect(r.route).toBe('stop');
    expect(r.decision.via).toBe('deterministic');
    expect(r.neuronCalls).toBe(0); // a quiet tick costs ZERO tokens
    expect(r.signals.running).toBe(1);
    expect(r.response).toContain('QUIET TICK');
  });

  it('counts the skip in the memo and keeps the baseline current', async () => {
    const r = await runTick({ items: [card()], runs: { run_w1: 'running' }, memo: settledMemo() });

    expect(r.memo.skipped).toBe(7);
    expect(r.memo.escalated).toBe(4);
    expect(r.memo.ticks).toBe(11);
    expect(r.memo.seen.card1).toEqual({ s: 'working', c: 2, u: T0 });
    expect(r.globalWrites).toContainEqual(
      expect.objectContaining({ namespace: 'red-ops', key: 'triage' }),
    );
  });
});

describe('red-ops-triage — actionable ticks reach the coordinator deterministically', () => {
  it('runs on an inbox card when there is capacity (no neuron call)', async () => {
    const r = await runTick({
      items: [card(), card({ id: 'card2', status: 'inbox', commentCount: 0, dispatch: {} })],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
    });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('deterministic');
    expect(r.decision.reason).toContain('inbox');
    expect(r.neuronCalls).toBe(0);
  });

  it('runs to recover a failed worker run', async () => {
    const r = await runTick({ items: [card()], runs: { run_w1: 'error' }, memo: settledMemo() });

    expect(r.route).toBe('run');
    expect(r.decision.reason).toContain('failed worker run');
    expect(r.signals.failedRuns).toEqual(['run_w1']);
    expect(r.neuronCalls).toBe(0);
  });

  it('runs to reconcile + refill when a worker finished', async () => {
    const r = await runTick({ items: [card()], runs: { run_w1: 'completed' }, memo: settledMemo() });

    expect(r.route).toBe('run');
    expect(r.decision.reason).toContain('finished');
    expect(r.memo.surfacedRuns.run_w1).toBe('done');
  });

  it('does not re-surface a run it already reported (no run-forever loop)', async () => {
    const r = await runTick({
      items: [card()],
      runs: { run_w1: 'completed' },
      memo: settledMemo({ surfacedRuns: { run_w1: 'done' } }),
    });

    expect(r.route).toBe('stop');
    expect(r.toolCalls.filter((c) => c.tool === 'get_run')).toHaveLength(0);
  });

  it('runs on a NEW human comment without asking the neuron', async () => {
    const r = await runTick({
      items: [card({ commentCount: 3, updatedAt: T1 })],
      runs: { run_w1: 'running' },
      comments: {
        card1: [
          { author: AGENT, body: 'HANDOFF done: x', createdAt: T0 },
          { author: GEORGE, body: 'actually make it red', createdAt: T1 },
        ],
      },
      memo: settledMemo(),
    });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('deterministic');
    expect(r.decision.reason).toContain('human comment');
    expect(r.neuronCalls).toBe(0);
  });

  it('runs when the operator gave a directive, even on a dead-quiet board', async () => {
    const r = await runTick({
      items: [card()],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
      ctl: { target: 2, inFlight: 1, operatorDirected: true, directive: 'ship the thing' },
    });

    expect(r.route).toBe('run');
    expect(r.decision.reason).toContain('operator-directed');
    expect(r.neuronCalls).toBe(0);
  });
});

/**
 * red-ops/config STANDING 1: "A George comment on a done card is DIRECTION.
 * Done is not deaf." The gate fetches done cards too, or it would silently
 * swallow that direction on every quiet tick.
 */
describe('red-ops-triage — done is not deaf', () => {
  const doneCard = card({
    id: 'donecard',
    status: 'done',
    commentCount: 5,
    updatedAt: new Date().toISOString(),
    dispatch: {},
  });

  it('runs on a new George comment on a recently-DONE card', async () => {
    const r = await runTick({
      items: [card(), doneCard],
      runs: { run_w1: 'running' },
      comments: {
        donecard: [{ author: GEORGE, body: 'actually, follow up on this', createdAt: T1 }],
      },
      memo: settledMemo({
        seen: {
          card1: { s: 'working', c: 2, u: T0 },
          donecard: { s: 'done', c: 4, u: T0 },
        },
      }),
    });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('deterministic');
    expect(r.decision.reason).toContain('human comment');
    expect(r.neuronCalls).toBe(0);
  });

  it('ignores done cards older than the 7-day window (no baseline churn)', async () => {
    const stale = card({
      id: 'oldcard',
      status: 'done',
      commentCount: 9,
      updatedAt: '2026-01-01T00:00:00.000Z',
      dispatch: {},
    });
    const r = await runTick({
      items: [card(), stale],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
    });

    expect(r.route).toBe('stop'); // an ancient done card is not a signal
    expect(r.memo.seen.oldcard).toBeUndefined();
  });

  it('catches a comment that landed in the baseline-write race (delta, not just timestamp)', async () => {
    // createdAt is BEFORE the memo's updatedAt (clock/write race), so the
    // timestamp test alone would call it old — the commentCount delta saves it.
    const r = await runTick({
      items: [card({ commentCount: 3, updatedAt: T1 })],
      runs: { run_w1: 'running' },
      comments: {
        card1: [
          { author: AGENT, body: 'older', createdAt: '2026-07-14T17:00:00.000Z' },
          { author: AGENT, body: 'older2', createdAt: '2026-07-14T17:30:00.000Z' },
          { author: GEORGE, body: 'landed mid-write', createdAt: '2026-07-14T17:59:59.000Z' },
        ],
      },
      memo: settledMemo(),
    });

    expect(r.route).toBe('run');
    expect(r.decision.reason).toContain('human comment');
  });
});

describe('red-ops-triage — the neuron only adjudicates ambiguous changes', () => {
  const ambiguous = {
    items: [card({ commentCount: 3, updatedAt: T1 })],
    runs: { run_w1: 'running' },
    comments: {
      card1: [{ author: AGENT, body: 'HANDOFF: still working, no PR yet', createdAt: T1 }],
    },
    memo: settledMemo(),
  };

  it('asks the neuron when an agent comment changed a worked card, and honours a "no"', async () => {
    const r = await runTick(ambiguous);

    expect(r.signals.needsBrain).toBe(true);
    expect(r.neuronCalls).toBe(1);
    expect(r.route).toBe('stop');
    expect(r.decision.via).toBe('neuron');
  });

  it('honours a "yes" and forwards the focus hint to the coordinator', async () => {
    const r = await runTick({
      ...ambiguous,
      neuronOutput: '```json\n{"actionable":true,"reason":"handoff left bounded work","focus":"finish the migration"}\n```',
    });

    expect(r.route).toBe('run');
    expect(r.decision.focus).toBe('finish the migration');
  });

  it('fails OPEN when the neuron returns garbage', async () => {
    const r = await runTick({ ...ambiguous, neuronOutput: 'I think maybe?' });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('failopen');
  });

  it('fails OPEN when the neuron step errored out (empty fallback)', async () => {
    const r = await runTick({ ...ambiguous, neuronOutput: '' });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('failopen');
  });
});

/**
 * A needs-input card waiting on George does not change between ticks. Without
 * memoised verdicts the neuron would re-adjudicate the same unchanged thread
 * 96x/day forever — the exact recurring cost this card exists to remove.
 */
describe('red-ops-triage — the neuron is not asked the same question twice', () => {
  const blocked = card({
    id: 'blocked1',
    status: 'needs-input',
    commentCount: 3,
    dispatch: {},
  });
  const scenario = (memo: Any) => ({
    items: [card(), blocked],
    runs: { run_w1: 'running' },
    comments: {
      blocked1: [{ author: AGENT, body: '@george — which approach?', createdAt: T0 }],
    },
    memo,
  });

  it('asks once about an unjudged blocked card, and memoises the "no"', async () => {
    const r = await runTick(
      scenario(settledMemo({ seen: { card1: { s: 'working', c: 2, u: T0 }, blocked1: { s: 'needs-input', c: 3, u: T0 } } })),
    );

    expect(r.neuronCalls).toBe(1);
    expect(r.route).toBe('stop');
    expect(r.memo.judged.blocked1).toBe(`needs-input|3|${T0}`);
  });

  it('does not ask again while that card is unchanged', async () => {
    const r = await runTick(
      scenario(
        settledMemo({
          seen: { card1: { s: 'working', c: 2, u: T0 }, blocked1: { s: 'needs-input', c: 3, u: T0 } },
          judged: { blocked1: `needs-input|3|${T0}` },
        }),
      ),
    );

    expect(r.neuronCalls).toBe(0); // free tick
    expect(r.route).toBe('stop');
    expect(r.memo.judged.blocked1).toBe(`needs-input|3|${T0}`); // verdict carried forward
  });

  it('re-opens the question the moment that card changes', async () => {
    const r = await runTick({
      items: [card(), card({ id: 'blocked1', status: 'needs-input', commentCount: 4, updatedAt: T1, dispatch: {} })],
      runs: { run_w1: 'running' },
      comments: { blocked1: [{ author: AGENT, body: 'unblocked it myself, work remains', createdAt: T1 }] },
      memo: settledMemo({
        seen: { card1: { s: 'working', c: 2, u: T0 }, blocked1: { s: 'needs-input', c: 3, u: T0 } },
        judged: { blocked1: `needs-input|3|${T0}` },
      }),
      neuronOutput: JSON.stringify({ actionable: true, reason: 'agent-resolvable now', focus: 'resume it' }),
    });

    expect(r.neuronCalls).toBe(1);
    expect(r.route).toBe('run');
    expect(r.memo.judged.blocked1).toBeUndefined(); // a "yes" is never memoised
  });
});

describe('red-ops-triage — fail-open guarantees', () => {
  it('runs when /api/board could not be fetched', async () => {
    const r = await runTick({ boardOk: false, memo: settledMemo() });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('failopen');
    expect(r.decision.reason).toContain('board fetch failed');
    expect(r.neuronCalls).toBe(0);
  });

  it('runs on the very first tick (no baseline to diff against)', async () => {
    const r = await runTick({ items: [card()], runs: { run_w1: 'running' }, memo: null });

    expect(r.route).toBe('run');
    expect(r.decision.reason).toContain('first run');
    expect(r.memo.seen.card1).toBeTruthy(); // baseline now exists for the next tick
  });

  it('runs when triage is switched off in red-ops/config', async () => {
    const r = await runTick({
      items: [card()],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
      cfg: { triage: false },
    });

    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('disabled');
    expect(r.neuronCalls).toBe(0);
  });
});

describe('red-ops-triage — auth', () => {
  it('sends the ATLAS token from the automation secrets', async () => {
    const r = await runTick({ items: [card()], runs: { run_w1: 'running' }, memo: settledMemo() });
    const board = r.toolCalls.find((c) => c.tool === 'fetch_url')!;
    expect(board.params.headers.Authorization).toBe('Bearer test-token');
  });

  it('falls back to red-ops/config.atlasToken when no _secrets were injected', async () => {
    // Without this fallback a token-less run 401s on /api/board and fails open
    // on EVERY tick — the gate would look healthy while saving nothing.
    const r = await runTick({
      items: [card()],
      runs: { run_w1: 'running' },
      memo: settledMemo(),
      cfg: { atlasToken: 'cfg-token' },
      secrets: false,
    });
    const board = r.toolCalls.find((c) => c.tool === 'fetch_url')!;
    expect(board.params.headers.Authorization).toBe('Bearer cfg-token');
    expect(r.route).toBe('stop');
  });
});

describe('red-ops-triage — iteration caps', () => {
  it('probes at most maxRunProbes in-flight runs', async () => {
    const dispatched = Array.from({ length: 9 }, (_, i) => ({
      workerRunId: `run_x${i}`,
      status: 'running',
    }));
    const r = await runTick({
      items: [card()],
      runs: Object.fromEntries(dispatched.map((d) => [d.workerRunId, 'running'])),
      memo: settledMemo(),
      opsState: { dispatched },
    });

    const probes = r.toolCalls.filter((c) => c.tool === 'get_run');
    expect(probes).toHaveLength(PARAM_DEFAULTS.maxRunProbes);
    expect(new Set(probes.map((p) => p.params.runId)).size).toBe(PARAM_DEFAULTS.maxRunProbes);
  });

  it('caps comment fetches and fails OPEN rather than triaging a truncated view', async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      card({ id: `c${i}`, commentCount: 4, updatedAt: T1, dispatch: {} }),
    );
    const r = await runTick({
      items: many,
      memo: settledMemo({
        seen: Object.fromEntries(many.map((c) => [c.id, { s: 'working', c: 2, u: T0 }])),
      }),
      comments: Object.fromEntries(
        many.map((c) => [c.id, [{ author: AGENT, body: 'progress', createdAt: T1 }]]),
      ),
    });

    const fetches = r.toolCalls.filter((c) => c.tool === 'fetch_url' && /comments$/.test(c.params.url));
    expect(fetches).toHaveLength(PARAM_DEFAULTS.maxCommentFetches);
    expect(r.route).toBe('run');
    expect(r.decision.via).toBe('failopen');
    expect(r.neuronCalls).toBe(0);
  });
});

describe('red-ops-triage — gemini spend guardrail (the key is pay-per-use and fails open)', () => {
  const ambiguous = (memo: Any) => ({
    items: [card({ commentCount: 3, updatedAt: T1 })],
    runs: { run_w1: 'running' },
    comments: { card1: [{ author: AGENT, body: 'HANDOFF: wip', createdAt: T1 }] },
    memo,
  });

  it('meters each neuron call into the daily estimate', async () => {
    const r = await runTick(ambiguous(settledMemo()));

    expect(r.memo.spend.day).toBe(TODAY);
    expect(r.memo.spend.calls).toBe(4);
    expect(r.memo.spend.estUsd).toBeGreaterThan(0.0004);
  });

  it('rolls the counter over on a new day', async () => {
    const r = await runTick(
      ambiguous(settledMemo({ spend: { day: '2020-01-01', calls: 999, estUsd: 99, alertedDay: '2020-01-01' } })),
    );

    expect(r.spend.calls).toBe(0);
    expect(r.spend.overBudget).toBe(false);
    expect(r.memo.spend.calls).toBe(1);
  });

  it('stops calling gemini, alerts @george once, and fails OPEN once the budget is blown', async () => {
    const r = await runTick(
      ambiguous(settledMemo({ spend: { day: TODAY, calls: 12, estUsd: 5, alertedDay: '' } })),
    );

    expect(r.spend.overBudget).toBe(true);
    expect(r.neuronCalls).toBe(0); // hard stop on the pay-per-use key
    expect(r.route).toBe('run'); // ...but the fleet keeps working
    expect(r.decision.via).toBe('failopen');

    const alert = r.toolCalls.find((c) => c.tool === 'fetch_url' && String(c.params.url).endsWith('/api/notes'));
    expect(alert).toBeTruthy();
    const body = JSON.parse(alert!.params.body);
    expect(body.slug).toBe('redatlas');
    expect(body.body).toMatch(/^@george — Red Ops SPEND ALERT/);
    expect(r.memo.spend.alertedDay).toBe(TODAY); // dedup marker for the rest of the day
  });

  it('does not re-alert later the same day', async () => {
    const r = await runTick(
      ambiguous(settledMemo({ spend: { day: TODAY, calls: 12, estUsd: 5, alertedDay: TODAY } })),
    );

    expect(r.spend.overBudget).toBe(true);
    expect(r.spend.alertNeeded).toBe(false);
    expect(r.toolCalls.some((c) => String(c.params.url || '').endsWith('/api/notes'))).toBe(false);
    expect(r.route).toBe('run');
  });

  it('trips on the call cap even when the dollar estimate is low', async () => {
    const r = await runTick(
      ambiguous(settledMemo({ spend: { day: TODAY, calls: 300, estUsd: 0.02, alertedDay: '' } })),
    );

    expect(r.spend.overBudget).toBe(true);
    expect(r.neuronCalls).toBe(0);
    expect(r.route).toBe('run');
  });

  it('honours budget overrides from red-ops/config', async () => {
    const r = await runTick({
      ...ambiguous(settledMemo({ spend: { day: TODAY, calls: 3, estUsd: 0.5, alertedDay: '' } })),
      cfg: { geminiDailyBudgetUsd: 0.25 },
    });

    expect(r.spend.budget).toBe(0.25);
    expect(r.spend.overBudget).toBe(true);
    expect(r.neuronCalls).toBe(0);
  });
});
