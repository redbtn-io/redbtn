/**
 * `claude-code` stream ORDER — the 0.0.241 prod regression.
 *
 * # What George saw
 *
 * A live redChat turn, minutes after the deploy. The run's persisted
 * `output.data.response` was correct; the bubble assembled from the SSE
 * `content_chunk` events was this:
 *
 *   "…the cattiest, most standoffish soundal kingdom cr in the animest
 *    nossed with the politationality on Earth. …into silead we get "nence,
 *    but inst 🐱🍁yaa, eh?""
 *
 * Character-for-character it is an exact PERMUTATION of the right answer —
 * same multiset, same length, nothing duplicated, nothing lost. The pieces
 * reassemble byte-exactly once put back in offset order. That rules out the
 * envelope reconciliation and the old `result.result` splice (both of which
 * would ADD text) and points at one thing: the chunks were published out of
 * order.
 *
 * # Why
 *
 * `RunPublisher.chunk` awaits a Redis publish on the run channel — and, for
 * the first chunk of a segment, a `startMessage` round trip — BEFORE it
 * forwards `content_chunk` to the conversation channel. The executor fired one
 * of those calls per stream-json line without awaiting, so the conversation's
 * event order was the order those awaits happened to resolve in. Adjacent
 * chunks swap under ordinary Redis jitter, and the first chunk (two round
 * trips) is overtaken the most. Before #395 the executor never streamed from a
 * `responder` node and run.ts's replay awaited every chunk, so the ordering
 * hazard was latent.
 *
 * # The contract
 *
 * 1. ONE source of text per message: deltas when the message produced any,
 *    the `assistant` envelope only for a message that produced none — and then
 *    only the suffix beyond what that message id already contributed.
 * 2. `result.result` is NEVER emitted as a chunk. A disagreement between the
 *    stream and the answer is corrected once, as a replacement of the run's
 *    final content (`run_complete.finalContent`), never as more chunks.
 * 3. Every publish from the step goes out in the order the model produced it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runClaudeCodeStep,
  createStreamHandler,
} from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';

// =============================================================================
// The fixture: a real `claude -p` turn, recorded off the wire
// =============================================================================

/**
 * Recorded 2026-09-08 from the real CLI (2.1.263, `claude-fable-5-1`) with
 * `--output-format stream-json --verbose --include-partial-messages` on a
 * ~60-word answer: 9 text deltas, one `assistant` envelope, one `result`.
 *
 * The property that matters, and that the recording confirms: the deltas, the
 * envelope's text and `result.result` are IDENTICAL, all 371 characters. In a
 * healthy turn the envelope and the result must therefore contribute nothing
 * at all — any byte they emit on top of the deltas is a second writer.
 */
const FIXTURE = fs
  .readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-code-stream-json-turn.jsonl'), 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Record<string, unknown>);

function fixtureEvents(type: string) {
  return FIXTURE.filter((e) => e.type === type);
}

const FIXTURE_RESULT = fixtureEvents('result')[0] as { result: string };
const FIXTURE_ANSWER = FIXTURE_RESULT.result;

/** Every text delta in the capture, in wire order. */
const FIXTURE_DELTAS = FIXTURE.filter(
  (e) =>
    e.type === 'stream_event' &&
    (e.event as Record<string, unknown>)?.type === 'content_block_delta' &&
    ((e.event as Record<string, unknown>).delta as Record<string, unknown>)?.type === 'text_delta',
).map((e) => String((((e.event as Record<string, unknown>).delta) as Record<string, unknown>).text));

describe('the recorded turn is a fair fixture', () => {
  it('has real partial messages, an envelope and a result that all agree', () => {
    expect(FIXTURE_DELTAS.length).toBeGreaterThanOrEqual(5);
    expect(FIXTURE_ANSWER.split(/\s+/).length).toBeGreaterThan(40);
    const envelope = fixtureEvents('assistant')[0] as {
      message: { content: Array<{ type: string; text?: string }> };
    };
    const envelopeText = envelope.message.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    expect(FIXTURE_DELTAS.join('')).toBe(envelopeText);
    expect(envelopeText).toBe(FIXTURE_ANSWER);
  });
});

// =============================================================================
// 1. The reader — one source per message
// =============================================================================

