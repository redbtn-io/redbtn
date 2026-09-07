/**
 * `claude-code` executor — LIVE, against the real Claude Code CLI.
 *
 * Everything else in this branch tests the executor against a stand-in CLI and
 * the bridge against a hand-rolled JSON-RPC client. Both are necessary and
 * neither proves the thing that actually has to work: that a REAL
 * `claude -p` child, spawned with the exact flags `buildSpawnArgs` produces,
 * discovers the per-run bridge over its Unix socket, is offered nothing but
 * `mcp__redbtn__*` names, calls one of them, and gets a real answer back.
 *
 * This test does that, end to end, with no mocks in the path:
 *
 *   real CLI  ──stdio──▶  run-bridge-shim  ──UDS──▶  run-bridge
 *                                                        │
 *                                                        ▼
 *                                            native registry → `now`
 *
 * ## Why it is skipped by default
 *
 * It spends a real Claude subscription turn. CI has no token, so the whole
 * suite skips and stays green; a developer with `CLAUDE_CODE_OAUTH_TOKEN` in
 * the environment (and the CLI on `PATH`) gets the real check. There is no
 * fixture, no recording and no fallback: a run that cannot reach Anthropic is
 * a skipped run, never a passing one.
 *
 * ## Why `now`
 *
 * It is the only interesting harmless tool in the registry: pure, no
 * environment, no credentials, no side effects, and an answer the model cannot
 * produce without actually calling it — a wall-clock timestamp. A tool the
 * model could guess would prove nothing.
 *
 * Run it here with:
 *   CLAUDE_CODE_OAUTH_TOKEN="$(cat …)" npx vitest run tests/nodes/claude-code-live.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runClaudeCodeStep,
  runDirRoot,
} from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import nowTool from '../../src/lib/tools/native/now';

// =============================================================================
// Gate
// =============================================================================

const TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;

/** Is the real CLI on PATH? A token without a binary is still a skip. */
function cliVersion(): string | null {
  try {
    return execFileSync(process.env.CLAUDE_CODE_BIN || 'claude', ['--version'], {
      encoding: 'utf8',
      timeout: 20_000,
    }).trim();
  } catch {
    return null;
  }
}

const CLI_VERSION = TOKEN ? cliVersion() : null;
const LIVE = Boolean(TOKEN && CLI_VERSION);

/**
 * Fable rather than Opus: this test asserts plumbing, not reasoning, and the
 * plumbing is identical. Override for a one-off check against another model.
 */
const MODEL = process.env.CLAUDE_CODE_TEST_MODEL || 'claude-fable-5-1';

// =============================================================================
// The stdio shim has to exist as JavaScript
// =============================================================================

/**
 * `run-bridge.ts`'s `resolveShimPath()` resolves the shim next to itself and
 * always with a `.js` extension — correct in `dist`, where the build put it,
 * and correct on a worker. Under vitest the sources are `.ts` and nothing is
 * built, so the path names a file that does not exist, the CLI's MCP server
 * dies on spawn, and the init guard rejects the session with
 * "the 'redbtn' MCP server reported status 'failed'".
 *
 * So compile the real shim to exactly the path the bridge will name, run
 * against it, and remove it afterwards. This transpiles the actual source —
 * it is not a stand-in.
 *
 * (Worth knowing for its own sake: because `resolveShimPath` never checks that
 * the file is there, a packaging slip that omitted the shim from `dist` would
 * present as the same opaque init failure rather than as a missing file.)
 */
const SHIM_TS = path.join(__dirname, '..', '..', 'src', 'lib', 'mcp', 'run-bridge-shim.ts');
const SHIM_JS = SHIM_TS.replace(/\.ts$/, '.js');
let shimWasBuiltHere = false;

async function buildShim(): Promise<void> {
  if (fs.existsSync(SHIM_JS)) return; // a real build already put one here
  const ts = await import('typescript');
  const compiler = (ts as unknown as { default?: typeof ts }).default ?? ts;
  const { outputText } = compiler.transpileModule(fs.readFileSync(SHIM_TS, 'utf8'), {
    compilerOptions: {
      module: compiler.ModuleKind.CommonJS,
      target: compiler.ScriptTarget.ES2022,
    },
  });
  fs.writeFileSync(SHIM_JS, outputText, { mode: 0o644 });
  shimWasBuiltHere = true;
}

