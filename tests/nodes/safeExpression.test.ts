/**
 * Security + behaviour tests for the sandboxed expression evaluator.
 *
 * Context: graph/node steps let any signed-in author write a JS expression the
 * worker evaluates. The old `new Function(...)` path ran it with the worker's
 * full global scope, so `{{ process.env.JWT_SECRET }}` and
 * `{{ ({}).constructor.constructor("return process.env")() }}` read the worker's
 * secrets. `evaluateExpression` runs inside a `node:vm` context that cannot
 * reach `process`, `require`, or any host global.
 *
 * The escape matrix runs directly against the vm boundary (the module has no
 * static pre-check), proving the vm blocks every escape on its own. A sentinel
 * env var is set in the test process; no escape may ever return it.
 *
 * Lives under tests/ (not next to the source) because vitest.config.ts only
 * discovers test files beneath the tests/ directory.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    evaluateExpression,
    evaluateBoolean,
    getByPath,
    SafeExpressionError,
} from '../../src/lib/nodes/universal/safeExpression';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';
import { executeConditional } from '../../src/lib/nodes/universal/executors/conditionalExecutor';
import { evaluateExitCondition } from '../../src/lib/nodes/universal/executors/loopExecutor';
import type { ConditionalStepConfig } from '../../src/lib/nodes/universal/types';

const SENTINEL = 'SAFEEXPR_SENTINEL_VALUE_e3b0c44298fc';

beforeAll(() => {
    process.env.SAFEEXPR_SENTINEL = SENTINEL;
});
afterAll(() => {
    delete process.env.SAFEEXPR_SENTINEL;
});

// Every entry MUST throw or fail closed — it may never return a host value.
const ESCAPES: string[] = [
    "({}).constructor.constructor('return process.env')()",
    "this.constructor.constructor('return process')()",
    "(function(){}).constructor('return process.env.SAFEEXPR_SENTINEL')()",
    "[].map.constructor('return process')()",
    "Object.getPrototypeOf(()=>{}).constructor('return process')()",
    "(async()=>{}).constructor('return process')()",
    "(function*(){})().constructor.constructor('return process')()",
    "globalThis.constructor.constructor('return process')()",
    "state.constructor.constructor('return process')()",
    "state.items.map.constructor('return process')()",
    "''.constructor.constructor('return process')()",
    "(1).constructor.constructor('return process')()",
    "(class{}).constructor.constructor('return process')()",
    "Promise.resolve().constructor.constructor('return process')()",
    "Reflect.getPrototypeOf(state).constructor.constructor('return process')()",
    'process.env.SAFEEXPR_SENTINEL',
    'process.env.JWT_SECRET',
    'global.process',
    'globalThis.process',
    "require('fs')",
    "import('fs')",
    "eval('process.env.SAFEEXPR_SENTINEL')",
    "(0,eval)('process')",
    "Function('return process')()",
];

const ESCAPE_SCOPE = { state: { items: [{ id: 1 }, { id: 2 }], a: 1 } };

/** Cheap checks only — never stringify a potentially-huge host object. */
function assertNoHostLeak(result: unknown): void {
    expect(result === process).toBe(false);
    expect(result === (process as unknown as { env: unknown }).env).toBe(false);
    if (typeof result === 'string') {
        expect(result.includes(SENTINEL)).toBe(false);
    } else if (result !== null && typeof result === 'object') {
        expect('SAFEEXPR_SENTINEL' in (result as object)).toBe(false);
        const versions = (result as { versions?: unknown }).versions;
        const looksLikeProcess =
            versions !== null && typeof versions === 'object' && 'node' in (versions as object);
        expect(looksLikeProcess).toBe(false);
    }
}

function runEscapeMatrix(): void {
    for (const expr of ESCAPES) {
        let threw = false;
        let result: unknown;
        try {
            result = evaluateExpression(expr, ESCAPE_SCOPE);
        } catch {
            threw = true;
        }
        if (!threw) {
            // Fail closed: it returned, but it must not be a host value.
            assertNoHostLeak(result);
        }
    }
}

describe('safeExpression: escapes blocked by the vm boundary', () => {
    it('every escape fails closed and never returns a host value', () => {
        runEscapeMatrix();
    });
    it('a direct secret read throws (process is not defined in the sandbox)', () => {
        expect(() => evaluateExpression('process.env.SAFEEXPR_SENTINEL', {})).toThrow(SafeExpressionError);
    });
    it('a constructor-chain secret read is blocked, never the sentinel', () => {
        let leaked: unknown = '__threw__';
        try {
            leaked = evaluateExpression("({}).constructor.constructor('return process.env.SAFEEXPR_SENTINEL')()", {});
        } catch {
            /* expected */
        }
        expect(leaked).not.toBe(SENTINEL);
    });
    it('a scope-value prototype walk is blocked', () => {
        let leaked: unknown = '__threw__';
        try {
            leaked = evaluateExpression("state.items.map.constructor('return process')()", ESCAPE_SCOPE);
        } catch {
            /* expected */
        }
        assertNoHostLeak(leaked);
    });
});

