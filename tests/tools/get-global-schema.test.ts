/**
 * Vitest for native tool: get_global_schema
 *
 * Per TOOL-HANDOFF.md — happy path, per-key lookup, full namespace config, validation errors, upstream errors.
 *
 * The handler talks to the webapp's /api/v1/state/namespaces API with ?details=schema.
 * We mock fetch to keep the suite deterministic and offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGlobalSchemaTool from '../../src/lib/tools/native/get-global-schema';

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

describe('get_global_schema — schema', () => {
  test('exposes required and optional inputs per spec', () => {
    expect(getGlobalSchemaTool.description.toLowerCase()).toMatch(/schema|namespace/);
    expect(getGlobalSchemaTool.inputSchema.required).toEqual(['namespace']);
    expect(getGlobalSchemaTool.inputSchema.properties.namespace).toBeDefined();
    expect(getGlobalSchemaTool.inputSchema.properties.key).toBeDefined();
    expect(getGlobalSchemaTool.server).toBe('state');
  });
});

describe('get_global_schema — happy path', () => {
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

  test('returns per-key schema when key is provided', async () => {
    const mockSchema = {
      schemaId: 'schema-123',
      name: 'my-schema',
      description: 'Test schema',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
      schemaMode: 'strict',
      schemaCatalog: {
        'schema-123': {
          name: 'my-schema',
          description: 'Test schema',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      },
    };

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      expect(u).toContain('details=schema');
      return new Response(JSON.stringify(mockSchema), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'myapp', key: 'config' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      schemaId: 'schema-123',
      name: 'my-schema',
      description: 'Test schema',
      schema: expect.any(Object),
      mode: 'strict',
    });
  });

  test('returns full namespace config when key is NOT provided', async () => {
    const mockNamespace = {
      schemaId: 'schema-456',
      schemaMode: 'lenient',
      schemaByKey: {
        'config-key': 'schema-789',
      },
      schemaCatalog: {
        'schema-456': {
          name: 'default-schema',
          schema: { type: 'object' },
        },
        'schema-789': {
          name: 'override-schema',
          schema: { type: 'array' },
        },
      },
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(mockNamespace), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'myapp' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      defaultSchemaId: 'schema-456',
      mode: 'lenient',
      schemaByKey: { 'config-key': 'schema-789' },
      schemaCatalog: expect.any(Object),
    });
  });

  test('returns null schema fields when namespace has no schema', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ schemaId: null, schemaMode: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'myapp', key: 'unschemed' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({
      schemaId: null,
      name: null,
      description: null,
      schema: null,
      mode: null,
    });
  });

  test('resolves per-key override schema from catalog', async () => {
    const mockSchema = {
      schemaId: 'default-schema',
      schemaMode: 'strict',
      schemaByKey: {
        'special-key': 'override-schema',
      },
      schemaCatalog: {
        'default-schema': {
          name: 'Default',
          description: 'Default schema',
          schema: { type: 'object' },
        },
        'override-schema': {
          name: 'Override',
          description: 'Override schema',
          schema: { type: 'string' },
        },
      },
    };

    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(mockSchema), { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'myapp', key: 'special-key' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.schemaId).toBe('override-schema');
    expect(body.name).toBe('Override');
    expect(body.schema.type).toBe('string');
  });

  test('404 namespace returns { exists: false, all fields null }', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'Namespace not found' }), { status: 404 }),
    ) as unknown as typeof globalThis.fetch;

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'missing' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.exists).toBe(false);
    expect(body).toEqual({
      schemaId: null,
      name: null,
      description: null,
      schema: null,
      mode: null,
      exists: false,
    });
  });

  test('forwards Authorization header when authToken in state', async () => {
    let observedHeaders: Record<string, string> | undefined;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      observedHeaders = (init?.headers || {}) as Record<string, string>;
      return new Response(JSON.stringify({ schemaId: null }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext({
      state: { authToken: 'pat_test_token', userId: 'user-123' } as any,
    });
    await getGlobalSchemaTool.handler({ namespace: 'ns' }, ctx);
    expect(observedHeaders?.['Authorization']).toBe('Bearer pat_test_token');
    expect(observedHeaders?.['X-User-Id']).toBe('user-123');
  });
});

describe('get_global_schema — validation errors', () => {
  test('missing namespace returns isError + VALIDATION', async () => {
    // @ts-expect-error — exercising runtime validation
    const result = await getGlobalSchemaTool.handler({}, makeMockContext());
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/namespace is required/i);
  });

  test('whitespace-only namespace returns isError', async () => {
    const result = await getGlobalSchemaTool.handler(
      { namespace: '   ' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });
});

describe('get_global_schema — upstream error', () => {
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

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'ns' },
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

    const result = await getGlobalSchemaTool.handler(
      { namespace: 'ns' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });
});
