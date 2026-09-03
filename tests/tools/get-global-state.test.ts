/**
 * Vitest for native tool: get_global_state
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler talks to the webapp's /api/v1/state API via global `fetch`.
 * We mock fetch to keep the suite deterministic and offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGlobalStateTool from '../../src/lib/tools/native/get-global-state';

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

describe('get_global_state — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(getGlobalStateTool.description.toLowerCase()).toMatch(/global-state|namespace/);
    expect(getGlobalStateTool.inputSchema.required).toEqual(['namespace', 'key']);
    expect(getGlobalStateTool.inputSchema.properties.namespace).toBeDefined();
    expect(getGlobalStateTool.inputSchema.properties.key).toBeDefined();
    expect(getGlobalStateTool.server).toBe('state');
  });
});

describe('get_global_state — happy path', () => {
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

  test('returns { value, exists: true } when API returns the value', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      // Confirm URL targets the right endpoint
      expect(u).toBe(
        'http://test-webapp.example/api/v1/state/namespaces/prefs/values/favourite_color',
      );
      return new Response(
        JSON.stringify({ key: 'favourite_color', value: 'red' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'prefs', key: 'favourite_color' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ value: 'red', exists: true });
  });

  test('returns complex JSON values intact', async () => {
    const complex = { count: 42, tags: ['a', 'b'], nested: { ok: true } };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ key: 'state', value: complex }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'app', key: 'state' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.exists).toBe(true);
    expect(body.value).toEqual(complex);
  });

  test('404 returns { value: null, exists: false }', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Key not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'prefs', key: 'missing' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual({ value: null, exists: false });
  });

  test('forwards Authorization header when authToken in state', async () => {
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ key: 'k', value: 'v' }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      state: { authToken: 'pat_test_token', userId: 'user-123' } as any,
    });
    await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, ctx);
    expect(observedHeaders?.['Authorization']).toBe('Bearer pat_test_token');
    expect(observedHeaders?.['X-User-Id']).toBe('user-123');
  });

  test('forwards X-Internal-Key when present and no authToken', async () => {
    const originalKey = process.env.INTERNAL_SERVICE_KEY;
    process.env.INTERNAL_SERVICE_KEY = 'secret-internal';
    try {
      let observedHeaders: Record<string, string> | undefined;
      globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        observedHeaders = (init?.headers || {}) as Record<string, string>;
        return new Response(JSON.stringify({ key: 'k', value: 'v' }), { status: 200 });
      }) as unknown as typeof globalThis.fetch;

      const ctx = makeMockContext({ state: { userId: 'svc-user' } as any });
      await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, ctx);
      expect(observedHeaders?.['X-Internal-Key']).toBe('secret-internal');
      expect(observedHeaders?.['X-User-Id']).toBe('svc-user');
      // No bearer when no authToken
      expect(observedHeaders?.['Authorization']).toBeUndefined();
    } finally {
      if (originalKey === undefined) delete process.env.INTERNAL_SERVICE_KEY;
      else process.env.INTERNAL_SERVICE_KEY = originalKey;
    }
  });
});

describe('get_global_state — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error — exercising runtime validation
    const result = await getGlobalStateTool.handler({ key: 'k' }, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/namespace is required/i);
  });

  test('whitespace-only namespace returns isError', async () => {
    const result = await getGlobalStateTool.handler(
      { namespace: '   ', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('missing key returns isError + VALIDATION', async () => {
    // @ts-expect-error — runtime validation
    const result = await getGlobalStateTool.handler({ namespace: 'ns' }, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/key is required/i);
  });
});

describe('get_global_state — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('5xx response surfaces status + error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('internal boom', {
        status: 500,
        statusText: 'Internal Server Error',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(500);
    expect(body.error).toMatch(/500/);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED state-api');
    }) as unknown as typeof globalThis.fetch;

    const result = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * Bounding
 *
 * Regression cover for the 2026-09-02/03 voice failure. `list_global_state` was
 * paginated first (#369), but its truncation marker points the model AT
 * `get_global_state` — and `get_global_state('Red-Projects', 'Become')` returned
 * 138,014 bytes. Gemini Live reported ok=true and then could not use the
 * payload, so the session looped on "one moment...".
 *
 * The real shape of that value, measured in production:
 *
 *     Become                    138,014 B total, 15 top-level fields
 *       todo          array[83]  73,755 B     name        string       8 B
 *       recentActivity a[32]     15,566 B     status      string       8 B
 *       strategicTodo  a[15]     14,613 B     priority    string       8 B
 *       workingPhases  a[11]     11,634 B     description string     404 B
 *       value          object    10,933 B     ... 6 more under 350 B
 *       activeWork     object    10,509 B
 *
 * That skew is why the reduction is structural rather than a byte slice: the
 * ~470 bytes of identity fields are exactly what a voice answer needs, and they
 * survive intact while the six bulk members become markers.
 * ────────────────────────────────────────────────────────────────────────── */