describe('safeExpression: legitimate expressions evaluate correctly', () => {
    const state = {
        a: 3,
        b: 9,
        ts: 1700000000000,
        obj: { x: 1 },
        items: [
            { id: 1, n: 1 },
            { id: 2, n: 5 },
        ],
        name: 'Xavier',
        arr: [10, 20, 30],
        i: 1,
        flag: true,
    };
    const parameters = { ns: '' };
    const S = { state, parameters };

    it('arithmetic, ternary, and fallback', () => {
        expect(evaluateExpression('state.a + 1', S)).toBe(4);
        expect(evaluateExpression("state.flag ? 'y' : 'n'", S)).toBe('y');
        expect(evaluateExpression("parameters.ns || 'default'", S)).toBe('default');
    });
    it('array methods and arrow callbacks', () => {
        expect(evaluateExpression('state.items.map(i => i.id)', S)).toEqual([1, 2]);
        expect(evaluateExpression('state.items.filter(i => i.n > 1).length', S)).toBe(1);
    });
    it('intrinsics (Math, JSON, Date) stay available', () => {
        expect(evaluateExpression('Math.max(state.a, state.b)', S)).toBe(9);
        expect(evaluateExpression('JSON.stringify(state.obj)', S)).toBe('{"x":1}');
        expect(evaluateExpression('new Date(state.ts).getFullYear()', S)).toBe(2023);
    });
    it('string methods, indexing, logical operators', () => {
        expect(evaluateExpression("state.name.toLowerCase().includes('x')", S)).toBe(true);
        expect(evaluateExpression('state.arr[state.i]', S)).toBe(20);
        expect(evaluateExpression("state.a === 3 && state.flag", S)).toBe(true);
    });
    it('preserves the result type', () => {
        expect(evaluateExpression('true', {})).toBe(true);
        expect(typeof evaluateExpression('true', {})).toBe('boolean');
        expect(evaluateExpression('42', {})).toBe(42);
        expect(typeof evaluateExpression('42', {})).toBe('number');
    });
    it('evaluateBoolean coerces to a boolean', () => {
        expect(evaluateBoolean('state.a > 0', S)).toBe(true);
        expect(evaluateBoolean('state.a > 100', S)).toBe(false);
    });
    it('tolerates large / circular state without throwing (conditional & loop feed it such state)', () => {
        const cyc: Record<string, unknown> = { a: 1, items: [{ id: 7 }] };
        cyc.self = cyc;
        (cyc.items as unknown[]).push(cyc);
        expect(evaluateExpression('state.a + 1', { state: cyc })).toBe(2);
        expect(evaluateExpression('state.items[0].id', { state: cyc })).toBe(7);
        expect(evaluateExpression('state.self === undefined', { state: cyc })).toBe(true);
    });
});

describe('safeExpression: DoS is bounded by the timeout', () => {
    it('while(true){} does not hang', () => {
        const t0 = Date.now();
        expect(() => evaluateExpression('while(true){}', {})).toThrow();
        expect(Date.now() - t0).toBeLessThan(1000);
    });
    it('(()=>{while(true){}})() times out within ~1s', () => {
        const t0 = Date.now();
        expect(() => evaluateExpression('(()=>{while(true){}})()', {}, { timeoutMs: 250 })).toThrow();
        expect(Date.now() - t0).toBeLessThan(1000);
    });
});

describe('getByPath: safe response-path navigation (parser site)', () => {
    const data = {
        candidates: [{ content: { parts: [{ inlineData: { data: 'BASE64AUDIO' } }] } }],
        audio: { data: 'ALT' },
    };
    it('resolves dotted-numeric paths', () => {
        expect(getByPath(data, 'candidates.0.content.parts.0.inlineData.data')).toBe('BASE64AUDIO');
    });
    it('resolves bracket-index paths', () => {
        expect(getByPath(data, 'candidates[0].content.parts[0].inlineData.data')).toBe('BASE64AUDIO');
    });
    it('returns undefined for missing/partial paths (never throws)', () => {
        expect(getByPath(data, 'candidates.5.content')).toBeUndefined();
        expect(getByPath({}, 'a.b.c')).toBeUndefined();
        expect(getByPath(null, 'a')).toBeUndefined();
    });
    it('returns the root for an empty path', () => {
        expect(getByPath(data, '')).toBe(data);
    });
    it('treats a hostile path as property access only — no eval, no throw', () => {
        const hostile = "x');return process;//";
        expect(() => getByPath(data, hostile)).not.toThrow();
        expect(getByPath(data, hostile)).toBeUndefined();
    });
});

