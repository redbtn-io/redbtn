import { describe, expect, it } from 'vitest';
import { pruneScope, referencedPaths } from '../../src/lib/nodes/universal/scopePruning';
import { evaluateExpression } from '../../src/lib/nodes/universal/safeExpression';
import { resolveValue } from '../../src/lib/nodes/universal/templateRenderer';

const big = 'x'.repeat(8_000_000);

function state() {
    return {
        data: {
            audio: big,
            msg: 'hello',
            list: [1, 2, 3],
            nested: { a: { b: 1 }, c: 2 },
            when: new Date('2026-01-01T00:00:00Z'),
        },
        parameters: { ns: 'tpf' },
    };
}

describe('referencedPaths', () => {
    it('reads static member chains', () => {
        expect(referencedPaths('state.data.msg', 'state')).toEqual([['data', 'msg']]);
        expect(referencedPaths('state?.data?.msg', 'state')).toEqual([['data', 'msg']]);
        expect(referencedPaths('state["data"][\'msg\']', 'state')).toEqual([['data', 'msg']]);
        expect(referencedPaths('state.data.list[0]', 'state')).toEqual([['data', 'list', '0']]);
    });

    it('stops at dynamic access and drops a trailing method call', () => {
        expect(referencedPaths('state.data[k]', 'state')).toEqual([['data']]);
        expect(referencedPaths('state.data.list.map(x => x)', 'state')).toEqual([['data', 'list']]);
        expect(referencedPaths('state.data.msg.slice(0, 2)', 'state')).toEqual([['data', 'msg']]);
    });

    it('needs the whole value for bare, spread and destructured references', () => {
        expect(referencedPaths('state', 'state')).toBeNull();
        expect(referencedPaths('Object.keys(state)', 'state')).toBeNull();
        expect(referencedPaths('({...state}).data', 'state')).toBeNull();
        expect(referencedPaths('(({data}) => data)(state)', 'state')).toBeNull();
    });

    it('ignores other identifiers, property names and object keys', () => {
        expect(referencedPaths('x.state + mystate + state_1', 'state')).toEqual([]);
        expect(referencedPaths('({ state: 1 })', 'state')).toEqual([]);
    });
});

describe('pruneScope', () => {
    it('keeps only the named paths', () => {
        const s = state();
        const pruned = pruneScope('state.data.msg', { state: s, parameters: s.parameters }) as any;
        expect(pruned).toEqual({ state: { data: { msg: 'hello' } } });
    });

    it('keeps non-plain values whole where the chain reaches them', () => {
        const s = state();
        const pruned = pruneScope('state.data.list.length + state.data.when.length', { state: s }) as any;
        expect(pruned.state.data.list).toBe(s.data.list);
        expect(pruned.state.data.when).toBe(s.data.when);
    });

    it('a shorter path wins over a longer one', () => {
        const s = state();
        const pruned = pruneScope('state.data.nested.a.b + Object.keys(state.data.nested).length', { state: s }) as any;
        expect(pruned.state.data.nested).toBe(s.data.nested);
    });

    it('missing keys stay missing instead of throwing', () => {
        const pruned = pruneScope('state.data.nope.deeper', { state: state() }) as any;
        expect(pruned).toEqual({ state: { data: {} } });
    });
});

describe('evaluateExpression with pruning', () => {
    it('results are identical to full-scope evaluation across common forms', () => {
        const s = state();
        const scope = { state: s, parameters: s.parameters };
        const cases: Array<[string, unknown]> = [
            ['state.data.msg', 'hello'],
            ['state.data.msg + "!"', 'hello!'],
            ['state.data.list.map(x => x * 2)', [2, 4, 6]],
            ['state.data.list.length', 3],
            ['state.data.nested.a.b + state.data.nested.c', 3],
            ['state.data.missing === undefined', true],
            ['(state.data.nope || {}).x === undefined', true],
            ['Object.keys(state.data.nested)', ['a', 'c']],
            ['parameters.ns + ":" + state.data.msg', 'tpf:hello'],
            ['state.data.audio.length', 8_000_000],
            ['typeof state.data.when', 'string'],
            ['(function(){ var d = state.data; return d.msg; })()', 'hello'],
            ['"state.data" + state.data.msg', 'state.datahello'],
            ['state.data.msg.replace(/\'/g, "") + state.data.list[1]', 'hello2'],
        ];
        for (const [expr, expected] of cases) {
            expect(evaluateExpression(expr, scope), expr).toEqual(expected);
        }
    });

    it('a large value no other expression touches does not slow small expressions', () => {
        const s = state();
        const scope = { state: s };
        const t0 = Date.now();
        for (let i = 0; i < 20; i += 1) evaluateExpression('state.data.msg', scope);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    it('an expression that touches a large value is not cut off by the 250ms budget', () => {
        const s = { data: { audio: 'y'.repeat(30_000_000) } };
        expect(evaluateExpression('state.data.audio.length > 1000', { state: s })).toBe(true);
    });

    it('the runaway-expression budget still applies', () => {
        expect(() => evaluateExpression('(() => { while (true) {} })()', { state: state() })).toThrow(/timed out/i);
    });

    it('resolveValue goes through the same path', () => {
        const s = state();
        expect(resolveValue('{{ state.data.msg.toUpperCase() }}', s)).toBe('HELLO');
        expect(resolveValue('{{ !!state.data.audio }}', s)).toBe(true);
    });

    it('can be switched off', () => {
        process.env.REDBTN_EXPR_SCOPE_PRUNING = 'off';
        try {
            expect(evaluateExpression('state.data.msg', { state: state() })).toBe('hello');
        } finally {
            delete process.env.REDBTN_EXPR_SCOPE_PRUNING;
        }
    });
});
