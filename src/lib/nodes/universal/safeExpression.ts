/**
 * safeExpression — evaluate author-controlled expressions from graph/node steps
 * without handing them the worker's globals.
 *
 * Graph "transform" / "conditional" / "loop" steps and `{{ ... }}` template
 * expressions let any signed-in author write a JavaScript expression that the
 * worker then evaluates. The previous implementation compiled each one with
 * `new Function(...)`, which runs with the worker's full global scope, so
 * `{{ process.env.JWT_SECRET }}` or
 * `{{ ({}).constructor.constructor("return process.env")() }}` could read the
 * worker's secrets. This module keeps expression authoring but evaluates inside
 * a `node:vm` context that cannot reach `process`, `require`, `Buffer`,
 * `module`, `global`, or any other host global.
 *
 * How the boundary holds (every claim is exercised in the test suite, whose
 * escape matrix runs directly against this vm-only boundary):
 *  - `contextCodeGeneration.strings = false` makes any reconstructed
 *    `Function("…")()` / `eval("…")` throw `EvalError`, which kills the
 *    `constructor.constructor("return process")()` family even though those
 *    constructors exist inside the sandbox.
 *  - The expression runs inside a `"use strict"` IIFE, so top-level `this` is
 *    `undefined` and `this.constructor.constructor(...)` can no longer walk out
 *    to the host realm's `Function`.
 *  - The sandbox global is a null-prototype object, so `globalThis.constructor`
 *    is `undefined` as well.
 *  - Scope ({ state }, { state, parameters }, …) crosses the boundary as a JSON
 *    string and is rebuilt with the sandbox's own `JSON.parse`, so every object
 *    and array the author can touch has sandbox-realm prototypes:
 *    `state.items.map.constructor` is the sandbox `Function` (policed by
 *    `strings:false`), not the host one. `structuredClone` would NOT be enough —
 *    a cloned host object keeps the host `Object`/`Array` prototypes, whose
 *    `.constructor.constructor` is the host `Function` (demonstrated in tests).
 *  - A wall-clock `timeout` bounds `while(true){}`-style DoS.
 *  - `import()` has no loader here and is made to fail closed instead of killing
 *    the worker with `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`.
 *
 * The standard intrinsics a fresh vm context already supplies (Math, JSON, Date,
 * Object, Array, String, Number, Boolean, RegExp, …) remain available, which is
 * what keeps legitimate expressions working.
 */
import * as vm from 'node:vm';
import { isPlainObject, planScope, scopePruningEnabled, type Keep } from './scopePruning';

/** Thrown when an expression is rejected, fails to evaluate, or times out. */
export class SafeExpressionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SafeExpressionError';
    }
}