describe('call site: templateRenderer.resolveValue', () => {
    it('evaluates a pure expression with its type preserved', () => {
        expect(resolveValue('{{state.a + 1}}', { a: 41 })).toBe(42);
        expect(resolveValue('{{true}}', {})).toBe(true);
        expect(resolveValue('{{42}}', {})).toBe(42);
    });
    it('still interpolates a mixed template string', () => {
        expect(resolveValue('hello {{state.name}}', { name: 'Alice' })).toBe('hello Alice');
    });
    it('resolves a parameters fallback', () => {
        expect(resolveValue("{{parameters.ns || 'default'}}", { parameters: { ns: '' } })).toBe('default');
    });
    it('an escape attempt fails closed to the original string and never the sentinel', () => {
        const src = "{{ ({}).constructor.constructor('return process.env.SAFEEXPR_SENTINEL')() }}";
        const out = resolveValue(src, {});
        expect(out).toBe(src);
        expect(typeof out === 'string' && out.includes(SENTINEL)).toBe(false);
    });
    it('throwOnError surfaces the failure for state-mutating callers', () => {
        expect(() => resolveValue('{{ process.env.SAFEEXPR_SENTINEL }}', {}, { throwOnError: true })).toThrow();
    });
});

describe('call site: conditionalExecutor.executeConditional', () => {
    const step = (condition: string): ConditionalStepConfig =>
        ({ condition, setField: 'r', trueValue: 'YES', falseValue: 'NO' }) as unknown as ConditionalStepConfig;

    it('evaluates a boolean condition unchanged', () => {
        expect(executeConditional(step('{{state.n > 1}}'), { n: 2 }).r).toBe('YES');
        expect(executeConditional(step('{{state.n > 1}}'), { n: 0 }).r).toBe('NO');
    });
    it('an escape attempt fails closed to the false branch', () => {
        const out = executeConditional(
            step("{{ ({}).constructor.constructor('return process.env.SAFEEXPR_SENTINEL')() }}"),
            {},
        );
        expect(out.r).toBe('NO');
    });
});

describe('call site: loopExecutor.evaluateExitCondition', () => {
    it('evaluates an exit condition against state', () => {
        expect(evaluateExitCondition('state.loopIteration >= 3', { loopIteration: 3 })).toBe(true);
        expect(evaluateExitCondition('state.loopIteration >= 3', { loopIteration: 1 })).toBe(false);
    });
    it('returns false (safer default) on an escape attempt and never leaks', () => {
        expect(
            evaluateExitCondition("state.constructor.constructor('return process.env.SAFEEXPR_SENTINEL')()", { x: 1 }),
        ).toBe(false);
        expect(evaluateExitCondition('process.env.SAFEEXPR_SENTINEL', {})).toBe(false);
    });
});

describe('safeExpression: benign free identifiers as ordinary names (no false positives)', () => {
    // Regression for the removed static pre-check, which wrongly rejected admin
    // transforms that used words like `module` / `global` / `import` as ordinary
    // variable or property names. These MUST evaluate, not throw.
    it('a local variable named `module`', () => {
        expect(
            evaluateExpression('(() => { const module = state.a; return module + 1 })()', { state: { a: 41 } }),
        ).toBe(42);
    });
    it('a local variable named `global`', () => {
        expect(
            evaluateExpression('(function(){ var global = state.n; return global * 2 })()', { state: { n: 21 } }),
        ).toBe(42);
    });
    it('a shell-quote (shq) helper reading state.data', () => {
        const expr = `(() => { const shq = (s) => "'" + String(s) + "'"; return shq(state.data); })()`;
        expect(evaluateExpression(expr, { state: { data: 'a b' } })).toBe("'a b'");
    });
    it('`process` and `import` as plain property names', () => {
        expect(evaluateExpression('state.data.process', { state: { data: { process: 'P' } } })).toBe('P');
        expect(evaluateExpression('state.data.import', { state: { data: { import: 'I' } } })).toBe('I');
    });
    it('the same forms through resolveValue (the real `{{ ... }}` path)', () => {
        expect(resolveValue('{{ (() => { const module = state.a; return module + 1 })() }}', { a: 41 })).toBe(42);
        expect(resolveValue('{{ state.data.process }}', { data: { process: 'ok' } })).toBe('ok');
    });
});
