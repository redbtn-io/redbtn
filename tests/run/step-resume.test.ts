/**
 * Interrupt continuation (lib/run/step-resume.ts): an interrupted neuron step
 * keeps its transcript; the run started with resumeFromRunId continues it.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import {
  toStoredTranscript,
  closeDanglingToolCalls,
  buildContinuedMessages,
  StepResumeTracker,
  awaitStepResume,
  saveStepResume,
  loadStepResume,
  stepResumeKey,
  noticeFor,
  INTERRUPTED_TOOL_RESULT,
  INTERRUPT_NOTICE_TAG,
  packFile,
  unpackFile,
  claudeProjectSlug,
  shrinkMessages,
  pickTranscriptFiles,
  claudeTranscriptHasTurns,
} from '../../src/lib/run/step-resume';
import { runNativeToolUseLoop } from '../../src/lib/nodes/universal/executors/neuronExecutor';
import { collectAgyConversation, restoreAgyConversation } from '../../src/lib/nodes/universal/executors/agyCliExecutor';
import { collectClaudeTranscript } from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';
import type { ResolvedTool } from '../../src/lib/tools/tool-resolver';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function fakeRedis() {
  const h = new Map<string, Map<string, string>>();
  return {
    h,
    async hset(k: string, f: string, v: string) { if (!h.has(k)) h.set(k, new Map()); h.get(k)!.set(f, v); },
    async hget(k: string, f: string) { return h.get(k)?.get(f) ?? null; },
    async hdel(k: string, ...fs: string[]) { for (const f of fs) h.get(k)?.delete(f); },
    async expire() { return 1; },
  };
}

describe('transcripts', () => {
  it('a tool call without a result gets a synthetic "interrupted before completion" result', () => {
    const t = toStoredTranscript([
      new SystemMessage('sys'),
      new HumanMessage('do A'),
      new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'read', args: { p: 1 } }, { id: 't2', name: 'slow', args: {} }] }),
      new ToolMessage({ content: 'contents', tool_call_id: 't1', name: 'read' }),
    ]);
    expect(t.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'tool']);
    expect(t[4]).toMatchObject({ role: 'tool', tool_call_id: 't2', name: 'slow', content: INTERRUPTED_TOOL_RESULT });
    // plain {role} objects (the loop pushes these for tool results) are understood too
    expect(closeDanglingToolCalls(toStoredTranscript([{ role: 'tool', tool_call_id: 'x', content: 'r' }]))).toHaveLength(1);
  });

  it('images and oversized tool results are slimmed; a record can be shrunk', () => {
    const t = toStoredTranscript([
      new HumanMessage({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'look' }] as Any }),
      new ToolMessage({ content: 'x'.repeat(60_000), tool_call_id: 'a' }),
    ]);
    expect(JSON.stringify(t[0].content)).toContain('[image omitted on resume]');
    expect(String(t[1].content)).toMatch(/truncated on resume/);
    const s = shrinkMessages([{ role: 'tool', content: 'y'.repeat(5000), tool_call_id: 'a' }], 1000);
    expect(s[0].content).toMatch(/dropped on resume/);
  });

  it('continued opening: fresh system, own history, notice + new prompt (once)', () => {
    const resumed = toStoredTranscript([
      new SystemMessage('old sys'),
      new HumanMessage('task A'),
      new AIMessage({ content: '', tool_calls: [{ id: 't1', name: 'read', args: {} }] }),
      new ToolMessage({ content: 'r1', tool_call_id: 't1', name: 'read' }),
    ]);
    const out = buildContinuedMessages([new SystemMessage('new sys'), new HumanMessage('message B')], resumed);
    expect(out.map((m: Any) => m._getType())).toEqual(['system', 'human', 'ai', 'tool', 'human']);
    expect(out[0].content).toBe('new sys');
    expect((out[2] as Any).tool_calls[0]).toMatchObject({ id: 't1', name: 'read' });
    expect(out[4].content).toContain(INTERRUPT_NOTICE_TAG);
    expect(out[4].content).toContain('message B');
    // a prompt that already carries a notice is not wrapped twice
    expect(noticeFor(`${INTERRUPT_NOTICE_TAG} custom\nB`)).toBe(`${INTERRUPT_NOTICE_TAG} custom\nB`);
  });

  it('step key = graph node id + step index', () => {
    expect(stepResumeKey({ _currentGraphNodeId: 'operator', _currentStepIndex: 3 }, { outputField: 'data.r' })).toBe('operator#3');
    expect(stepResumeKey({}, { outputField: 'data.r' })).toBe('out:data.r');
  });
});

describe('API tool loop: interrupt, then continue', () => {
  function tools(log: string[], onSlow?: () => void): ResolvedTool[] {
    return [
      { name: 'step', description: 'step', inputSchema: { type: 'object', properties: { n: { type: 'number' } } }, source: 'native',
        invoke: async (a: Any) => { log.push(`step${a.n}`); if (a.n === 3 && onSlow) { onSlow(); throw new Error('ssh command killed by run interrupt'); } return { ok: a.n }; } },
    ];
  }
  const runState = (redis: Any, runId: string, extra: Any = {}) => ({
    runId,
    _currentGraphNodeId: 'operator',
    _currentStepIndex: 2,
    runPublisher: { chunk: async () => {}, toolStart: async () => {}, toolComplete: async () => {}, toolError: async () => {}, getRedisClient: () => redis },
    data: { ...extra },
  });

  it('run A is interrupted during its 3rd tool call; run B sees A\'s calls as its own history and does not redo them', async () => {
    const redis = fakeRedis();
    const log: string[] = [];
    const ac = new AbortController();
    let callsA = 0;
    const registryA = {
      callNeuron: async () => {
        callsA += 1;
        return { content: '', tool_calls: [{ id: `a${callsA}`, name: 'step', args: { n: callsA } }] };
      },
    };
    await expect(runNativeToolUseLoop({
      config: { userPrompt: 'task A', outputField: 'data.r' } as Any,
      state: runState(redis, 'runA'),
      model: { bindTools: () => ({}) },
      baseMessages: [new SystemMessage('sys'), new HumanMessage('Do steps 1..5')],
      resolvedTools: tools(log, () => ac.abort()),
      neuronId: 'n', userId: 'u', callRunId: 'runA', abortSignal: ac.signal, neuronRegistry: registryA,
    } as Any)).rejects.toThrow();
    expect(log).toEqual(['step1', 'step2', 'step3']);

    const saved = await loadStepResume(redis as Any, 'runA', 'operator#2');
    expect(saved?.status).toBe('interrupted');
    const roles = saved!.messages!.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool']);
    expect(saved!.messages![7].content).toBe(INTERRUPTED_TOOL_RESULT);

    // Run B continues A.
    let seen: Any[] = [];
    const registryB = {
      callNeuron: async (_n: string, _u: string, msgs: Any[]) => { seen = msgs; return { content: 'Answered B; steps 1-3 were done, 4-5 left.', tool_calls: [] }; },
    };
    const out = await runNativeToolUseLoop({
      config: { userPrompt: 'msg B', outputField: 'data.r' } as Any,
      state: runState(redis, 'runB', { previousRun: { runId: 'runA' } }),
      model: { bindTools: () => ({}) },
      baseMessages: [new SystemMessage('sys'), new HumanMessage('What is the weather?')],
      resolvedTools: tools(log),
      neuronId: 'n', userId: 'u', callRunId: 'runB', abortSignal: undefined, neuronRegistry: registryB,
    } as Any);
    expect(out).toMatch(/Answered B/);
    expect(log).toEqual(['step1', 'step2', 'step3']); // nothing redone
    const types = seen.map((m: Any) => (m._getType ? m._getType() : m.role));
    expect(types).toEqual(['system', 'human', 'ai', 'tool', 'ai', 'tool', 'ai', 'tool', 'human']);
    expect(seen[1].content).toBe('Do steps 1..5');
    expect(seen[8].content).toContain(INTERRUPT_NOTICE_TAG);
    expect(seen[8].content).toContain('What is the weather?');
    // A's record was consumed, B completed and left none.
    expect(await loadStepResume(redis as Any, 'runA', 'operator#2')).toBeNull();
    expect(await loadStepResume(redis as Any, 'runB', 'operator#2')).toBeNull();
  });

  it('continueInterrupted:false opts a step out; no redis = today\'s behaviour', async () => {
    const redis = fakeRedis();
    await saveStepResume(redis as Any, 'runA', { v: 1, stepKey: 'operator#2', kind: 'api', status: 'interrupted', updatedAt: 1, messages: [{ role: 'user', content: 'old' }] });
    const t = await StepResumeTracker.create({ ...runState(redis, 'runB', { previousRun: { runId: 'runA' } }) }, { outputField: 'data.r', continueInterrupted: false }, 'api');
    expect(t.resumed).toBeNull();
    const t2 = await StepResumeTracker.create({ data: { previousRun: { runId: 'runA' } } }, { outputField: 'x' }, 'api');
    expect(t2.enabled).toBe(false);
    expect(t2.seed([new HumanMessage('hi')])).toHaveLength(1);
  });
});

describe('CLI records', () => {
  it('a continuing run waits for the interrupted CLI step to finish saving its transcript', async () => {
    const redis = fakeRedis();
    await saveStepResume(redis as Any, 'runA', { v: 1, stepKey: 'k', kind: 'cli', status: 'in-progress', updatedAt: 1, cli: 'claude-code', sessionId: 's' });
    setTimeout(() => {
      void saveStepResume(redis as Any, 'runA', { v: 1, stepKey: 'k', kind: 'cli', status: 'interrupted', updatedAt: 2, cli: 'claude-code', sessionId: 's', files: { 's.jsonl': packFile(Buffer.from('{}\n')) } });
    }, 50);
    const rec = await awaitStepResume(redis as Any, 'runA', 'k', { kind: 'cli', pollMs: 10, maxWaitMs: 2000 });
    expect(rec?.status).toBe('interrupted');
    expect(unpackFile(rec!.files!['s.jsonl']).toString()).toBe('{}\n');
  });

  it('claude transcript is collected from any project slug; slug matches the CLI', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-'));
    fs.mkdirSync(path.join(d, '-ws-x-tree'), { recursive: true });
    fs.writeFileSync(path.join(d, '-ws-x-tree', 'sid-1.jsonl'), 'line\n');
    const files = collectClaudeTranscript(d, 'sid-1');
    expect(unpackFile(files['sid-1.jsonl']).toString()).toBe('line\n');
    expect(claudeProjectSlug('/tmp/cctest/cwd')).toBe('-tmp-cctest-cwd');
  });

  it('agy conversation round-trips; a path escape is refused', () => {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'agyA-'));
    const cid = '11111111-2222-3333-4444-555555555555';
    fs.mkdirSync(path.join(a, 'conversations'));
    fs.writeFileSync(path.join(a, 'conversations', `${cid}.db`), 'db');
    fs.mkdirSync(path.join(a, 'brain', cid, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(path.join(a, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl'), 't');
    const files = collectAgyConversation(a, cid);
    expect(Object.keys(files).sort()).toEqual([`brain/${cid}/.system_generated/logs/transcript.jsonl`, `conversations/${cid}.db`]);
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'agyB-'));
    restoreAgyConversation(b, { ...files, '../escape.txt': packFile(Buffer.from('x')) });
    expect(fs.readFileSync(path.join(b, 'conversations', `${cid}.db`), 'utf8')).toBe('db');
    expect(fs.existsSync(path.join(path.dirname(b), 'escape.txt'))).toBe(false);
  });
});

describe('kill snapshot vs the stub a dying CLI rewrites', () => {
  const real = packFile(Buffer.from('{"type":"user","message":{}}\n{"type":"assistant","message":{}}\n{"type":"last-prompt"}\n'));
  const stub = packFile(Buffer.from('{"type":"last-prompt","lastPrompt":"x"}\n{"type":"atis-latch","atis":""}\n'));
  it('prefers the larger snapshot over a later stub', () => {
    expect(pickTranscriptFiles({ 's.jsonl': stub }, { 's.jsonl': real })).toEqual({ 's.jsonl': real });
  });
  it('keeps the later read when it grew past the snapshot', () => {
    expect(pickTranscriptFiles({ 's.jsonl': real }, { 's.jsonl': stub })).toEqual({ 's.jsonl': real });
  });
  it('falls back to the later read with no snapshot', () => {
    expect(pickTranscriptFiles({ 's.jsonl': stub }, null)).toEqual({ 's.jsonl': stub });
  });
  it('a stub has no turns, so it is never resumed', () => {
    expect(claudeTranscriptHasTurns({ 's.jsonl': stub })).toBe(false);
    expect(claudeTranscriptHasTurns({ 's.jsonl': real })).toBe(true);
  });
});