export interface EvaluateOptions {
    /**
     * Wall-clock budget for running the expression itself, in milliseconds.
     * Defaults to 250ms. Rebuilding the scope inside the sandbox has its own,
     * size-scaled budget (see scopeLoadBudgetMs) so large state cannot eat it.
     */
    timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 250;

/**
 * Budget for rebuilding the scope inside the sandbox: 250ms plus 100ms per MB
 * of serialised scope. This step only runs the sandbox's own JSON.parse on data
 * the engine produced, so it cannot loop; the budget just keeps a pathological
 * multi-hundred-MB scope from stalling the worker forever.
 */
function scopeLoadBudgetMs(scopeJsonLength: number): number {
    return DEFAULT_TIMEOUT_MS + Math.ceil(scopeJsonLength / 1_000_000) * 100;
}

/**
 * Convert a scope value to a JSON-safe structure. True cycles are dropped (a
 * value cannot reference itself through the result) while DAGs (a shared ref on
 * sibling branches) are preserved; Dates become ISO strings, non-finite numbers
 * and BigInt are normalised, and functions/symbols/undefined are omitted — the
 * same shape `JSON.stringify` produces, but without throwing on a cycle. The
 * conditional/loop sites can be handed large or self-referential state, so this
 * must never throw on one.
 */
function toJsonSafe(value: unknown, ancestors: Set<object>): unknown {
    if (value === null) return null;
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return value;
    if (type === 'number') return Number.isFinite(value as number) ? value : null;
    if (type === 'bigint') return (value as bigint).toString();
    if (type !== 'object') return undefined; // function, symbol, undefined

    const obj = value as object;
    if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? null : obj.toISOString();
    if (ancestors.has(obj)) return undefined; // break a true cycle
    ancestors.add(obj);
    let result: unknown;
    if (Array.isArray(obj)) {
        result = obj.map((item) => {
            const mapped = toJsonSafe(item, ancestors);
            return mapped === undefined ? null : mapped;
        });
    } else {
        const record: Record<string, unknown> = {};
        for (const key of Object.keys(obj as Record<string, unknown>)) {
            const mapped = toJsonSafe((obj as Record<string, unknown>)[key], ancestors);
            if (mapped !== undefined) record[key] = mapped;
        }
        result = record;
    }
    ancestors.delete(obj);
    return result;
}

/**
 * `toJsonSafe` restricted to the parts of `value` a Keep tree names. It walks
 * the original objects with the same ancestor set, so cycles and shared
 * references serialise exactly as the full scope would, minus the keys the
 * expression cannot reach.
 */
function toJsonSafePruned(value: unknown, keep: Keep, ancestors: Set<object>): unknown {
    if (keep.whole || !isPlainObject(value)) return toJsonSafe(value, ancestors);
    if (ancestors.has(value)) return undefined;
    ancestors.add(value);
    const record: Record<string, unknown> = {};
    for (const [key, child] of keep.children) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const mapped = toJsonSafePruned(value[key], child, ancestors);
        if (mapped !== undefined) record[key] = mapped;
    }
    ancestors.delete(value);
    return record;
}

const VALID_SCOPE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Evaluate `expression` with `scope` bound as top-level variables, returning the
 * value with its JS type preserved. Throws `SafeExpressionError` if the
 * expression is rejected, fails, or times out. The evaluation can never reach
 * `process`, `require`, or any host global.
 */
