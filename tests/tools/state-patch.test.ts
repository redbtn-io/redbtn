/**
 * Vitest for native tool: state_patch
 *
 * Per TOOL-HANDOFF.md — happy path + validation error + upstream error + schema validation.
 *
 * The handler talks to the webapp's PATCH /api/v1/state API.
 * We mock fetch to keep the suite deterministic and offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import statePatchTool from '../../src/lib/tools/native/state-patch';

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

describe('state_patch — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(statePatchTool.description.toLowerCase()).toMatch(/patch|state/);
    expect(statePatchTool.inputSchema.required).toEqual(['namespace', 'key', 'ops']);
    expect(statePatchTool.inputSchema.properties.namespace).toBeDefined();
    expect(statePatchTool.inputSchema.properties.key).toBeDefined();
    expect(statePatchTool.inputSchema.properties.ops).toBeDefined();
    expect(statePatchTool.server).toBe('state');
  });
});

describe('state_patch — happy path', () => {
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

  test('applies set patch and returns updated value', async () => {
    const updatedValue = { name: 'Alice', age: 31 };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toBe('http://test-webapp.example/api/v1/state/namespaces/users/values/user1');
      return new Response(JSON.stringify(updatedValue), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      { namespace: 'users', key: 'user1', ops: [{ op: 'set', path: '/age', value: 31 }] },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toEqual(updatedValue);
  });

  test('applies multiple ops in sequence', async () => {
    const finalValue = { count: 42, tags: ['a', 'b', 'c'] };
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(finalValue), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      {
        namespace: 'config',
        key: 'state',
        ops: [
          { op: 'set', path: '/count', value: 42 },
          { op: 'append', path: '/tags', value: 'c' },
        ],
      },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.count).toBe(42);
    expect(body.tags).toContain('c');
  });

  test('forwards Authorization header when authToken in state', async () => {
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      state: { authToken: 'pat_test_token', userId: 'user-123' } as any,
    });
    await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops: [{ op: 'set', path: '/', value: 1 }] },
      ctx,
    );
    expect(observedHeaders?.['Authorization']).toBe('Bearer pat_test_token');
    expect(observedHeaders?.['X-User-Id']).toBe('user-123');
  });
});

describe('state_patch — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    const result = await statePatchTool.handler(
      { key: 'k', ops: [{ op: 'set', path: '/', value: 1 }] } as any,
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/namespace is required/i);
  });

  test('missing key returns isError + VALIDATION', async () => {
    const result = await statePatchTool.handler(
      { namespace: 'ns', ops: [{ op: 'set', path: '/', value: 1 }] } as any,
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/key is required/i);
  });

  test('missing ops returns isError + VALIDATION', async () => {
    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k' } as any,
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/ops is required/i);
  });

  test('empty ops array returns isError + VALIDATION', async () => {
    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops: [] },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/must contain at least one/i);
  });

  test('too many ops returns isError + VALIDATION', async () => {
    const ops = Array(101).fill({ op: 'set', path: '/', value: 1 });
    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/cannot contain more than 100/i);
  });
});

describe('state_patch — upstream error', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('404 key-not-found surfaces status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Key not found' }), {
        status: 404,
        statusText: 'Not Found',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'missing', ops: [{ op: 'set', path: '/', value: 1 }] },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(404);
  });

  test('fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED state-api');
    }) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops: [{ op: 'set', path: '/', value: 1 }] },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  test('422 schema validation error surfaces structured details', async () => {
    process.env.WEBAPP_URL = 'http://test-webapp.example';
    const schemaError = {
      error: { message: 'Patch result fails schema validation', code: 'schema_validation_failed' },
      expectedSchema: { type: 'object', properties: { count: { type: 'number', minimum: 0 } } },
      validationErrors: [{ path: '/count', message: 'must be >= 0' }],
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(schemaError), {
        status: 422,
        statusText: 'Unprocessable Entity',
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops: [{ op: 'set', path: '/count', value: -5 }] },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(422);
    expect(body.error).toMatch(/schema validation/i);
    expect(body.details).toBeDefined();
    expect(body.details.expectedSchema).toBeDefined();
    expect(body.details.validationErrors).toBeDefined();
  });

  test('malformed JSON response still surfaces error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('internal boom', { status: 500 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await statePatchTool.handler(
      { namespace: 'ns', key: 'k', ops: [{ op: 'set', path: '/', value: 1 }] },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(500);
  });
});