describe('createStreamHandler — a single monotonic source', () => {
  function replay(events: unknown[]) {
    const chunks: string[] = [];
    const h = createStreamHandler({ onText: (t) => chunks.push(t) });
    for (const e of events) h.handle(JSON.stringify(e));
    return { chunks, state: h.state };
  }

  it('replays the recorded turn as exactly its deltas, in order', () => {
    const { chunks, state } = replay(FIXTURE);
    // Byte-exact, in order, and nothing added by the envelope or the result.
    expect(chunks).toEqual(FIXTURE_DELTAS);
    expect(chunks.join('')).toBe(FIXTURE_ANSWER);
    expect(state.text).toBe(FIXTURE_ANSWER);
  });

  it('emits no substring twice anywhere in the recorded turn', () => {
    const { chunks } = replay(FIXTURE);
    // Every chunk must land at the position the running total says it should:
    // an out-of-order or duplicated emission breaks this walk.
    let offset = 0;
    for (const chunk of chunks) {
      expect(FIXTURE_ANSWER.slice(offset, offset + chunk.length)).toBe(chunk);
      offset += chunk.length;
    }
    expect(offset).toBe(FIXTURE_ANSWER.length);
  });

  it('ignores the envelope of a message that already streamed deltas', () => {
    const { chunks } = replay([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_01' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello, ' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } } },
      // The envelope is cumulative and identical — it must add nothing.
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Hello, world' }] } },
      { type: 'result', subtype: 'success', result: 'Hello, world' },
    ]);
    expect(chunks).toEqual(['Hello, ', 'world']);
  });

  it('does NOT top up a message whose deltas stopped early — that is finalContent’s job', () => {
    const { chunks, state } = replay([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_01' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello, ' } } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Hello, world' }] } },
    ]);
    // Splicing the tail in here is what put a second writer on the stream.
    expect(chunks).toEqual(['Hello, ']);
    expect(state.text).toBe('Hello, ');
  });

  it('uses the envelope for a message that produced no deltas at all', () => {
    const { chunks } = replay([
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'It is 03:18 UTC.' }] } },
      { type: 'result', subtype: 'success', result: 'It is 03:18 UTC.' },
    ]);
    expect(chunks).toEqual(['It is 03:18 UTC.']);
  });

  it('emits only the suffix when a delta-less envelope repeats or grows', () => {
    const { chunks } = replay([
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Once.' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Once.' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Once. Twice.' }] } },
    ]);
    expect(chunks).toEqual(['Once.', ' Twice.']);
  });

  it('keeps a tool preamble and a delta-less answer in order, once each', () => {
    const { chunks, state } = replay([
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_01' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check. ' } } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Let me check. ' }, { type: 'tool_use', id: 'toolu_01', name: 'now' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_02', content: [{ type: 'text', text: 'It is 03:18 UTC.' }] } },
      { type: 'result', subtype: 'success', result: 'It is 03:18 UTC.' },
    ]);
    expect(chunks).toEqual(['Let me check. ', 'It is 03:18 UTC.']);
    expect(state.text).toBe('Let me check. It is 03:18 UTC.');
  });
});

// =============================================================================
// 2. The executor — ordering and the replacement
// =============================================================================

let tmpRoot: string;
let savedRunDirRoot: string | undefined;
let savedBin: string | undefined;

/**
 * A publisher whose `chunk` takes a VARYING amount of real time, longest for
 * the first call — the shape of `RunPublisher.chunk`, which awaits a Redis
 * publish and, on the first chunk of a segment, an extra `startMessage` round
 * trip. Any caller that does not serialise its calls records them out of order
 * against this.
 */
function makeJitteryPublisher() {
  const chunks: string[] = [];
  const replaced: string[] = [];
  let call = 0;
  return {
    chunks,
    replaced,
    async chunk(text: string) {
      const n = call++;
      // First call slowest, then descending — reordering is guaranteed for an
      // unserialised caller and impossible for a serialised one.
      await new Promise((r) => setTimeout(r, Math.max(1, 12 - n * 2)));
      chunks.push(text);
    },
    async thinkingChunk() {},
    async toolStart() {},
    async toolComplete() {},
    async toolError() {},
    async replaceOutputContent(text: string) {
      replaced.push(text);
    },
    async getState() {
      return { status: 'running' };
    },
  };
}

