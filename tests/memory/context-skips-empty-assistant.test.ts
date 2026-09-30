/**
 * Context loading skips assistant messages with no text. Turn-by-turn
 * segmentation persists a tool-only segment (content "", toolExecutions set)
 * before each reply's content segment; feeding those to a model doubled every
 * assistant turn with an empty one.
 */
import { describe, it, expect } from 'vitest';
import { MemoryManager, isEmptyAssistantMessage } from '../../src/lib/memory/memory';

function manager(messages: any[]) {
  const mm = Object.create(MemoryManager.prototype) as any;
  mm.getMessages = async () => messages;
  mm.countMessageTokens = async () => 1;
  mm.MAX_CONTEXT_TOKENS = 1_000_000;
  return mm as MemoryManager;
}

const TOOL_SEGMENT = {
  id: 'a1', role: 'assistant', content: '', timestamp: 2,
  toolExecutions: [{ toolName: 'get_context_history', status: 'completed' }],
};

const CONV = [
  { id: 'u1', role: 'user', content: 'remember teal', timestamp: 1 },
  TOOL_SEGMENT,
  { id: 'a2', role: 'assistant', content: 'OK', timestamp: 3 },
  { id: 'u2', role: 'user', content: 'which word?', timestamp: 4 },
  { id: 'a3', role: 'assistant', content: '   \n', timestamp: 5 },
  { id: 'a4', role: 'assistant', content: 'teal', timestamp: 6, kind: 'error' },
];

describe('getContextForConversation — empty assistant messages', () => {
  it('leaves out assistant messages with no text by default', async () => {
    const ids = (await manager(CONV).getContextForConversation('c')).map((m) => m.id);
    expect(ids).toEqual(['u1', 'a2', 'u2']);
  });

  it('includeEmptyAssistant keeps them', async () => {
    const ids = (await manager(CONV).getContextForConversation('c', { includeEmptyAssistant: true })).map((m) => m.id);
    expect(ids).toEqual(['u1', 'a1', 'a2', 'u2', 'a3']);
  });

  it('is independent of the error-turn switch', async () => {
    const ids = (await manager(CONV).getContextForConversation('c', { includeErrorTurns: true })).map((m) => m.id);
    expect(ids).toEqual(['u1', 'a2', 'u2', 'a4']);
  });

  it('never drops an empty USER message', () => {
    expect(isEmptyAssistantMessage({ role: 'user', content: '' })).toBe(false);
    expect(isEmptyAssistantMessage({ role: 'assistant', content: [{ type: 'text', text: ' ' }] })).toBe(true);
    expect(isEmptyAssistantMessage({ role: 'assistant', content: [{ type: 'image_url' }] })).toBe(false);
  });
});