// =============================================================================
// Harness
// =============================================================================

interface CapturedTool {
  kind: 'start' | 'complete' | 'error';
  toolId: string;
  name?: string;
  type?: string;
  options?: Record<string, unknown>;
}

function makePublisher() {
  const chunks: string[] = [];
  const thinking: string[] = [];
  const tools: CapturedTool[] = [];
  return {
    chunks,
    thinking,
    tools,
    async chunk(text: string) {
      chunks.push(text);
    },
    async thinkingChunk(text: string) {
      thinking.push(text);
    },
    async toolStart(toolId: string, name: string, type: string, options: Record<string, unknown>) {
      tools.push({ kind: 'start', toolId, name, type, options });
    },
    async toolComplete(toolId: string) {
      tools.push({ kind: 'complete', toolId });
    },
    async toolError(toolId: string, error: string) {
      tools.push({ kind: 'error', toolId, name: error });
    },
    async getState() {
      return { status: 'running' };
    },
  };
}

let tmpRoot: string;
let savedRunDirRoot: string | undefined;

beforeAll(async () => {
  if (LIVE) await buildShim();
});

afterAll(() => {
  if (shimWasBuiltHere) fs.rmSync(SHIM_JS, { force: true });
});

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-live-'));
  savedRunDirRoot = process.env.REDBTN_RUN_DIR_ROOT;
  process.env.REDBTN_RUN_DIR_ROOT = path.join(tmpRoot, 'run');

  // The registry loads its tools with `require('./native/<name>.js')`, which
  // finds nothing under vitest (the sources are `.ts` and never built here).
  // Registering the REAL `now` definition by import keeps the tool's actual
  // implementation in the path and replaces only the loader — the thing being
  // proved is the bridge and the CLI, not CommonJS resolution.
  getNativeRegistry().register('now', nowTool);
});

