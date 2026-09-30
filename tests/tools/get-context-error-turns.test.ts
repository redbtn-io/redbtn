/**
 * get_context_history leaves error/fallback turns out of the history it
 * builds (errorTurns: 'omit' by default), can collapse them to a short note
 * ('note') or keep them verbatim ('include' / includeErrorTurns: true).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const CONV = 'bbbbbbbbbbbbbbbbbbbbbbbb';

vi.mock('mongoose', () => {
  const fake = {
    Types: {
      ObjectId: class {
        constructor(public id: string) {}
        static isValid(id: string) {
          return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
        }
      },
    },
    connection: {
      readyState: 1,
      db: {
        collection() {
          return { findOne: vi.fn(async () => ({ _id: 'bbbbbbbbbbbbbbbbbbbbbbbb', userId: 'owner', participants: [] })) };
        },
      },
    },
  };
  return { default: fake, ...fake };
});

const ALL = [
  { id: 'm1', role: 'user', content: 'fix it', timestamp: 1 },
  { id: 'm2', role: 'assistant', content: 'Red Code stopped before calling the model: env_abc', timestamp: 2, kind: 'error' },
  { id: 'm3', role: 'user', content: 'again', timestamp: 3 },
  { id: 'm4', role: 'assistant', content: 'done', timestamp: 4 },
];

const mm = vi.hoisted(() => ({
  getContextForConversation: vi.fn(async (_id: string, opts?: { includeErrorTurns?: boolean }) =>
    opts?.includeErrorTurns ? ALL : ALL.filter((m) => !m.kind),
  ),
  getTrailingSummary: vi.fn(async () => null),
  getExecutiveSummary: vi.fn(async () => null),
}));

vi.mock('../../src/lib/memory/memory', () => ({
  MemoryManager: class {
    getContextForConversation = mm.getContextForConversation;
    getTrailingSummary = mm.getTrailingSummary;
    getExecutiveSummary = mm.getExecutiveSummary;
  },
}));

import getContextTool from '../../src/lib/tools/native/get-context';

function ctx(): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'owner' },
    runId: 'run-x',
    nodeId: 'context',
    toolId: 't',
    abortSignal: null,
  } as NativeToolContext;
}

async function llmMessages(args: Record<string, unknown>) {
  const r = await getContextTool.handler({ conversationId: CONV, ...args }, ctx());
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text as string).messages as Array<{ role: string; content: string }>;
}

describe('get_context_history error turns', () => {
  beforeEach(() => mm.getContextForConversation.mockClear());

  it('omits them by default', async () => {
    const msgs = await llmMessages({});
    expect(mm.getContextForConversation).toHaveBeenCalledWith(CONV, { includeErrorTurns: false });
    expect(msgs.map((m) => m.content)).toEqual(['fix it', 'again', 'done']);
  });

  it("errorTurns: 'note' keeps the turn's place without its text", async () => {
    const msgs = await llmMessages({ errorTurns: 'note' });
    expect(msgs).toHaveLength(4);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].content).not.toMatch(/env_abc|stopped before/);
    expect(msgs[1].content).toMatch(/omitted/);
  });

  it("errorTurns: 'include' and includeErrorTurns: true keep them verbatim", async () => {
    for (const args of [{ errorTurns: 'include' }, { includeErrorTurns: true }, { includeErrorTurns: 'true' }]) {
      const msgs = await llmMessages(args);
      expect(msgs[1].content).toMatch(/stopped before calling the model/);
    }
  });

  it('advertises the parameters in its schema', () => {
    const props = (getContextTool.inputSchema as any).properties;
    expect(props.errorTurns.enum).toEqual(['omit', 'note', 'include']);
    expect(props.errorTurns.default).toBe('omit');
    expect(props.includeErrorTurns.type).toBe('boolean');
  });
});
