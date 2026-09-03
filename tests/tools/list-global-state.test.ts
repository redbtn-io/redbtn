/**
 * Vitest for native tool: list_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import listGlobalStateTool from '../../src/lib/tools/native/list-global-state';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('list_global_state — schema', () => {
  test('exposes required namespace input', () => {
    expect(listGlobalStateTool.description.toLowerCase()).toMatch(/key.value pairs|namespace/);
    expect(listGlobalStateTool.inputSchema.required).toEqual(['namespace']);
    expect(listGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
  });
});

describe('list_global_state — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('returns { values: {...} } from API', async () => {
    const apiPayload = {
      values: {
        color: 'red',
        count: 7,
        nested: { ok: true, tags: ['a', 'b'] },
      },
    };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/state/namespaces/prefs/values');
      return new Response(JSON.stringify(apiPayload), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'prefs' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual(apiPayload.values);
  });

  test('empty namespace returns { values: {} }', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ values: {} }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'fresh' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });

  test('404 returns empty values map (matches GlobalStateClient behaviour)', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Namespace not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'missing' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });

  test('handles missing values key in response gracefully', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ /* no values key */ }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await listGlobalStateTool.handler(
      { namespace: 'odd' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.values).toEqual({});
  });
});

describe('list_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error
    const r = await listGlobalStateTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only namespace returns isError', async () => {
    const r = await listGlobalStateTool.handler({ namespace: '   ' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('list_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('500 response surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const r = await listGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('EHOSTDOWN state-api');
    }) as unknown as typeof globalThis.fetch;

    const r = await listGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/EHOSTDOWN/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Pagination
 *
 * Regression cover for the 2026-09-02 voice failure: `list_global_state` on
 * `Red-Projects` returned 328,317 characters — 20 keys, two of which were
 * 138 KB and 128 KB. Gemini Live reported ok=true and then could not use the
 * payload, so the session looped on "one moment...".
 *
 * Note the skew: a key-COUNT limit alone is not a fix, because `limit: 1` on
 * that namespace still returns 138 KB. The per-value and per-page byte budgets
 * are what actually bound the result, so they are tested here explicitly.
 * ────────────────────────────────────────────────────────────────────────── */

/** Build a values map of `count` keys, each value `bytes` long when serialised. */
function makeValues(count: number, bytes = 10): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    // key000, key001, ... so lexicographic order === numeric order.
    out[`key${String(i).padStart(3, '0')}`] = 'x'.repeat(bytes);
  }
  return out;
}

function mockValues(payload: Record<string, unknown>) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ values: payload }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
}

describe('list_global_state — pagination schema', () => {
  test('exposes limit, offset, keysOnly and the byte budgets', () => {
    const props = listGlobalStateTool.inputSchema.properties;
    expect(props.limit).toBeDefined();
    expect(props.offset).toBeDefined();
    expect(props.keysOnly).toBeDefined();
    expect(props.maxValueBytes).toBeDefined();
    expect(props.maxTotalBytes).toBeDefined();
    // Still backward compatible: namespace remains the only required input.
    expect(listGlobalStateTool.inputSchema.required).toEqual(['namespace']);
  });

  test('description tells the model the call is paginated', () => {
    expect(listGlobalStateTool.description.toLowerCase()).toMatch(/paginat/);
  });
});

describe('list_global_state — pagination behaviour', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('an unparameterised call is bounded — the default limit is the point', async () => {
    mockValues(makeValues(340));

    const r = await listGlobalStateTool.handler({ namespace: 'big' }, makeMockContext());
    const body = JSON.parse(r.content[0].text);

    expect(body.returned).toBe(25);
    expect(Object.keys(body.values)).toHaveLength(25);
    expect(body.total).toBe(340);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(25);
    // The model must be able to say "25 of 340".
    expect(body.notice).toContain('of 340');
  });

  test('offset walks the namespace in a stable order', async () => {
    mockValues(makeValues(60));

    const page1 = JSON.parse(
      (await listGlobalStateTool.handler({ namespace: 'ns', limit: 10 }, makeMockContext()))
        .content[0].text,
    );
    const page2 = JSON.parse(
      (await listGlobalStateTool.handler(
        { namespace: 'ns', limit: 10, offset: page1.nextOffset },
        makeMockContext(),
      )).content[0].text,
    );

    expect(Object.keys(page1.values)[0]).toBe('key000');
    expect(Object.keys(page2.values)[0]).toBe('key010');
    // Pages must not overlap.
    const overlap = Object.keys(page1.values).filter((k) => k in page2.values);
    expect(overlap).toEqual([]);
  });

  test('"skip" is accepted as an alias for offset (query_state_records parity)', async () => {
    mockValues(makeValues(30));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', limit: 5, skip: 5 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.offset).toBe(5);
    expect(Object.keys(body.values)[0]).toBe('key005');
  });

  test('numeric args sent as strings are coerced', async () => {
    mockValues(makeValues(30));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', limit: '5', offset: '10' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.returned).toBe(5);
    expect(body.offset).toBe(10);
  });

  test('the last page reports hasMore false and a null nextOffset', async () => {
    mockValues(makeValues(12));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', limit: 10, offset: 10 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.returned).toBe(2);
    expect(body.hasMore).toBe(false);
    expect(body.nextOffset).toBeNull();
  });

  test('an offset past the end returns empty, not an error', async () => {
    mockValues(makeValues(5));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', offset: 999 },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.returned).toBe(0);
    expect(body.total).toBe(5);
    expect(body.hasMore).toBe(false);
    expect(body.notice).toMatch(/past the end/i);
  });
});

