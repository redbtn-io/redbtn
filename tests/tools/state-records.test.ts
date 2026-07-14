/**
 * Vitest for the State Records native tools:
 *   create_state_record, get_state_record, query_state_records,
 *   update_state_record, delete_state_record
 *
 * Per TOOL-HANDOFF.md §6.1 — schema, happy path, validation error, upstream
 * error. These tools are thin proxies over the webapp records API (which owns
 * auth, namespace access, limits and query compilation), so what's worth pinning
 * down here is the CONTRACT with that API: the URL and method each tool calls,
 * the auth headers, the body it sends, and how it maps the response — including
 * the two deliberate not-an-error cases (a missing record on get/delete).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import createStateRecord from '../../src/lib/tools/native/create-state-record';
import getStateRecord from '../../src/lib/tools/native/get-state-record';
import queryStateRecords from '../../src/lib/tools/native/query-state-records';
import updateStateRecord from '../../src/lib/tools/native/update-state-record';
import deleteStateRecord from '../../src/lib/tools/native/delete-state-record';

const BASE = 'http://test-webapp.example';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
  } as NativeToolContext;
}

/** Parse the JSON envelope a native tool returns. */
function payloadOf(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  globalThis.fetch = fn as unknown as typeof globalThis.fetch;
  return fn;
}

let originalFetch: typeof globalThis.fetch;
let originalWebappUrl: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalWebappUrl = process.env.WEBAPP_URL;
  process.env.WEBAPP_URL = BASE;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
  else process.env.WEBAPP_URL = originalWebappUrl;
  vi.restoreAllMocks();
});

describe('State Records tools — schemas', () => {
  test('declare their required inputs', () => {
    expect(createStateRecord.inputSchema.required).toEqual(['namespace', 'data']);
    expect(getStateRecord.inputSchema.required).toEqual(['namespace', 'recordId']);
    expect(queryStateRecords.inputSchema.required).toEqual(['namespace']);
    expect(updateStateRecord.inputSchema.required).toEqual(['namespace', 'recordId', 'data']);
    expect(deleteStateRecord.inputSchema.required).toEqual(['namespace', 'recordId']);
  });

  test('all belong to the `state` server', () => {
    for (const tool of [
      createStateRecord,
      getStateRecord,
      queryStateRecords,
      updateStateRecord,
      deleteStateRecord,
    ]) {
      expect(tool.server).toBe('state');
    }
  });

  test('create/update declare `data` as an object — a scalar body would not be queryable', () => {
    expect(createStateRecord.inputSchema.properties.data.type).toBe('object');
    expect(updateStateRecord.inputSchema.properties.data.type).toBe('object');
  });
});