/** A stand-in for Red-Projects/Become with the same size distribution. */
function makeBecome(): Record<string, unknown> {
  return {
    name: 'Become',
    description: 'x'.repeat(390),
    status: 'active',
    priority: 'max',
    working: true,
    workingPhaseIndex: 3,
    workerState: 'idle',
    lastActivityAt: '2026-09-02',
    todo: Array.from({ length: 83 }, (_, i) => ({ id: `t${i}`, text: 'y'.repeat(860) })),
    recentActivity: Array.from({ length: 32 }, (_, i) => ({ at: i, text: 'z'.repeat(460) })),
    strategicTodo: Array.from({ length: 15 }, (_, i) => ({ id: i, text: 'q'.repeat(950) })),
    workingPhases: Array.from({ length: 11 }, (_, i) => ({ i, text: 'w'.repeat(1000) })),
    value: { model: 'v'.repeat(10_800) },
    activeWork: { card: 'a'.repeat(10_400) },
    holds: [{ note: 'h'.repeat(300) }],
  };
}

function mockValue(value: unknown) {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ key: 'k', value }), { status: 200 }),
  ) as unknown as typeof globalThis.fetch;
}

describe('get_global_state — bounding schema', () => {
  test('exposes path, offset, limit, keysOnly and the byte budgets', () => {
    const props = getGlobalStateTool.inputSchema.properties;
    expect(props.path).toBeDefined();
    expect(props.offset).toBeDefined();
    expect(props.limit).toBeDefined();
    expect(props.keysOnly).toBeDefined();
    expect(props.maxValueBytes).toBeDefined();
    expect(props.maxTotalBytes).toBeDefined();
    // Still backward compatible: namespace + key remain the only required inputs.
    expect(getGlobalStateTool.inputSchema.required).toEqual(['namespace', 'key']);
  });

  test('description tells the model the call is bounded and pageable', () => {
    const d = getGlobalStateTool.description.toLowerCase();
    expect(d).toMatch(/bounded/);
    expect(d).toMatch(/nextoffset|offset/);
  });
});

