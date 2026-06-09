# Condition Evaluator Silent Rejection Audit

Phase: `cesr-phase-0-audit-current-condition-fallbacks`
Date: 2026-05-26

## Scope

Audited the runtime graph-edge evaluator at `src/lib/graphs/conditionEvaluator.js` and the main condition call sites used by graph compilation and universal node execution.

## Runtime Edge Conditions

Entry point:

- `src/lib/graphs/compiler.ts` calls `createConditionFunction(edge.condition || '', edge.targets || {}, edge.fallback)` from `src/lib/graphs/conditionEvaluator.js` when wiring conditional graph edges.

Supported edge condition shapes in `conditionEvaluator.js`:

- `state.field` and nested paths like `state.field.nested`
- shorthand paths like `field` and `field.nested`, auto-prefixed to `state.`
- comparisons: `state.field === value`, `!==`, `>`, `<`, `>=`, `<=`
- logical AND: `state.a && state.b`
- logical OR: `state.a || state.b`
- one complex AND/comparison shape: `state.a && state.b < state.c` and equivalent comparison operators

Unsupported edge expressions:

- `createConditionFunction` first calls `isSafeExpression`.
- If the expression is not allowlisted, it logs:
  `Unsafe expression detected, using fallback: <expression>`.
- It returns a condition function that never evaluates the expression and always returns `fallback || '__end__'`.
- Because the graph compiler maps fallback nodes under the special `__fallback__` key, this is inconsistent with normal evaluated fallback behavior. If `edge.fallback` is a node id, the unsafe-expression path returns the node id, not `__fallback__`. In LangGraph conditional edges, that return value only routes correctly if a target-map key with the same node id exists. Otherwise it can fail routing or fall through unexpectedly depending on LangGraph handling.
- If there is no `edge.fallback`, the condition function returns `__end__`, so the branch ends silently.

Evaluation-time edge errors:

- If an expression passed the allowlist but `evaluateExpression` throws, `createConditionFunction` catches it, logs an error, and returns `__fallback__` when a fallback is configured or `__end__` otherwise.
- If evaluation succeeds but the result does not match a configured target key or target node id, it logs a warning and returns `__fallback__` or `__end__`.

Important compile-time gap:

- `src/lib/graphs/validateGraphConfig.ts` mirrors the allowlist and can report `CONDITION_BAD_SYNTAX` and `STEP_CONDITION_BAD_SYNTAX`.
- The active compiler in `src/lib/graphs/compiler.ts` uses its own local `validateGraphConfig` function and does not validate condition syntax. Runtime graph compilation can therefore still reach the silent unsafe-expression fallback in `conditionEvaluator.js`.

## Optional Per-Step Conditions

Entry point:

- `src/lib/nodes/universal/stepExecutor.ts` checks `step.condition` before dispatching any step type.
- It calls local `evaluateStepCondition`, which delegates to `resolveValue(condition, { state, parameters })`.

Behavior:

- `{{false}}` resolves to boolean `false`, so the step is skipped.
- `{{true}}` resolves to boolean `true`, so the step runs.
- Complex template expressions are evaluated by `new Function` inside `resolveValue`; unsupported or throwing expressions are caught there and returned as the original string.
- `evaluateStepCondition` then applies `Boolean(result)`. A failed complex expression often becomes a non-empty string and therefore evaluates true, so the step runs.
- If `resolveValue` itself throws to the caller, `evaluateStepCondition` catches the error, logs it, and returns false, so the step is skipped.

## Conditional Step Type

Entry point:

- For steps with `type: "conditional"`, `stepExecutor.ts` calls `executeConditional` in `src/lib/nodes/universal/executors/conditionalExecutor.ts`.

Behavior:

- Pure `{{...}}` conditions are evaluated with `new Function('state', ...)`. The generated function catches inner evaluation errors and returns false.
- If generating/evaluating that function throws outside the inner try, the executor logs the failure, falls back to template rendering, and then uses its string condition evaluator.
- Non-template conditions use `renderTemplate` and a local string evaluator.
- That string evaluator supports boolean literals, comparisons, `&&`, `||`, and truthiness checks.
- Unsupported non-template leftovers usually become truthy if they are non-empty strings, except `0`, `null`, and `undefined`.

## Current User-Visible Failure Modes

- Conditional graph edges are the main silent-rejection problem. Unsupported expressions such as `{{false}}`, `{{!state.x}}`, and `{{state.a + state.b}}` are rejected by the edge allowlist before evaluation and compile into fallback/end routing instead of surfacing a graph-author error.
- Optional per-step conditions already handle `{{true}}` and `{{false}}`, but unsupported complex expressions can silently run the step because the failed expression is converted back to a non-empty string.
- `conditional` step configs already handle `{{true}}` and `{{false}}`; unsupported expression errors generally become false or truthy-string fallback depending on which path is taken.

## Recommended Fix Boundary For Later Phases

- Update `conditionEvaluator.js` first because it controls graph-edge routing and contains the explicit unsafe-expression silent fallback.
- Keep the compiler target-map contract in mind: normal fallback routing returns `__fallback__`, not the fallback node id.
- Decide separately whether optional per-step guards should also fail loudly; they are not the same code path as graph edges.
