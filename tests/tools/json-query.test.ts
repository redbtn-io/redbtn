/**
 * Vitest for native tool: json_query
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * Pure utility — no fetch / no env.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import jsonQueryTool from '../../src/lib/tools/native/json-query';

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

function callOk(args: Record<string, unknown>): Promise<{ value: unknown }> {
  return jsonQueryTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return jsonQueryTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('json_query — schema', () => {
  test('exposes the documented inputs', () => {
    expect(jsonQueryTool.description.toLowerCase()).toMatch(/jsonpath|json/);
    expect(jsonQueryTool.inputSchema.required).toEqual(['data', 'path']);
    expect(jsonQueryTool.inputSchema.properties.data).toBeDefined();
    expect(jsonQueryTool.inputSchema.properties.path).toBeDefined();
    expect(jsonQueryTool.server).toBe('pattern');
  });
});

describe('json_query — happy path (basic)', () => {
  test('reads a single object property', async () => {
    const body = await callOk({
      data: { name: 'Alice', age: 30 },
      path: '$.name',
    });
    expect(body.value).toBe('Alice');
  });

  test('reads a nested property', async () => {
    const body = await callOk({
      data: { user: { profile: { city: 'Paris' } } },
      path: '$.user.profile.city',
    });
    expect(body.value).toBe('Paris');
  });

  test('reads an array index', async () => {
    const body = await callOk({
      data: { tags: ['a', 'b', 'c'] },
      path: '$.tags[1]',
    });
    expect(body.value).toBe('b');
  });

  test('canonical $.users[0].name shape from the spec', async () => {
    const body = await callOk({
      data: { users: [{ name: 'Alice' }, { name: 'Bob' }] },
      path: '$.users[0].name',
    });
    expect(body.value).toBe('Alice');
  });

  test('reads root with $ alone', async () => {
    const body = await callOk({ data: { ok: true }, path: '$' });
    expect(body.value).toEqual({ ok: true });
  });
});

describe('json_query — bracket notation', () => {
  test('quoted single-quote key with a dot in it', async () => {
    const body = await callOk({
      data: { 'a.b': 42 },
      path: "$['a.b']",
    });
    expect(body.value).toBe(42);
  });

  test('quoted double-quote key with a space', async () => {
    const body = await callOk({
      data: { 'full name': 'Alice' },
      path: '$["full name"]',
    });
    expect(body.value).toBe('Alice');
  });

  test('mixed bracket + dot navigation', async () => {
    const body = await callOk({
      data: { 'odd key': { items: [10, 20, 30] } },
      path: '$["odd key"].items[2]',
    });
    expect(body.value).toBe(30);
  });
});

describe('json_query — negative indexes', () => {
  test('-1 returns the last element', async () => {
    const body = await callOk({
      data: { items: ['a', 'b', 'c'] },
      path: '$.items[-1]',
    });
    expect(body.value).toBe('c');
  });

  test('-2 returns second-from-last', async () => {
    const body = await callOk({
      data: { items: ['a', 'b', 'c', 'd'] },
      path: '$.items[-2]',
    });
    expect(body.value).toBe('c');
  });

  test('negative out of range returns null', async () => {
    const body = await callOk({
      data: { items: [1, 2] },
      path: '$.items[-10]',
    });
    expect(body.value).toBeNull();
  });
});

describe('json_query — bare paths (no $)', () => {
  test('users.0.name without leading $', async () => {
    const body = await callOk({
      data: { users: [{ name: 'Alice' }] },
      path: 'users[0].name',
    });
    expect(body.value).toBe('Alice');
  });

  test('leading dot tolerated', async () => {
    const body = await callOk({
      data: { foo: 'bar' },
      path: '.foo',
    });
    expect(body.value).toBe('bar');
  });
});

describe('json_query — missing values', () => {
  test('missing object key returns null', async () => {
    const body = await callOk({
      data: { name: 'Alice' },
      path: '$.email',
    });
    expect(body.value).toBeNull();
  });

  test('out-of-range array index returns null', async () => {
    const body = await callOk({
      data: { items: ['a', 'b'] },
      path: '$.items[5]',
    });
    expect(body.value).toBeNull();
  });

  test('drilling through null returns null', async () => {
    const body = await callOk({
      data: { user: null },
      path: '$.user.profile.city',
    });
    expect(body.value).toBeNull();
  });

  test('drilling through undefined returns null', async () => {
    const body = await callOk({
      data: {},
      path: '$.does.not.exist',
    });
    expect(body.value).toBeNull();
  });

  test('explicit null value returned as null', async () => {
    const body = await callOk({
      data: { key: null },
      path: '$.key',
    });
    expect(body.value).toBeNull();
  });
});

describe('json_query — primitives & arrays', () => {
  test('querying a primitive root with $', async () => {
    const body = await callOk({ data: 42, path: '$' });
    expect(body.value).toBe(42);
  });

  test('drilling into a primitive returns null', async () => {
    const body = await callOk({ data: 'hello', path: '$.length' });
    // .length on a string is not supported by our model — returns null safely
    expect(body.value).toBeNull();
  });

  test('array.length is supported', async () => {
    const body = await callOk({
      data: { items: [1, 2, 3, 4] },
      path: '$.items.length',
    });
    expect(body.value).toBe(4);
  });

  test('array of objects + nested', async () => {
    const body = await callOk({
      data: {
        orders: [
          { id: 1, items: [{ sku: 'A', qty: 2 }] },
          { id: 2, items: [{ sku: 'B', qty: 1 }, { sku: 'C', qty: 3 }] },
        ],
      },
      path: '$.orders[1].items[1].sku',
    });
    expect(body.value).toBe('C');
  });
});

describe('json_query — validation errors', () => {
  test('missing data → VALIDATION', async () => {
    const body = await callErr({ path: '$.foo' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/data is required/i);
  });

  test('missing path → VALIDATION', async () => {
    const body = await callErr({ data: { foo: 1 } });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/path is required/i);
  });

  test('empty path → VALIDATION', async () => {
    const body = await callErr({ data: { foo: 1 }, path: '' });
    expect(body.code).toBe('VALIDATION');
  });

  test('unsupported wildcard syntax → VALIDATION', async () => {
    const body = await callErr({ data: { items: [1] }, path: '$.items[*]' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error.toLowerCase()).toMatch(/jsonpath|unsupported/);
  });

  test('unsupported recursive syntax → VALIDATION', async () => {
    const body = await callErr({ data: {}, path: '$..foo' });
    expect(body.code).toBe('VALIDATION');
  });

  test('unclosed bracket → VALIDATION', async () => {
    const body = await callErr({ data: { a: 1 }, path: '$.a[' });
    expect(body.code).toBe('VALIDATION');
  });

  test('empty key after dot → VALIDATION', async () => {
    const body = await callErr({ data: { a: 1 }, path: '$..' });
    expect(body.code).toBe('VALIDATION');
  });

  test('data: null is allowed (returns null)', async () => {
    const body = await callOk({ data: null, path: '$.foo' });
    expect(body.value).toBeNull();
  });
});

describe('json_query — quoted keys with escapes', () => {
  test('escaped single quote inside single-quoted key', async () => {
    const body = await callOk({
      data: { "it's me": 'hi' },
      path: "$['it\\'s me']",
    });
    expect(body.value).toBe('hi');
  });
});

describe('json_query — numeric keys on objects', () => {
  test('object indexed by numeric key works via [N]', async () => {
    const body = await callOk({
      data: { '0': 'first', '1': 'second' },
      path: '$[0]',
    });
    expect(body.value).toBe('first');
  });
});
