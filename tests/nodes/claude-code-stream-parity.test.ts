/**
 * `claude-code` streaming parity — report 39, defect D1.
 *
 * # What was broken
 *
 * On the redChat dispatch stream, 8 of 10 `claude-code` chat turns emitted
 * zero `content_chunk` events or a truncated prefix (worst case: the single
 * character `T`, with `run_complete.finalContent` = `"T"` against a 152-char
 * persisted message). The one control turn on a non-claude-code neuron was
 * byte-exact. Two causes, both here:
 *
 *   1. `runClaudeCodeStep` refused to publish from a node named
 *      `respond`/`responder`, deferring to the `on_llm_stream` forwarder in
 *      `functions/run.ts`. That forwarder only fires for a LangChain model and
 *      a claude-code neuron never builds one — and `responder` is the node
 *      name the stock chat graphs use. So nothing streamed live, and run.ts's
 *      `on_chain_end` backstop replayed the finished answer one character at a
 *      time, seconds late and lossy.
 *   2. Assistant text was read ONLY from `stream_event`/`content_block_delta`.
 *      A message that arrives complete in an `assistant` envelope — the norm
 *      after a tool result, and whenever partial messages are absent — was
 *      never published at all, so the live bubble lost whole turns while the
 *      persisted message stayed complete.
 *
 * # The contract these tests pin
 *
 * The claude-code event sequence must be the one every other provider
 * produces: a `message_start` (minted by `RunPublisher.chunk` on the first
 * content chunk, exactly as for a LangChain stream), incremental content
 * chunks as the answer is produced, `tool_start`/`tool_complete` from the
 * bridge (covered live in `claude-code-live.test.ts`), and a final answer that
 * the stream actually carried — so `run_complete.finalContent`, which is
 * derived from the forwarded chunks, equals the persisted message.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  runClaudeCodeStep,
  createStreamHandler,
  assistantMessageText,
} from '../../src/lib/nodes/universal/executors/claudeCodeExecutor';

// =============================================================================
// Fixtures — the real wire shapes
// =============================================================================

const SESSION = '48e41cd5-2401-4694-a45c-7e9ae4a4e3b5';

const INIT_EVENT = {
  type: 'system',
  subtype: 'init',
  apiKeySource: 'none',
  claude_code_version: '2.1.263',
  cwd: '/ws/workspace/tree',
  mcp_servers: [{ name: 'redbtn', status: 'connected' }],
  model: 'claude-sonnet-5',
  permissionMode: 'dontAsk',
  session_id: SESSION,
  skills: [],
  slash_commands: [],
  tools: [],
};

function resultEvent(text: string, over: Record<string, unknown> = {}) {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 1385,
    duration_api_ms: 1352,
    num_turns: 1,
    permission_denials: [],
    result: text,
    session_id: SESSION,
    stop_reason: 'end_turn',
    subagent_stats: { spawned: 0, completed: 0, failed: 0 },
    terminal_reason: 'completed',
    total_cost_usd: 0.0045,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 3146,
      cache_read_input_tokens: 0,
      output_tokens: 4,
    },
    ...over,
  };
}

function messageStart(id: string, parentToolUseId: string | null = null) {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    session_id: SESSION,
    event: { type: 'message_start', message: { id, role: 'assistant', content: [] } },
  };
}

function textDelta(text: string, parentToolUseId: string | null = null) {
  return {
    type: 'stream_event',
    parent_tool_use_id: parentToolUseId,
    session_id: SESSION,
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
  };
}

/**
 * An `assistant` envelope. Its `content` is the message's text CUMULATIVELY —
 * everything produced for that message, never a delta.
 */
function assistantEvent(
  id: string,
  blocks: Array<Record<string, unknown>>,
  parentToolUseId: string | null = null,
) {
  return {
    type: 'assistant',
    parent_tool_use_id: parentToolUseId,
    request_id: `req_${id}`,
    session_id: SESSION,
    message: { id, type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: blocks },
  };
}

const textBlock = (text: string) => ({ type: 'text', text });
const toolUseBlock = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });

// =============================================================================
// 1. The reader
// =============================================================================