function writeFakeCli(events: unknown[]): string {
  const file = path.join(tmpRoot, `fake-claude-${Math.random().toString(36).slice(2, 8)}.js`);
  const emits = events.map((e) => `emit(${JSON.stringify(e)});`).join('\n');
  fs.writeFileSync(
    file,
    `#!${process.execPath}\n'use strict';\n` +
      'const fs = require("fs");\n' +
      'const emit = (o) => fs.writeSync(1, JSON.stringify(o) + "\\n");\n' +
      'process.stdin.resume();\n' +
      'process.stdin.on("end", () => { main(); });\n' +
      `function main() {\n${emits}\nprocess.exit(0);\n}\n`,
    { mode: 0o755 },
  );
  return file;
}

const NEURON_CFG = {
  id: 'sonnet-5',
  name: 'Sonnet 5',
  provider: 'claude-code',
  endpoint: 'claude-code://worker',
  model: 'claude-sonnet-5',
  apiKey: 'sk-ant-oat01-FAKE-TEST-TOKEN',
  secretName: 'claude-code-oauth',
  role: 'worker',
  tier: 1,
};

function runStep(events: unknown[], publisher: ReturnType<typeof makeJitteryPublisher>) {
  process.env.CLAUDE_CODE_BIN = writeFakeCli(events);
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  return runClaudeCodeStep({
    config: {
      neuronId: 'sonnet-5',
      outputField: 'data.response',
      systemPrompt: 'You are Sonnet 5.',
      userPrompt: 'hi',
      stream: true,
      tools: [],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    state: {
      runId,
      userId: 'user_test',
      runPublisher: publisher,
      // The node name every stock chat graph uses.
      nodeConfig: { graphNodeId: 'responder' },
      data: { runId, userId: 'user_test' },
    },
    neuronCfg: NEURON_CFG,
    neuronId: 'sonnet-5',
    userId: 'user_test',
    callRunId: runId,
    abortSignal: undefined,
    emitUsage: () => {},
  });
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-order-'));
  savedRunDirRoot = process.env.REDBTN_RUN_DIR_ROOT;
  savedBin = process.env.CLAUDE_CODE_BIN;
  process.env.REDBTN_RUN_DIR_ROOT = path.join(tmpRoot, 'run');
});

afterEach(() => {
  if (savedRunDirRoot === undefined) delete process.env.REDBTN_RUN_DIR_ROOT;
  else process.env.REDBTN_RUN_DIR_ROOT = savedRunDirRoot;
  if (savedBin === undefined) delete process.env.CLAUDE_CODE_BIN;
  else process.env.CLAUDE_CODE_BIN = savedBin;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('runClaudeCodeStep — the recorded turn, end to end', () => {
  it('publishes the recorded turn in order, with a slow-then-fast publisher', async () => {
    const publisher = makeJitteryPublisher();
    const out = await runStep(FIXTURE, publisher);

    // THE regression assertion: what the chat client concatenates is the
    // answer, byte for byte, in order.
    expect(publisher.chunks.join('')).toBe(FIXTURE_ANSWER);
    expect(publisher.chunks).toEqual(FIXTURE_DELTAS);
    expect(out['data.response']).toBe(FIXTURE_ANSWER);
    // The stream and the answer agreed, so nothing was replaced.
    expect(publisher.replaced).toEqual([]);
  });

  it('never emits result.result as a chunk when the stream fell short', async () => {
    const publisher = makeJitteryPublisher();
    // The c1t4 shape: one delta reached the stream, the answer is longer.
    const truncated = [
      FIXTURE[0],
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'msg_x' } } },
      { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: FIXTURE_DELTAS[0] } } },
      FIXTURE_RESULT,
    ];
    const out = await runStep(truncated, publisher);

    // Chunks carry ONLY what the stream produced — no splice.
    expect(publisher.chunks).toEqual([FIXTURE_DELTAS[0]]);
    // The correction is one replacement of the run's final content.
    expect(publisher.replaced).toEqual([FIXTURE_ANSWER]);
    expect(out['data.response']).toBe(FIXTURE_ANSWER);
  });

  it('does not replace anything when the stream ends with the answer', async () => {
    const publisher = makeJitteryPublisher();
    const withPreamble = [
      FIXTURE[0],
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_01', content: [{ type: 'text', text: 'Let me think. ' }] } },
      { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_02', content: [{ type: 'text', text: 'The answer.' }] } },
      { ...FIXTURE_RESULT, result: 'The answer.' },
    ];
    await runStep(withPreamble, publisher);
    expect(publisher.chunks.join('')).toBe('Let me think. The answer.');
    expect(publisher.replaced).toEqual([]);
  });
});