export function evaluateExpression(
    expression: string,
    scope: Record<string, unknown>,
    opts?: EvaluateOptions,
): unknown {
    if (typeof expression !== 'string') {
        throw new SafeExpressionError('Expression must be a string');
    }

    const keys = Object.keys(scope ?? {});
    for (const key of keys) {
        if (!VALID_SCOPE_KEY.test(key)) {
            throw new SafeExpressionError(`Invalid scope variable name: ${key}`);
        }
    }

    // Copy only what the expression can reach (see scopePruning.ts). Variables
    // it never names are left out and bound as undefined below.
    const plan = scopePruningEnabled() ? planScope(expression, keys) : null;
    const bound = keys.filter((key) => !plan || plan.get(key) !== undefined);

    let scopeJson: string | undefined;
    try {
        const ancestors = new Set<object>();
        const safe: Record<string, unknown> = {};
        for (const key of bound) {
            const value = (scope as Record<string, unknown>)[key];
            const keep = plan?.get(key);
            const mapped = keep ? toJsonSafePruned(value, keep, ancestors) : toJsonSafe(value, ancestors);
            if (mapped !== undefined) safe[key] = mapped;
        }
        scopeJson = JSON.stringify(safe);
    } catch (err) {
        throw new SafeExpressionError(
            `Scope is not serializable: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (typeof scopeJson !== 'string') scopeJson = '{}';

    // Null-prototype sandbox: `globalThis.constructor` is undefined, and nothing
    // the fresh context does not install is reachable.
    const sandbox: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    sandbox.__scope_json__ = scopeJson;
    const context = vm.createContext(sandbox, {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
    });
    const scriptOptions = {
        // No module loader is wired, so `import()` has nothing to load.
        // Make it reject (fail closed) rather than throw the uncaught
        // ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING that would crash the worker.
        importModuleDynamically: () => {
            throw new SafeExpressionError('Dynamic import is not allowed in expressions');
        },
    };

    // Phase 1: rebuild the scope with the sandbox's own JSON.parse (so every
    // object has sandbox-realm prototypes) under a size-scaled budget. This
    // runs engine-produced JSON only, never author code.
    try {
        vm.runInContext(
            '"use strict";globalThis.__s=JSON.parse(globalThis.__scope_json__);globalThis.__scope_json__=undefined;',
            context,
            { timeout: scopeLoadBudgetMs(scopeJson.length), ...scriptOptions } as unknown as vm.RunningScriptOptions,
        );
    } catch (err) {
        throw new SafeExpressionError(
            `Expression scope could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const bindings = bound
        .map((key) => `const ${key}=__s[${JSON.stringify(key)}];`)
        .join('');
    // Scope variables the expression never names are not copied; bind them as
    // undefined so a `typeof x` style check still sees the name.
    const unbound = keys
        .filter((key) => !bound.includes(key))
        .map((key) => `const ${key}=undefined;`)
        .join('');
    // "use strict" + an IIFE so `this` is `undefined` inside; the parenthesised
    // expression keeps the author grammar (an expression yielding a typed value).
    // `__s` is captured into a local and removed from the global first.
    const code =
        '"use strict";(function(__s){' +
        bindings +
        unbound +
        'return (' +
        expression +
        ');})((function(){const s=globalThis.__s;globalThis.__s=undefined;return s;})())';

    // Phase 2: the author expression, under the normal (DoS) budget.
    let result: unknown;
    try {
        result = vm.runInContext(code, context, {
            timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            ...scriptOptions,
        } as unknown as vm.RunningScriptOptions);
    } catch (err) {
        if (err instanceof SafeExpressionError) throw err;
        throw new SafeExpressionError(
            `Expression evaluation failed: ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // A thenable can only come from an async escape attempt (e.g. `import('fs')`),
    // never a legitimate value expression. Swallow its settlement so an unhandled
    // rejection cannot crash the worker; the promise itself carries no secret.
    if (
        result !== null &&
        typeof result === 'object' &&
        typeof (result as { then?: unknown }).then === 'function'
    ) {
        try {
            (result as Promise<unknown>).then(
                () => undefined,
                () => undefined,
            );
        } catch {
            /* ignore */
        }
    }

    return result;
}

/** Evaluate `expression` and coerce the result to a boolean. */
export function evaluateBoolean(
    expression: string,
    scope: Record<string, unknown>,
    opts?: EvaluateOptions,
): boolean {
    return Boolean(evaluateExpression(expression, scope, opts));
}

/**
 * Resolve a dotted/bracketed property path against `data` without eval or vm.
 * Supports `a.b.c`, `a[0].b`, and dotted numerics `a.0.b`. Returns `undefined`
 * for a missing segment or a malformed path, and never executes code — the
 * safe replacement for `new Function("data", "return data?." + path)`.
 */
export function getByPath(data: unknown, path: string): unknown {
    if (typeof path !== 'string' || path.length === 0) return data;
    let current: unknown = data;
    for (const segment of path.split('.')) {
        if (segment === '') continue;
        const tokens = parsePathSegment(segment);
        if (tokens === null) return undefined;
        for (const token of tokens) {
            if (current === null || current === undefined) return undefined;
            const type = typeof current;
            if (type !== 'object' && type !== 'string' && type !== 'function') return undefined;
            current = (current as Record<string, unknown>)[token];
        }
    }
    return current;
}

function parsePathSegment(segment: string): string[] | null {
    // name? ( '[' digits ']' )*  →  ["name", "0", "1", …]
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return null;
    const name = match[1] ?? '';
    const brackets = match[2] ?? '';
    const tokens: string[] = [];
    if (name !== '') tokens.push(name);
    const indices = brackets.match(/\d+/g);
    if (indices) tokens.push(...indices);
    return tokens.length === 0 ? null : tokens;
}
