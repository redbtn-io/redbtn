/**
 * scopePruning — copy only the parts of the scope an expression can reach.
 *
 * `evaluateExpression` serialises its scope into the vm sandbox for every
 * `{{ ... }}` template, step condition and loop condition. Handing over the
 * whole run state means a multi-megabyte value (TTS audio, an image, a video)
 * is serialised and re-parsed by every expression in the run, even
 * `{{ state.data.message }}`. This module reads the expression text and keeps
 * only the state paths it names.
 *
 * It is deliberately conservative: it may copy more than an expression needs,
 * never less.
 *  - The source is scanned raw (string and regex contents are not skipped), so
 *    a scope name that only appears inside a string adds paths, it never hides
 *    a real reference.
 *  - Only static member chains are followed: `state.a.b`, `state?.a`,
 *    `state["a"]`, `state.a[0]`. Anything else (`state[key]`, a bare `state`,
 *    `...state`, destructuring) keeps the value at that point whole; a bare
 *    reference keeps the entire scope variable.
 *  - A chain ending in a call (`state.list.map(...)`) keeps the receiver whole.
 *  - Descent only happens through plain objects; arrays, strings, Dates and
 *    other values are kept whole where the chain reaches them, so `.length`,
 *    indexing and methods behave exactly as with the full value.
 *  - Intermediate objects are rebuilt with only the kept keys, so a missing key
 *    still reads as `undefined` rather than throwing.
 *
 * Generic: no graph or step config involved. Disable with
 * REDBTN_EXPR_SCOPE_PRUNING=off to restore full-scope copies.
 */

const IDENT_CHAR = /[A-Za-z0-9_$]/;

/** Marker for "keep this value whole". */
export type Keep = { whole: true } | { whole: false; children: Map<string, Keep> };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function skipWs(src: string, i: number): number {
    while (i < src.length && /\s/.test(src[i])) i += 1;
    return i;
}

/**
 * Read a static member chain starting right after a scope identifier.
 * Returns the segments, or null when the reference needs the whole value
 * (no static segment could be read).
 */
function readChain(src: string, start: number): string[] {
    const segments: string[] = [];
    let i = start;
    for (;;) {
        let j = skipWs(src, i);
        if (src.startsWith('?.', j)) j += 2;
        else if (src[j] === '.' && src[j + 1] !== '.') j += 1;
        else if (src[j] !== '[') break;
        j = skipWs(src, j);
        if (src[j] === '[') {
            const k = skipWs(src, j + 1);
            const quote = src[k];
            let seg: string | null = null;
            let end = -1;
            if (quote === '"' || quote === "'") {
                const close = src.indexOf(quote, k + 1);
                const body = close > 0 ? src.slice(k + 1, close) : '';
                if (close > 0 && !/[\\\n]/.test(body)) {
                    seg = body;
                    end = close + 1;
                }
            } else {
                const m = /^\d+/.exec(src.slice(k));
                if (m) {
                    seg = m[0];
                    end = k + m[0].length;
                }
            }
            if (seg === null) break;
            const after = skipWs(src, end);
            if (src[after] !== ']') break;
            segments.push(seg);
            i = after + 1;
            continue;
        }
        const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(j));
        if (!m) break;
        segments.push(m[0]);
        i = j + m[0].length;
    }
    // A trailing call means the last segment is a method on the receiver.
    const next = skipWs(src, i);
    if (segments.length > 0 && (src[next] === '(' || src.startsWith('?.(', next) || src[next] === '`')) {
        segments.pop();
    }
    return segments;
}

/**
 * Collect the static paths `expression` reads from scope variable `name`.
 * Returns null when the whole value is needed.
 */
export function referencedPaths(expression: string, name: string): string[][] | null {
    const paths: string[][] = [];
    let from = 0;
    for (;;) {
        const at = expression.indexOf(name, from);
        if (at < 0) break;
        from = at + name.length;
        const before = at > 0 ? expression[at - 1] : '';
        const after = expression[at + name.length] ?? '';
        if (IDENT_CHAR.test(before) || IDENT_CHAR.test(after)) continue;
        // Property access on something else (`x.state`) is not our variable,
        // but a spread (`...state`) is.
        let p = at - 1;
        while (p >= 0 && /\s/.test(expression[p])) p -= 1;
        if (expression[p] === '.') {
            if (expression.slice(Math.max(0, p - 2), p + 1) !== '...') continue;
            return null;
        }
        // Object literal key (`{ state: 1 }`) is not a reference.
        const nextChar = expression[skipWs(expression, at + name.length)];
        if ((expression[p] === '{' || expression[p] === ',') && nextChar === ':') continue;
        const chain = readChain(expression, at + name.length);
        if (chain.length === 0) return null;
        paths.push(chain);
    }
    return paths;
}

function addPath(tree: Keep, path: string[]): void {
    let node = tree;
    for (let i = 0; i < path.length; i += 1) {
        if (node.whole) return;
        let child = node.children.get(path[i]);
        if (!child) {
            child = i === path.length - 1 ? { whole: true } : { whole: false, children: new Map() };
            node.children.set(path[i], child);
        } else if (i === path.length - 1) {
            node.children.set(path[i], { whole: true });
            return;
        }
        node = child;
    }
}

function build(value: unknown, keep: Keep): unknown {
    if (keep.whole || !isPlainObject(value)) return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of keep.children) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            out[key] = build(value[key], child);
        }
    }
    return out;
}

export function scopePruningEnabled(): boolean {
    const flag = (typeof process !== 'undefined' && process.env?.REDBTN_EXPR_SCOPE_PRUNING) || '';
    return flag.toLowerCase() !== 'off';
}

/**
 * Per scope variable: `undefined` when the expression never names it, a Keep
 * tree saying which parts it can reach otherwise.
 */
export function planScope(expression: string, keys: string[]): Map<string, Keep | undefined> {
    const plan = new Map<string, Keep | undefined>();
    for (const key of keys) {
        const paths = referencedPaths(expression, key);
        if (paths === null) {
            plan.set(key, { whole: true });
            continue;
        }
        if (paths.length === 0) {
            plan.set(key, undefined);
            continue;
        }
        const tree: Keep = { whole: false, children: new Map() };
        for (const path of paths) addPath(tree, path);
        plan.set(key, tree);
    }
    return plan;
}

/**
 * Return a scope holding only what `expression` can read. Scope variables the
 * expression never mentions are dropped; a bare or dynamic reference keeps the
 * variable whole.
 */
export function pruneScope(expression: string, scope: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(scope)) {
        const paths = referencedPaths(expression, key);
        if (paths === null) {
            out[key] = scope[key];
            continue;
        }
        if (paths.length === 0) continue;
        const tree: Keep = { whole: false, children: new Map() };
        for (const path of paths) addPath(tree, path);
        out[key] = build(scope[key], tree);
    }
    return out;
}
