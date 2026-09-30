import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain ESM ops script, no types
import { foldEmptyToolSegments } from '../../ops/migrations/2026-09-30-fold-empty-tool-segments.mjs';

const u = (id: string) => ({ id, role: 'user', content: 'hi' });
const tool = (id: string, runId: string) => ({ id, role: 'assistant', content: '', metadata: { runId, kind: 'tool' }, toolExecutions: [{ toolName: 't' }] });
const reply = (id: string, runId: string, text = 'answer') => ({ id, role: 'assistant', content: text, metadata: { runId, kind: 'content' } });

describe('foldEmptyToolSegments', () => {
  it('folds a tool segment into the same run\'s reply', () => {
    const { messages, folded } = foldEmptyToolSegments([u('u1'), tool('a1', 'r1'), reply('a2', 'r1')]);
    expect(folded).toBe(1);
    expect(messages.map((m: any) => m.id)).toEqual(['u1', 'a2']);
    expect(messages[1].toolExecutions).toEqual([{ toolName: 't' }]);
    expect(messages[1].content).toBe('answer');
  });

  it('leaves it when the next reply is another run, empty, or absent', () => {
    expect(foldEmptyToolSegments([u('u1'), tool('a1', 'r1'), reply('a2', 'r2')]).folded).toBe(0);
    expect(foldEmptyToolSegments([u('u1'), tool('a1', 'r1'), reply('a2', 'r1', '  ')]).folded).toBe(0);
    expect(foldEmptyToolSegments([u('u1'), tool('a1', 'r1')]).folded).toBe(0);
    expect(foldEmptyToolSegments([u('u1'), tool('a1', 'r1'), u('u2')]).folded).toBe(0);
  });

  it('folds consecutive empty segments of one run into the reply', () => {
    const { messages, folded } = foldEmptyToolSegments([u('u1'), tool('a1', 'r1'), tool('a2', 'r1'), reply('a3', 'r1')]);
    expect(folded).toBe(2);
    expect(messages.map((m: any) => m.id)).toEqual(['u1', 'a3']);
    expect(messages[1].toolExecutions).toHaveLength(2);
  });

  it('does not mutate its input', () => {
    const input = [u('u1'), tool('a1', 'r1'), reply('a2', 'r1')];
    const copy = JSON.parse(JSON.stringify(input));
    foldEmptyToolSegments(input.map((m) => ({ ...m })));
    expect(input).toEqual(copy);
  });
});
