/**
 * Vitest for native tool: generate_id
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + statistical
 * coverage of each ID format.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import generateIdTool from '../../src/lib/tools/native/generate-id';

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

function callOk(args: Record<string, unknown>): Promise<{ id: string }> {
  return generateIdTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return generateIdTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('generate_id — schema', () => {
  test('exposes the documented inputs', () => {
    expect(generateIdTool.description.toLowerCase()).toMatch(/id|identifier/);
    expect(generateIdTool.inputSchema.required).toEqual([]);
    expect(generateIdTool.inputSchema.properties.format).toBeDefined();
    expect(generateIdTool.inputSchema.properties.format.enum).toEqual([
      'uuid',
      'short',
      'numeric',
    ]);
    expect(generateIdTool.inputSchema.properties.prefix).toBeDefined();
    expect(generateIdTool.server).toBe('utility');
  });
});

describe('generate_id — uuid (default)', () => {
  test('default args returns a v4 UUID', async () => {
    const body = await callOk({});
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('explicit format=uuid is the same as default', async () => {
    const body = await callOk({ format: 'uuid' });
    expect(body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(body.id.length).toBe(36);
  });

  test('repeated calls produce distinct UUIDs', async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => callOk({})),
    );
    const set = new Set(ids.map((b) => b.id));
    expect(set.size).toBe(ids.length);
  });
});

describe('generate_id — short', () => {
  test('returns an 8-char URL-safe ID', async () => {
    const body = await callOk({ format: 'short' });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(body.id.length).toBe(8);
  });

  test('repeated calls produce distinct shorts', async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => callOk({ format: 'short' })),
    );
    const set = new Set(ids.map((b) => b.id));
    // 50 random 8-char IDs from a 64^8 space — collisions are vanishingly rare.
    expect(set.size).toBe(ids.length);
  });
});

describe('generate_id — numeric', () => {
  test('returns a 12-digit string', async () => {
    const body = await callOk({ format: 'numeric' });
    expect(body.id).toMatch(/^\d{12}$/);
    expect(body.id.length).toBe(12);
  });

  test('repeated calls produce distinct numerics', async () => {
    const ids = await Promise.all(
      Array.from({ length: 50 }, () => callOk({ format: 'numeric' })),
    );
    const set = new Set(ids.map((b) => b.id));
    expect(set.size).toBe(ids.length);
  });

  test('numeric IDs use the full 0-9 alphabet over many samples', async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, () => callOk({ format: 'numeric' })),
    );
    const seen = new Set(ids.flatMap((b) => b.id.split('')));
    // Across 240 digits we should see most/all of 0-9. Allow a couple missing
    // for an unlucky run; this is a sanity check, not a chi-squared test.
    expect(seen.size).toBeGreaterThanOrEqual(8);
  });
});

describe('generate_id — prefix', () => {
  test('prefix is concatenated verbatim (no auto-separator)', async () => {
    const body = await callOk({ format: 'short', prefix: 'req' });
    expect(body.id.startsWith('req')).toBe(true);
    expect(body.id.length).toBe(3 + 8);
  });

  test('prefix with separator is preserved as-is', async () => {
    const body = await callOk({ format: 'uuid', prefix: 'session-' });
    expect(body.id.startsWith('session-')).toBe(true);
    // Should still be the prefix + 36-char UUID
    expect(body.id.length).toBe('session-'.length + 36);
    expect(body.id.slice('session-'.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  test('numeric format with prefix', async () => {
    const body = await callOk({ format: 'numeric', prefix: 'tx_' });
    expect(body.id).toMatch(/^tx_\d{12}$/);
  });

  test('empty prefix produces ID with no leading characters', async () => {
    const body = await callOk({ format: 'short', prefix: '' });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });

  test('null prefix is treated as no prefix', async () => {
    // null is allowed through the optional/undefined coalescing path
    const body = await callOk({ format: 'short', prefix: null as unknown as string });
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{8}$/);
  });
});

describe('generate_id — validation errors', () => {
  test('invalid format → VALIDATION', async () => {
    const body = await callErr({ format: 'snowflake' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/format must be one of/i);
  });

  test('non-string format → VALIDATION', async () => {
    const body = await callErr({ format: 42 });
    expect(body.code).toBe('VALIDATION');
  });

  test('non-string prefix → VALIDATION', async () => {
    const body = await callErr({ prefix: 123 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/prefix/i);
  });
});
