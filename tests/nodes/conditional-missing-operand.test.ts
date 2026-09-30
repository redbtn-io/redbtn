import { describe, expect, it } from 'vitest';
import { executeConditional } from '../../src/lib/nodes/universal/executors/conditionalExecutor';
import type { ConditionalStepConfig } from '../../src/lib/nodes/universal/types';

const step = (condition: string) =>
  ({ condition, setField: 'contextLoaded', trueValue: true, falseValue: false }) as unknown as ConditionalStepConfig;

const run = (condition: string, data: any) => executeConditional(step(condition), { data }).contextLoaded;

// Verbatim conditions from prod nodes (system `context` + forks, god-context, coder-ctx-chat).
const CONTEXT_COND = '"{{state.data.contextMessages.length}}" > "0"';
const MESSAGES_COND = '"{{state.data.contextMessages.messages.length}}" > "0"';

describe('conditional: quoted relational comparisons', () => {
  it('missing path is false (was always true: "undefined" > "0")', () => {
    expect(run(CONTEXT_COND, {})).toBe(false);
    expect(run(MESSAGES_COND, {})).toBe(false);
  });

  it('envelope object has no .length, so the legacy context condition is false', () => {
    expect(run(CONTEXT_COND, { contextMessages: { messages: [{ role: 'user', content: 'hi' }], metadata: {} } })).toBe(false);
  });

  it('.messages.length compares numerically', () => {
    const env = (n: number) => ({ contextMessages: { messages: Array.from({ length: n }, () => ({ role: 'user', content: 'x' })) } });
    expect(run(MESSAGES_COND, env(0))).toBe(false);
    expect(run(MESSAGES_COND, env(1))).toBe(true);
    expect(run(MESSAGES_COND, env(12))).toBe(true); // "12" > "0" numerically, not lexically
  });

  it('real array .length works', () => {
    expect(run(CONTEXT_COND, { contextMessages: [] })).toBe(false);
    expect(run(CONTEXT_COND, { contextMessages: [1, 2] })).toBe(true);
  });

  it('quoted numbers compare numerically ("9" < "10")', () => {
    expect(run('"{{state.data.a}}" < "10"', { a: 9 })).toBe(true);
    expect(run('"{{state.data.a}}" >= "10"', { a: 9 })).toBe(false);
  });

  it('null / empty operands are false for relational ops', () => {
    expect(run('"{{state.data.a}}" > "0"', { a: null })).toBe(false);
    expect(run('"{{state.data.a}}" > "0"', { a: '' })).toBe(false);
    expect(run('{{state.data.a}} > 0 ', { a: undefined })).toBe(false);
  });

  it('quoted non-numeric strings stay string comparisons', () => {
    expect(run('"{{state.data.v}}" == "2.0.5"', { v: '2.0.1' })).toBe(false);
    expect(run('"{{state.data.v}}" == "2.0.1"', { v: '2.0.1' })).toBe(true);
    expect(run('"{{state.data.v}}" < "b"', { v: 'a' })).toBe(true);
    expect(run('"{{state.data.v}}" > "b"', { v: 'a' })).toBe(false);
  });

  it('unquoted numeric comparisons unchanged', () => {
    expect(run('{{state.data.n}} > 0 ', { n: 3 })).toBe(true);
    expect(run('3 > 5', {})).toBe(false);
    expect(run('5 == 5', {})).toBe(true);
  });

  it('equality with undefined unchanged', () => {
    expect(run('"{{state.data.mode}}" != "fast"', {})).toBe(true);
    expect(run('"{{state.data.mode}}" == "fast"', { mode: 'fast' })).toBe(true);
  });
});
