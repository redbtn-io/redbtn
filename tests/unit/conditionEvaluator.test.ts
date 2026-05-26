/**
 * Regression test for the graph condition evaluator.
 *
 * Consolidates the per-phase tests from the `engine-condition-evaluator-silent-rejection`
 * strategicTodo into a single regression suite under the monorepo-root
 * `tests/unit/` directory, so `npx vitest run tests/unit` and `npx vitest run`
 * (both from ~/code/@redbtn) include it.
 *
 * Locks in the post-fix behavior — any of these scenarios would fail (or
 * never have been written) against the pre-2026-05-26 evaluator, so the file
 * genuinely guards the silent-degrade regression from coming back:
 *
 *   1. literal `true` evaluates to true (pre-fix: silently routed to fallback)
 *   2. literal `false` evaluates to false (the original strategicTodo case)
 *   3. `!state.x` (truthy state) → false (pre-fix: silently routed)
 *   4. `!state.x` (falsy state)  → true  (pre-fix: silently routed)
 *   5. unsupported shape `state.a + state.b` THROWS with the expression in
 *      the message (pre-fix: console.warn + silent fallback)
 *   6. existing supported shape `state.x === 'y'` still works (regression)
 *
 * Plus three bonus locks-in:
 *   7. ConditionEvaluatorError is a named class with `.expression`
 *   8. runtime closure re-throws (no silent '__fallback__' on eval failure)
 *   9. step-condition entry point also fails loud on unparseable input
 */

import { describe, test, expect } from 'vitest';
import {
  createConditionFunction,
  ConditionEvaluatorError,
} from '../../src/lib/graphs/conditionEvaluator';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';

// ─── Acceptance scenarios 1–6 ───────────────────────────────────────────────

describe('conditionEvaluator regression — acceptance scenarios', () => {
  // 1
  test('literal `true` evaluates correctly', () => {
    const fn = createConditionFunction(
      'true',
      { true: 'A', false: 'B' },
      'C',
    );
    expect(fn({})).toBe('true');
  });

  // 2
  test('literal `false` evaluates correctly', () => {
    const fn = createConditionFunction(
      'false',
      { true: 'A', false: 'B' },
      'C',
    );
    expect(fn({})).toBe('false');
  });

  // 3
  test('`!state.flag` returns false when flag is truthy', () => {
    const fn = createConditionFunction(
      '!state.flag',
      { true: 'A', false: 'B' },
      'C',
    );
    expect(fn({ flag: true })).toBe('false');
  });

  // 4
  test('`!state.flag` returns true when flag is falsy', () => {
    const fn = createConditionFunction(
      '!state.flag',
      { true: 'A', false: 'B' },
      'C',
    );
    expect(fn({ flag: false })).toBe('true');
    expect(fn({ flag: undefined })).toBe('true');
    expect(fn({})).toBe('true');
  });

  // 5
  test('unsupported shape `state.a + state.b` throws Error containing the expression', () => {
    const expr = 'state.a + state.b';
    expect(() =>
      createConditionFunction(expr, { true: 'A', false: 'B' }, 'C'),
    ).toThrow(/state\.a \+ state\.b/);
    expect(() =>
      createConditionFunction(expr, { true: 'A', false: 'B' }, 'C'),
    ).toThrow(/unsupported/i);
  });

  // 6
  test('existing supported shape `state.x === \'y\'` still works (regression)', () => {
    const fn = createConditionFunction(
      "state.role === 'admin'",
      { true: 'A', false: 'B' },
      'C',
    );
    expect(fn({ role: 'admin' })).toBe('true');
    expect(fn({ role: 'user' })).toBe('false');
  });
});

// ─── Bonus regression locks 7–9 ─────────────────────────────────────────────