describe('get_global_state — size budgets', () => {
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

  test('an unparameterised call on a 138KB value is bounded — the default is the point', async () => {
    const become = makeBecome();
    expect(JSON.stringify(become).length).toBeGreaterThan(130_000);
    mockValue(become);

    const r = await getGlobalStateTool.handler(
      { namespace: 'Red-Projects', key: 'Become' },
      makeMockContext(),
    );
    const text = r.content[0].text;
    const body = JSON.parse(text);

    expect(r.isError).toBeFalsy();
    // The whole tool result, envelope included, stays well under the webapp's
    // 32 KB realtime cap.
    expect(text.length).toBeLessThan(32_768);
    expect(body.bytes).toBeLessThanOrEqual(16_384);
    expect(body.exists).toBe(true);
    expect(body.storedBytes).toBeGreaterThan(130_000);
    expect(body.truncated).toBe(true);
  });

  test('the small identity fields survive intact — that is what an answer needs', async () => {
    mockValue(makeBecome());

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'Red-Projects', key: 'Become' },
        makeMockContext(),
      )).content[0].text,
    );

    expect(body.value.name).toBe('Become');
    expect(body.value.status).toBe('active');
    expect(body.value.priority).toBe('max');
    expect(body.value.working).toBe(true);
    expect(body.value.workerState).toBe('idle');
  });

  test('a bulk member becomes an explicit, self-describing marker', async () => {
    mockValue(makeBecome());

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'Red-Projects', key: 'Become' },
        makeMockContext(),
      )).content[0].text,
    );

    const marker = body.value.todo;
    expect(marker.__truncated).toBe(true);
    expect(marker.type).toBe('array');
    expect(marker.bytes).toBeGreaterThan(70_000);
    expect(marker.length).toBe(83);
    expect(typeof marker.preview).toBe('string');
    // The model is TOLD what it is missing and handed the exact next call.
    expect(marker.path).toBe('$.todo');
    expect(marker.hint).toMatch(/get_global_state/);
    expect(marker.hint).toContain('$.todo');
    expect(body.truncatedMembers).toContain('todo');
    expect(body.notice).toMatch(/__truncated/);
    expect(body.notice).toMatch(/partial value/);
  });

  test('an object marker lists its field names so the shape is visible', async () => {
    mockValue({ big: { alpha: 'a'.repeat(20_000), beta: 1, gamma: 2 } });

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', maxTotalBytes: 500 },
        makeMockContext(),
      )).content[0].text,
    );
    const marker = body.value.big;
    expect(marker.__truncated).toBe(true);
    expect(marker.type).toBe('object');
    expect(marker.fields).toEqual(['alpha', 'beta', 'gamma']);
  });

  test('a value that already fits is returned untouched — no gratuitous clipping', async () => {
    // 3 KB object with a 1.2 KB nested field: the per-member clip must NOT fire,
    // because the value as a whole is under the total budget.
    const config = { tag: 'x', nested: { blob: 'n'.repeat(1200) }, other: 'o'.repeat(600) };
    mockValue(config);

    const r = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'cfg' },
      makeMockContext(),
    );
    // Not merely equal — byte-identical to what the tool emitted before it was
    // bounded. No envelope is added when the whole value comes back untouched.
    expect(r.content[0].text).toBe(JSON.stringify({ value: config, exists: true }));
  });

  test('scalars and small values keep the old value/exists contract', async () => {
    mockValue('red');
    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'prefs', key: 'favourite_color' },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.value).toBe('red');
    expect(body.exists).toBe(true);
  });

  test('a small value is emitted bare — no envelope for existing callers to trip on', async () => {
    mockValue({ a: 1, b: [2, 3] });

    const r = await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, makeMockContext());
    const body = JSON.parse(r.content[0].text);
    expect(Object.keys(body)).toEqual(['value', 'exists']);
  });

  test('maxValueBytes:0 + maxTotalBytes:0 reproduces the old output EXACTLY', async () => {
    const value = makeBecome();
    mockValue(value);

    const r = await getGlobalStateTool.handler(
      { namespace: 'Red-Projects', key: 'Become', maxValueBytes: 0, maxTotalBytes: 0 },
      makeMockContext(),
    );
    // Byte-for-byte the payload the tool emitted before this change — no extra
    // envelope fields at all, so non-voice callers are untouched.
    expect(r.content[0].text).toBe(JSON.stringify({ value, exists: true }));
  });

  test('at least one member is always emitted, so paging can make progress', async () => {
    mockValue({ aaa: 'a'.repeat(50_000), bbb: 'b'.repeat(50_000) });

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', maxTotalBytes: 10, maxValueBytes: 0 },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.returned).toBe(1);
    expect(body.nextOffset).toBe(1);
    expect(body.hasMore).toBe(true);
  });

  test('a member dropped by the page budget is not reported as truncated', async () => {
    mockValue({ aaa: 'a'.repeat(50), bbb: 'b'.repeat(9000) });

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', maxTotalBytes: 200, maxValueBytes: 100 },
        makeMockContext(),
      )).content[0].text,
    );
    expect(Object.keys(body.value)).toEqual(['aaa']);
    expect(body.truncatedMembers).toBeUndefined();
    expect(body.notice).toMatch(/maxTotalBytes budget/);
  });
});