describe('create_state_record', () => {
  test('POSTs to the canonical records URL and returns the new recordId', async () => {
    const fetchMock = mockFetch(201, {
      record: { recordId: 'rec_abc', data: { level: 'error' } },
    });

    const result = await createStateRecord.handler(
      { namespace: 'incidents', data: { level: 'error' }, tags: ['prod'], ttlSeconds: 60 },
      makeMockContext(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/state/namespaces/incidents/records`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      data: { level: 'error' },
      tags: ['prod'],
      ttlSeconds: 60,
    });

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toMatchObject({ ok: true, recordId: 'rec_abc' });
  });

  test('sends the Bearer token from run state', async () => {
    const fetchMock = mockFetch(201, { record: { recordId: 'rec_abc' } });

    await createStateRecord.handler(
      { namespace: 'ns', data: { x: 1 } },
      makeMockContext({ state: { authToken: 'tok-123', userId: 'user-1' } }),
    );

    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer tok-123');
    expect(headers['X-User-Id']).toBe('user-1');
  });

  test('URL-encodes a namespace with special characters', async () => {
    const fetchMock = mockFetch(201, { record: { recordId: 'rec_abc' } });

    await createStateRecord.handler(
      { namespace: 'my ns/weird', data: { x: 1 } },
      makeMockContext(),
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      `${BASE}/api/state/namespaces/my%20ns%2Fweird/records`,
    );
  });

  test('rejects a non-object data body without calling the API', async () => {
    const fetchMock = mockFetch(201, {});

    const result = await createStateRecord.handler(
      { namespace: 'ns', data: 'just a string' },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).code).toBe('VALIDATION');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rejects a missing namespace', async () => {
    const result = await createStateRecord.handler({ data: { x: 1 } }, makeMockContext());
    expect(result.isError).toBe(true);
  });

  test('surfaces an upstream error (e.g. the 409 record limit) as a readable message', async () => {
    mockFetch(409, {
      error: 'Namespace "incidents" has reached the record limit (50000).',
      code: 'record_limit_reached',
    });

    const result = await createStateRecord.handler(
      { namespace: 'incidents', data: { x: 1 } },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/record limit/i);
  });
});

describe('query_state_records', () => {
  test('POSTs the filter to /records/query and unwraps the results', async () => {
    const fetchMock = mockFetch(200, {
      records: [{ recordId: 'rec_1' }],
      count: 1,
      hasMore: false,
      total: 42,
    });

    const result = await queryStateRecords.handler(
      {
        namespace: 'incidents',
        filter: { 'data.level': 'error', 'data.resolvedAt': { exists: false } },
        limit: 10,
        includeTotal: true,
      },
      makeMockContext(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/state/namespaces/incidents/records/query`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      filter: { 'data.level': 'error', 'data.resolvedAt': { exists: false } },
      limit: 10,
      includeTotal: true,
    });

    expect(payloadOf(result)).toEqual({
      records: [{ recordId: 'rec_1' }],
      count: 1,
      hasMore: false,
      total: 42,
    });
  });

  test('a filterless query is a valid "list the newest" call', async () => {
    const fetchMock = mockFetch(200, { records: [], count: 0, hasMore: false });

    const result = await queryStateRecords.handler({ namespace: 'ns' }, makeMockContext());

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({});
    expect(result.isError).toBeFalsy();
  });

  test('omits `total` when the caller did not ask for it', async () => {
    mockFetch(200, { records: [], count: 0, hasMore: false });

    const result = await queryStateRecords.handler({ namespace: 'ns' }, makeMockContext());
    expect(payloadOf(result)).not.toHaveProperty('total');
  });

  test('passes a rejected filter\'s error back to the model so it can self-correct', async () => {
    // The compiler lives server-side; a raw Mongo operator comes back as a 400.
    // The tool must surface that text, not swallow it into an empty result.
    mockFetch(400, {
      error: 'filter keys may not start with "$" (got "$where")',
      code: 'invalid_filter',
    });

    const result = await queryStateRecords.handler(
      { namespace: 'ns', filter: { $where: 'sleep(5000)' } },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/\$where/);
  });

  test('rejects a non-object filter locally', async () => {
    const fetchMock = mockFetch(200, {});

    const result = await queryStateRecords.handler(
      { namespace: 'ns', filter: 'level = error' },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('get_state_record', () => {
  test('GETs the record URL and returns the record', async () => {
    const fetchMock = mockFetch(200, { record: { recordId: 'rec_abc', data: { x: 1 } } });

    const result = await getStateRecord.handler(
      { namespace: 'incidents', recordId: 'rec_abc' },
      makeMockContext(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/state/namespaces/incidents/records/rec_abc`);
    expect(init.method).toBe('GET');

    expect(payloadOf(result)).toEqual({
      found: true,
      record: { recordId: 'rec_abc', data: { x: 1 } },
    });
  });

  test('a missing record is `found: false`, NOT a tool error', async () => {
    mockFetch(404, { error: 'Record not found' });

    const result = await getStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_nope' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toEqual({ found: false, record: null });
  });

  test('rejects a missing recordId', async () => {
    const result = await getStateRecord.handler({ namespace: 'ns' }, makeMockContext());
    expect(result.isError).toBe(true);
  });

  test('a 403 IS an error (unlike a 404)', async () => {
    mockFetch(403, { error: 'Forbidden' });

    const result = await getStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_abc' },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
  });
});

describe('update_state_record', () => {
  test('PUTs the full replacement body', async () => {
    const fetchMock = mockFetch(200, { record: { recordId: 'rec_abc', data: { done: true } } });

    const result = await updateStateRecord.handler(
      { namespace: 'incidents', recordId: 'rec_abc', data: { done: true }, tags: ['closed'] },
      makeMockContext(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/state/namespaces/incidents/records/rec_abc`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ data: { done: true }, tags: ['closed'] });

    expect(payloadOf(result)).toMatchObject({ ok: true });
  });

  test('a missing record IS an error here (you asked to change something specific)', async () => {
    mockFetch(404, { error: 'Record not found' });

    const result = await updateStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_nope', data: { x: 1 } },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
  });

  test('rejects a non-object data body', async () => {
    const fetchMock = mockFetch(200, {});

    const result = await updateStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_abc', data: [1, 2, 3] },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('delete_state_record', () => {
  test('DELETEs the record URL', async () => {
    const fetchMock = mockFetch(200, { success: true, recordId: 'rec_abc' });

    const result = await deleteStateRecord.handler(
      { namespace: 'incidents', recordId: 'rec_abc' },
      makeMockContext(),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/api/state/namespaces/incidents/records/rec_abc`);
    expect(init.method).toBe('DELETE');

    expect(payloadOf(result)).toEqual({ ok: true, deleted: true, recordId: 'rec_abc' });
  });

  test('is idempotent — deleting an absent record reports deleted: false, not an error', async () => {
    mockFetch(404, { error: 'Record not found' });

    const result = await deleteStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_gone' },
      makeMockContext(),
    );

    expect(result.isError).toBeFalsy();
    expect(payloadOf(result)).toEqual({ ok: true, deleted: false, recordId: 'rec_gone' });
  });

  test('a 403 IS an error', async () => {
    mockFetch(403, { error: 'Forbidden' });

    const result = await deleteStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_abc' },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
  });

  test('surfaces a network failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof globalThis.fetch;

    const result = await deleteStateRecord.handler(
      { namespace: 'ns', recordId: 'rec_abc' },
      makeMockContext(),
    );

    expect(result.isError).toBe(true);
    expect(payloadOf(result).error).toMatch(/ECONNREFUSED/);
  });
});