afterEach(() => {
  if (savedRunDirRoot === undefined) delete process.env.REDBTN_RUN_DIR_ROOT;
  else process.env.REDBTN_RUN_DIR_ROOT = savedRunDirRoot;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Every file left under a directory, recursively. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// =============================================================================
// The test
// =============================================================================

describe.skipIf(!LIVE)(`claude-code executor, live against the real CLI (${CLI_VERSION})`, () => {
  it(
    'spawns the real CLI, which calls `now` through the bridge and answers with the time',
    async () => {
      const publisher = makePublisher();
      const runId = `run_live_${Math.random().toString(36).slice(2, 8)}`;
      const usage: Array<{ response: unknown; hint?: string; stepId?: string }> = [];

      // A window the answer must fall inside. Anything the model invented
      // instead of reading off the tool result lands outside it.
      const before = Date.now();

      const out = await runClaudeCodeStep({
        config: {
          neuronId: 'opus-5-live',
          outputField: 'data.liveAnswer',
          systemPrompt:
            'You have exactly one tool. Use it, then answer in one short sentence.',
          userPrompt:
            'Call the now tool with format "iso" and reply with the time it returns, verbatim.',
          stream: true,
          tools: ['now'],
          maxToolIterations: 4,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        state: {
          runId,
          userId: 'user_live_test',
          runPublisher: publisher,
          data: { runId, userId: 'user_live_test' },
        },
        neuronCfg: {
          id: 'opus-5-live',
          name: 'Opus 5',
          provider: 'claude-code',
          endpoint: 'claude-code://worker',
          model: MODEL,
          apiKey: TOKEN,
          secretName: 'CLAUDE_CODE_OAUTH',
          role: 'worker',
          tier: 1,
          // Exercises the `parameters` path this branch added to the Mongoose
          // schema, `NeuronConfig` and `NeuronRegistry.getConfig`: without it
          // `--effort` could not be passed at all. 'low' keeps the live turn
          // cheap; the executor's own default is 'xhigh'.
          parameters: { effort: 'low' },
        },
        neuronId: 'opus-5-live',
        userId: 'user_live_test',
        callRunId: runId,
        abortSignal: undefined,
        emitUsage: (response, hint, stepId) => usage.push({ response, hint, stepId }),
      });

      const after = Date.now();

      // ── 1. the tool call arrived through the bridge ──────────────────────
      // The CLI saw it as `mcp__redbtn__now`; the bridge dispatches the bare
      // name against the native registry and publishes THAT, with a real tool
      // id, exactly as an API neuron's tool loop would.
      const starts = publisher.tools.filter((t) => t.kind === 'start');
      expect(starts.length).toBeGreaterThanOrEqual(1);
      const nowStart = starts.find((t) => t.name === 'now');
      expect(nowStart, `no 'now' toolStart; saw: ${starts.map((s) => s.name).join(', ')}`).toBeDefined();
      expect(nowStart!.type).toBe('native');
      expect(nowStart!.options?.bridge).toBe(true);
      expect(nowStart!.options?.triggeredBy).toBe('neuron');
      expect(nowStart!.options?.neuronStepId).toBe('data.liveAnswer');
      // It completed rather than erroring, and the completion is paired to the
      // same tool id.
      expect(publisher.tools).toContainEqual(
        expect.objectContaining({ kind: 'complete', toolId: nowStart!.toolId }),
      );

      // ── 2. the final text carries the time the tool returned ─────────────
      const text = out['data.liveAnswer'];
      expect(typeof text).toBe('string');
      expect((text as string).length).toBeGreaterThan(0);

      const iso = (text as string).match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(iso, `no ISO timestamp in the answer: ${JSON.stringify(text)}`).not.toBeNull();
      // Read off the tool, not invented: within the window the step ran in,
      // with a minute of slack for clock skew and the model's rounding.
      const answered = Date.parse(`${iso![0]}Z`);
      expect(answered).toBeGreaterThanOrEqual(before - 60_000);
      expect(answered).toBeLessThanOrEqual(after + 60_000);

      // ── 3. the CLI's own accounting came back ────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cli = (out['data._cli'] as any)['data.liveAnswer'];
      expect(cli.model).toBe(MODEL);
      expect(cli.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // A tool call plus an answer is at least two turns.
      expect(cli.numTurns).toBeGreaterThanOrEqual(2);
      // The one assertion that would catch the bridge silently refusing a call
      // the CLI was allowed to make.
      expect(cli.permissionDenials).toBe(0);
      expect(cli.usage.input_tokens).toBeGreaterThan(0);
      expect(cli.usage.output_tokens).toBeGreaterThan(0);
      expect(cli.usage.total_tokens).toBe(cli.usage.input_tokens + cli.usage.output_tokens);

      // ── 4. usage was metered under the subscription's own model string ───
      expect(usage.length).toBeGreaterThanOrEqual(1);
      expect(usage[0].hint).toBe(`claude-code/${MODEL}`);
      expect(usage[0].stepId).toBe('data.liveAnswer:cli');

      // ── 5. nothing left on disk ──────────────────────────────────────────
      // The socket, mcp.json, CLAUDE_CONFIG_DIR and TMPDIR all lived under the
      // step directory, and the token was only ever an env value of a process
      // that has since exited.
      const root = runDirRoot();
      expect(fs.existsSync(root) ? walk(root) : []).toEqual([]);

      if (process.env.CLAUDE_CODE_TEST_EVIDENCE) {
        console.log('EVIDENCE', JSON.stringify({
          cliVersion: CLI_VERSION, model: MODEL,
          toolEvents: publisher.tools.map((t) => ({ kind: t.kind, name: t.name, toolId: t.toolId })),
          answer: text, chunks: publisher.chunks.length, cli,
          usageHints: usage.map((u) => ({ hint: u.hint, stepId: u.stepId })),
        }, null, 2));
      }

      // Streaming reached the run publisher (the node is not named
      // respond/responder, so the executor publishes rather than deferring to
      // `functions/run.ts`).
      expect(publisher.chunks.join('')).not.toBe('');
    },
    300_000,
  );
});