describe('createStreamHandler — assistant envelopes (defect D1)', () => {
  function collect(events: unknown[]) {
    const chunks: string[] = [];
    const h = createStreamHandler({ onText: (t) => chunks.push(t) });
    for (const e of events) h.handle(JSON.stringify(e));
    return { chunks, state: h.state };
  }

  it('publishes a message that arrived with NO partial deltas', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      assistantEvent('msg_01', [textBlock('The time is 03:18 UTC.')]),
      resultEvent('The time is 03:18 UTC.'),
    ]);
    expect(chunks).toEqual(['The time is 03:18 UTC.']);
    expect(state.text).toBe('The time is 03:18 UTC.');
  });

  it('does not republish text the deltas already carried', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('Hello, '),
      textDelta('world'),
      assistantEvent('msg_01', [textBlock('Hello, world')]),
      resultEvent('Hello, world'),
    ]);
    expect(chunks).toEqual(['Hello, ', 'world']);
    expect(state.text).toBe('Hello, world');
  });

  // Superseded by the ordering fix: a message that streamed deltas has ONE
  // source, and topping it up from the envelope put a second writer on the
  // stream (which reordered a live turn). The shortfall is corrected once, via
  // the run's final content — see `claude-code-stream-order.test.ts`.
  it('does not top up a message whose deltas stopped mid-message', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('This is actually the '),
      assistantEvent('msg_01', [textBlock('This is actually the very start of our conversation.')]),
      resultEvent('This is actually the very start of our conversation.'),
    ]);
    expect(chunks).toEqual(['This is actually the ']);
    expect(state.text).toBe('This is actually the ');
  });

  it('handles several messages across a tool turn without losing or repeating any', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('Let me check. '),
      assistantEvent('msg_01', [textBlock('Let me check. '), toolUseBlock('toolu_01', 'now')]),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01' }] } },
      // Second message: no partials at all, which is the common shape after a
      // tool result — this whole turn used to vanish from the live stream.
      assistantEvent('msg_02', [textBlock('It is 03:18 UTC.')]),
      resultEvent('It is 03:18 UTC.'),
    ]);
    expect(chunks).toEqual(['Let me check. ', 'It is 03:18 UTC.']);
    expect(state.text).toBe('Let me check. It is 03:18 UTC.');
  });

  it('publishes a repeated envelope for the same message id only once', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      assistantEvent('msg_01', [textBlock('Once.')]),
      assistantEvent('msg_01', [textBlock('Once.')]),
      resultEvent('Once.'),
    ]);
    expect(chunks).toEqual(['Once.']);
    expect(state.text).toBe('Once.');
  });

  it('extends a message id that grew between two envelopes', () => {
    const { chunks } = collect([
      INIT_EVENT,
      assistantEvent('msg_01', [textBlock('Once.')]),
      assistantEvent('msg_01', [textBlock('Once. Twice.')]),
    ]);
    expect(chunks).toEqual(['Once.', ' Twice.']);
  });

  it('keeps a subagent envelope out of the conversation', () => {
    const { chunks, state } = collect([
      INIT_EVENT,
      assistantEvent('msg_sub', [textBlock('subagent chatter')], 'toolu_01SUB'),
      assistantEvent('msg_01', [textBlock('main answer')]),
    ]);
    expect(chunks).toEqual(['main answer']);
    expect(state.text).toBe('main answer');
  });

  it('ignores a tool_use-only envelope', () => {
    const { chunks } = collect([
      INIT_EVENT,
      assistantEvent('msg_01', [toolUseBlock('toolu_01', 'now')]),
    ]);
    expect(chunks).toEqual([]);
  });

  it('still records request ids', () => {
    const { state } = collect([INIT_EVENT, assistantEvent('msg_01', [textBlock('x')])]);
    expect(state.requestIds).toEqual(['req_msg_01']);
  });
});

describe('assistantMessageText', () => {
  it('concatenates text blocks and skips everything else', () => {
    expect(
      assistantMessageText({ content: [textBlock('a'), toolUseBlock('t', 'now'), textBlock('b')] }),
    ).toBe('ab');
    expect(assistantMessageText({ content: 'plain string' })).toBe('plain string');
    expect(assistantMessageText(undefined)).toBe('');
    expect(assistantMessageText({ content: [] })).toBe('');
  });
});

// =============================================================================
// 2. The executor
// =============================================================================

let tmpRoot: string;
let savedRunDirRoot: string | undefined;
let savedBin: string | undefined;

interface FakePublisher {
  chunks: string[];
  replaced: string[];
  chunk(text: string): Promise<void>;
  replaceOutputContent(text: string): Promise<void>;
  thinkingChunk(text: string): Promise<void>;
  toolStart(): Promise<void>;
  toolComplete(): Promise<void>;
  toolError(): Promise<void>;
  getState(): Promise<{ status: string }>;
}