describe('list_global_state — size budgets', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('one huge value is replaced by an explicit, self-describing marker', async () => {
    // The real shape of Red-Projects/Become: one key, 138 KB.
    mockValues({
      Become: { name: 'Become', status: 'live', blob: 'y'.repeat(138_000) },
    });

    const r = await listGlobalStateTool.handler({ namespace: 'Red-Projects' }, makeMockContext());
    const text = r.content[0].text;
    const body = JSON.parse(text);

    // The whole point: the payload no longer approaches 138 KB.
    expect(text.length).toBeLessThan(4000);

    const marker = body.values.Become;
    expect(marker.__truncated).toBe(true);
    expect(marker.bytes).toBeGreaterThan(138_000);
    expect(marker.type).toBe('object');
    expect(marker.fields).toContain('status');
    expect(typeof marker.preview).toBe('string');
    // The model is TOLD what it is missing and how to get it.
    expect(marker.hint).toMatch(/get_global_state/);
    expect(body.truncatedValues).toEqual(['Become']);
    expect(body.notice).toMatch(/__truncated/);
  });

  test('small values are still inlined untouched (backward compatible)', async () => {
    const payload = { color: 'red', count: 7, nested: { ok: true, tags: ['a', 'b'] } };
    mockValues(payload);

    const r = await listGlobalStateTool.handler({ namespace: 'prefs' }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(body.values).toEqual(payload);
    expect(body.truncatedValues).toBeUndefined();
  });

  test('maxValueBytes: 0 disables per-value clipping', async () => {
    mockValues({ big: 'z'.repeat(50_000) });

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', maxValueBytes: 0, maxTotalBytes: 0 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.values.big).toHaveLength(50_000);
  });

  test('maxTotalBytes stops a page early and says so', async () => {
    mockValues(makeValues(50, 400));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', maxTotalBytes: 2000 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);

    expect(body.returned).toBeLessThan(25);
    expect(body.bytes).toBeLessThanOrEqual(2000);
    expect(body.hasMore).toBe(true);
    expect(body.nextOffset).toBe(body.returned);
    expect(body.notice).toMatch(/maxTotalBytes budget/);
  });

  test('a single value bigger than the whole page budget still returns one key', async () => {
    // Otherwise the caller pages forever and never advances.
    mockValues(makeValues(5, 5000));

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', maxTotalBytes: 100, maxValueBytes: 0 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.returned).toBe(1);
    expect(body.nextOffset).toBe(1);
  });

  test('a key dropped by the page budget is not reported as truncated', async () => {
    mockValues({ aaa: 'a'.repeat(50), bbb: 'b'.repeat(9000) });

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', maxTotalBytes: 200, maxValueBytes: 100 },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(Object.keys(body.values)).toEqual(['aaa']);
    expect(body.truncatedValues).toBeUndefined();
  });
});

describe('list_global_state — keysOnly', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = 'http://test-webapp.example';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('returns key names and sizes without any values', async () => {
    mockValues({ small: 'a', huge: 'b'.repeat(100_000) });

    const r = await listGlobalStateTool.handler(
      { namespace: 'ns', keysOnly: true },
      makeMockContext(),
    );
    const text = r.content[0].text;
    const body = JSON.parse(text);

    expect(body.values).toBeUndefined();
    expect(body.total).toBe(2);
    const huge = body.keys.find((k: { key: string }) => k.key === 'huge');
    expect(huge.bytes).toBeGreaterThan(100_000);
    expect(huge.type).toBe('string');
    // A "what is in here?" call must be cheap no matter how big the namespace.
    expect(text.length).toBeLessThan(1000);
  });
});