describe('get_global_state — path selector', () => {
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

  test('path drills into one field of a huge value', async () => {
    mockValue(makeBecome());

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'Red-Projects', key: 'Become', path: '$.description' },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.path).toBe('$.description');
    expect(body.value).toBe('x'.repeat(390));
    expect(body.truncated).toBe(false);
  });

  test('the path a marker hands back actually works', async () => {
    mockValue(makeBecome());

    const first = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'Red-Projects', key: 'Become' },
        makeMockContext(),
      )).content[0].text,
    );
    const markerPath = first.value.todo.path;

    const second = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'Red-Projects', key: 'Become', path: markerPath },
        makeMockContext(),
      )).content[0].text,
    );
    expect(second.type).toBe('array');
    expect(second.total).toBe(83);
    // Still bounded on the way down — the drill-in is not a new landmine.
    expect(second.bytes).toBeLessThanOrEqual(16_384);
    expect(second.hasMore).toBe(true);
  });

  test('array indexes and nested paths resolve', async () => {
    mockValue({ todo: [{ id: 't0' }, { id: 't1' }] });

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', path: '$.todo[1].id' },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.value).toBe('t1');
  });

  test('a path that does not resolve says so instead of returning a bare null', async () => {
    mockValue({ a: 1 });

    const r = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', path: '$.nope' },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.exists).toBe(true);
    expect(body.pathFound).toBe(false);
    expect(body.value).toBeNull();
    expect(body.notice).toMatch(/does not resolve/);
  });

  test('an unsupported path is a VALIDATION error, not a silent null', async () => {
    // No network call should even be attempted.
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const r = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', path: '$..todo' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('get_global_state — member paging', () => {
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

  test('offset walks a big array without overlap', async () => {
    mockValue(Array.from({ length: 200 }, (_, i) => ({ i, text: 'p'.repeat(300) })));

    const page1 = JSON.parse(
      (await getGlobalStateTool.handler({ namespace: 'ns', key: 'k' }, makeMockContext()))
        .content[0].text,
    );
    expect(page1.type).toBe('array');
    expect(page1.total).toBe(200);
    expect(page1.hasMore).toBe(true);

    const page2 = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', offset: page1.nextOffset },
        makeMockContext(),
      )).content[0].text,
    );
    expect(page2.offset).toBe(page1.returned);
    expect(page2.value[0].i).toBe(page1.returned);
  });

  test('"skip" is accepted as an alias for offset (list_global_state parity)', async () => {
    mockValue(['a', 'b', 'c', 'd']);

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', skip: 2, limit: 1 },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.offset).toBe(2);
    expect(body.value).toEqual(['c']);
  });

  test('numeric args sent as strings are coerced', async () => {
    mockValue(['a', 'b', 'c', 'd']);

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'k', offset: '1', limit: '2' },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.offset).toBe(1);
    expect(body.value).toEqual(['b', 'c']);
  });

  test('a huge string pages by character offset, and the slice is readable', async () => {
    const doc = 'S'.repeat(60_000) + 'END';
    mockValue(doc);

    const page1 = JSON.parse(
      (await getGlobalStateTool.handler({ namespace: 'ns', key: 'doc' }, makeMockContext()))
        .content[0].text,
    );
    expect(page1.type).toBe('string');
    expect(typeof page1.value).toBe('string');
    expect(page1.value.length).toBe(16_384);
    expect(page1.total).toBe(doc.length);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextOffset).toBe(16_384);

    const last = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'doc', offset: doc.length - 3 },
        makeMockContext(),
      )).content[0].text,
    );
    expect(last.value).toBe('END');
    expect(last.hasMore).toBe(false);
  });

  test('an offset past the end returns empty, not an error', async () => {
    mockValue(Array.from({ length: 5 }, (_, i) => i));

    const r = await getGlobalStateTool.handler(
      { namespace: 'ns', key: 'k', offset: 999 },
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

describe('get_global_state — keysOnly', () => {
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

  test('returns member names, sizes, types and drill-in paths without any content', async () => {
    mockValue(makeBecome());

    const r = await getGlobalStateTool.handler(
      { namespace: 'Red-Projects', key: 'Become', keysOnly: true },
      makeMockContext(),
    );
    const text = r.content[0].text;
    const body = JSON.parse(text);

    expect(body.value).toBeUndefined();
    expect(body.total).toBe(15);
    const todo = body.keys.find((k: { key: string }) => k.key === 'todo');
    expect(todo.bytes).toBeGreaterThan(70_000);
    expect(todo.type).toBe('array');
    expect(todo.path).toBe('$.todo');
    // A "what is in here?" call must be cheap no matter how big the value is.
    expect(text.length).toBeLessThan(2000);
    expect(body.storedBytes ?? body.bytes).toBeGreaterThan(130_000);
  });

  test('keysOnly on a string explains there are no members instead of lying', async () => {
    mockValue('S'.repeat(40_000));

    const body = JSON.parse(
      (await getGlobalStateTool.handler(
        { namespace: 'ns', key: 'doc', keysOnly: true },
        makeMockContext(),
      )).content[0].text,
    );
    expect(body.keys).toEqual([]);
    expect(body.type).toBe('string');
    expect(body.notice).toMatch(/no named members/);
  });
});