function makePublisher(): FakePublisher {
  const chunks: string[] = [];
  const replaced: string[] = [];
  return {
    chunks,
    replaced,
    async chunk(text: string) {
      chunks.push(text);
    },
    async replaceOutputContent(text: string) {
      replaced.push(text);
    },
    async thinkingChunk() {},
    async toolStart() {},
    async toolComplete() {},
    async toolError() {},
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

/** The stock chat-graph node name — the one that used to suppress streaming. */
const RESPONDER_NODE = { nodeConfig: { graphNodeId: 'responder' } };

function runStep(
  events: unknown[],
  stateOverrides: Record<string, unknown> = RESPONDER_NODE,
  configOverrides: Record<string, unknown> = {},
) {
  process.env.CLAUDE_CODE_BIN = writeFakeCli(events);
  const publisher = makePublisher();
  const runId = `run_${Math.random().toString(36).slice(2, 8)}`;
  const promise = runClaudeCodeStep({
    config: {
      neuronId: 'sonnet-5',
      outputField: 'data.response',
      systemPrompt: 'You are Sonnet 5.',
      userPrompt: 'hi',
      stream: true,
      streamToConversation: true,
      tools: [],
      ...configOverrides,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    state: {
      runId,
      userId: 'user_test',
      runPublisher: publisher,
      data: { runId, userId: 'user_test' },
      ...stateOverrides,
    },
    neuronCfg: NEURON_CFG,
    neuronId: 'sonnet-5',
    userId: 'user_test',
    callRunId: runId,
    abortSignal: undefined,
    emitUsage: () => {},
  });
  return { promise, publisher };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-parity-'));
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

describe('runClaudeCodeStep — the redChat event sequence (defect D1)', () => {
  const ANSWER = 'It is Tuesday, September 8, 2026, 3:18 AM UTC.';

  it('streams a chat turn from the node the stock chat graphs actually use', async () => {
    const { promise, publisher } = runStep([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('It is Tuesday, '),
      textDelta('September 8, 2026, 3:18 AM UTC.'),
      assistantEvent('msg_01', [textBlock(ANSWER)]),
      resultEvent(ANSWER),
    ]);
    const out = await promise;

    // Incremental — several chunks, not one blob and not one per character.
    expect(publisher.chunks.length).toBeGreaterThan(1);
    expect(publisher.chunks.every((c) => c.length > 1)).toBe(true);
    // What the stream carried IS the answer: `run_complete.finalContent` is
    // derived from these chunks, so this is the equality the report found
    // broken on 8 of 10 turns.
    expect(publisher.chunks.join('')).toBe(ANSWER);
    expect(out['data.response']).toBe(ANSWER);
  });

  it('streams a turn whose text only ever arrived in the assistant envelope', async () => {
    const { promise, publisher } = runStep([
      INIT_EVENT,
      assistantEvent('msg_01', [textBlock(ANSWER)]),
      resultEvent(ANSWER),
    ]);
    const out = await promise;
    expect(publisher.chunks.join('')).toBe(ANSWER);
    expect(out['data.response']).toBe(ANSWER);
  });

  it('leaves a truncated stream alone and corrects the run\'s final content', async () => {
    // The c1t4 shape: one character reached the stream, 152 were persisted.
    // The correction is a replacement, not another chunk — see
    // `claude-code-stream-order.test.ts` for why.
    const { promise, publisher } = runStep([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('I'),
      // No envelope, no further deltas — only the result knows the answer.
      resultEvent(ANSWER),
    ]);
    const out = await promise;
    expect(publisher.chunks).toEqual(['I']);
    expect(publisher.replaced).toEqual([ANSWER]);
    expect(out['data.response']).toBe(ANSWER);
  });

  it('does not repeat the answer when the stream already carried it', async () => {
    const { promise, publisher } = runStep([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta(ANSWER),
      assistantEvent('msg_01', [textBlock(ANSWER)]),
      resultEvent(ANSWER),
    ]);
    await promise;
    expect(publisher.chunks.join('')).toBe(ANSWER);
  });

  it('keeps a tool preamble AND the answer, in order, with no duplication', async () => {
    const { promise, publisher } = runStep([
      INIT_EVENT,
      messageStart('msg_01'),
      textDelta('Let me check the time. '),
      assistantEvent('msg_01', [textBlock('Let me check the time. '), toolUseBlock('toolu_01', 'now')]),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_01' }] } },
      assistantEvent('msg_02', [textBlock(ANSWER)]),
      resultEvent(ANSWER, { num_turns: 2 }),
    ]);
    const out = await promise;
    expect(publisher.chunks.join('')).toBe(`Let me check the time. ${ANSWER}`);
    // The step's own output stays the final answer, as every other executor's does.
    expect(out['data.response']).toBe(ANSWER);
  });

  it('publishes nothing at all when the step did not ask to stream', async () => {
    const { promise, publisher } = runStep(
      [INIT_EVENT, assistantEvent('msg_01', [textBlock(ANSWER)]), resultEvent(ANSWER)],
      RESPONDER_NODE,
      { stream: false },
    );
    await promise;
    expect(publisher.chunks).toEqual([]);
  });
});