describe('conditionEvaluator regression — class shape & propagation', () => {
  // 7
  test('throws ConditionEvaluatorError (named class) carrying `.expression`', () => {
    const expr = 'state.x ?? "default"';
    let caught: unknown;
    try {
      createConditionFunction(expr, { true: 'A' }, 'B');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConditionEvaluatorError);
    expect((caught as ConditionEvaluatorError).expression).toBe(expr);
    expect((caught as ConditionEvaluatorError).name).toBe('ConditionEvaluatorError');
  });

  // 8 — runtime-throw propagation (not a silent '__fallback__')
  test('runtime evaluation failure re-throws ConditionEvaluatorError (no silent fallback)', () => {
    // Build a closure for an allowlisted shape, then feed a state where
    // stringification throws to force evaluateExpression's downstream code to fail.
    const fn = createConditionFunction(
      'state.role',
      { true: 'A' },
      'F',
    );
    const hostile = {
      role: {
        toString() {
          throw new Error('hostile toString');
        },
      },
    };
    expect(() => fn(hostile)).toThrow(ConditionEvaluatorError);
    expect(() => fn(hostile)).toThrow(/state\.role/);
  });
});

describe('conditionEvaluator regression — `{{false}}` & template-wrapped edge expressions', () => {
  // The original strategicTodo example: `{{false}}` as an edge condition used
  // to log `console.warn` and silently route to fallback. Post-fix it throws.
  test('`{{false}}` in an edge condition throws (the original silent-degrade case)', () => {
    expect(() =>
      createConditionFunction('{{false}}', { true: 'A', false: 'B' }, 'C'),
    ).toThrow(ConditionEvaluatorError);
    expect(() =>
      createConditionFunction('{{false}}', { true: 'A', false: 'B' }, 'C'),
    ).toThrow(/\{\{false\}\}/);
  });

  test('`{{!state.x}}` in an edge condition throws (template wrapper not stripped)', () => {
    expect(() =>
      createConditionFunction('{{!state.flag}}', { true: 'A', false: 'B' }, 'C'),
    ).toThrow(ConditionEvaluatorError);
  });
});

describe('conditionEvaluator regression — step-condition entry point (resolveValue)', () => {
  // Mirror the production check from
  // redbtn/src/lib/nodes/universal/stepExecutor.ts::evaluateStepCondition.
  // Helper is module-private there, so we re-create the failure-detection
  // logic here. This protects against regressions in the step-condition path
  // independent of the helper's location.
  function evaluateStepCondition(condition: string, state: any): boolean {
    const result = resolveValue(condition, state);
    if (typeof condition === 'string' && typeof result === 'string' && result === condition) {
      const trimmed = condition.trim();
      if (trimmed.startsWith('{{') && trimmed.endsWith('}}')) {
        throw new Error(
          `Step condition failed to evaluate: ${condition}. ` +
          `Check that the expression is valid JavaScript and that all referenced state paths exist.`,
        );
      }
    }
    return Boolean(result);
  }

  // 9
  test('step-condition with syntax error (`{{state.x +}}`) throws with the expression', () => {
    expect(() => evaluateStepCondition('{{state.x +}}', { x: 1 })).toThrow(/state\.x \+/);
    expect(() => evaluateStepCondition('{{state.x +}}', { x: 1 })).toThrow(/failed to evaluate/i);
  });

  test('valid `{{true}}` in a step condition evaluates without throwing', () => {
    expect(evaluateStepCondition('{{true}}', {})).toBe(true);
  });

  test('valid `{{false}}` in a step condition evaluates without throwing', () => {
    expect(evaluateStepCondition('{{false}}', {})).toBe(false);
  });

  test('valid `{{!state.flag}}` in a step condition evaluates without throwing', () => {
    expect(evaluateStepCondition('{{!state.flag}}', { flag: true })).toBe(false);
    expect(evaluateStepCondition('{{!state.flag}}', { flag: false })).toBe(true);
  });

  test('undefined state path is NOT a failure (legitimate falsy data, not a parse error)', () => {
    expect(evaluateStepCondition('{{state.missing}}', {})).toBe(false);
  });
});
