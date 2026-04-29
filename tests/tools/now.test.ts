/**
 * Vitest for native tool: now
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * Pure utility — wraps a single `new Date()` snapshot through three
 * timezone-aware formats. No mocking required.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import nowTool from '../../src/lib/tools/native/now';

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

function callOk(args: Record<string, unknown>): Promise<{
  time: string;
  timezone: string;
  unix: number;
}> {
  return nowTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return nowTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('now — schema', () => {
  test('exposes the documented inputs', () => {
    expect(nowTool.description.toLowerCase()).toMatch(/time|timezone|now/);
    expect(nowTool.inputSchema.required).toEqual([]);
    expect(nowTool.inputSchema.properties.timezone).toBeDefined();
    expect(nowTool.inputSchema.properties.format).toBeDefined();
    expect(nowTool.inputSchema.properties.format.enum).toEqual([
      'iso',
      'unix',
      'human',
    ]);
    expect(nowTool.server).toBe('utility');
  });
});

describe('now — happy path', () => {
  test('default args → ISO UTC', async () => {
    const before = Math.floor(Date.now() / 1000);
    const body = await callOk({});
    const after = Math.floor(Date.now() / 1000);
    expect(body.timezone).toBe('UTC');
    expect(typeof body.unix).toBe('number');
    // unix should be the actual current epoch — within a couple seconds of the
    // surrounding wall-clock reads.
    expect(body.unix).toBeGreaterThanOrEqual(before - 1);
    expect(body.unix).toBeLessThanOrEqual(after + 1);
    // ISO format → 2026-04-27T...Z
    expect(body.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  });

  test('format=unix → numeric string in time AND number in unix (consistent)', async () => {
    const body = await callOk({ format: 'unix' });
    expect(body.timezone).toBe('UTC');
    expect(typeof body.unix).toBe('number');
    expect(body.time).toBe(String(body.unix));
  });

  test('format=human → locale-formatted string with timezone abbreviation', async () => {
    const body = await callOk({ format: 'human', timezone: 'UTC' });
    expect(body.timezone).toBe('UTC');
    // Should contain a 4-digit year + the UTC tz tag
    expect(body.time).toMatch(/\d{4}/);
    expect(body.time).toMatch(/UTC/);
  });

  test('explicit timezone is echoed back and used for human format', async () => {
    const body = await callOk({ format: 'human', timezone: 'America/New_York' });
    expect(body.timezone).toBe('America/New_York');
    // EST/EDT short name should appear
    expect(body.time).toMatch(/E[SD]T/);
  });

  test('Asia/Tokyo timezone produces a JST label', async () => {
    const body = await callOk({ format: 'human', timezone: 'Asia/Tokyo' });
    expect(body.timezone).toBe('Asia/Tokyo');
    expect(body.time).toMatch(/(JST|GMT\+9)/);
  });

  test('whitespace-only timezone falls back to UTC', async () => {
    const body = await callOk({ timezone: '   ' });
    expect(body.timezone).toBe('UTC');
  });

  test('iso format ignores timezone (always UTC string) but unix and tz still echo', async () => {
    const body = await callOk({ format: 'iso', timezone: 'America/New_York' });
    expect(body.timezone).toBe('America/New_York');
    expect(body.time).toMatch(/Z$/); // ISO is always Zulu/UTC
  });

  test('two consecutive calls produce non-decreasing unix values', async () => {
    const a = await callOk({ format: 'unix' });
    await new Promise((r) => setTimeout(r, 10));
    const b = await callOk({ format: 'unix' });
    expect(b.unix).toBeGreaterThanOrEqual(a.unix);
  });
});

describe('now — validation errors', () => {
  test('non-string timezone → VALIDATION', async () => {
    const body = await callErr({ timezone: 123 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/timezone/i);
  });

  test('unknown timezone → VALIDATION', async () => {
    const body = await callErr({ timezone: 'Mars/Olympus_Mons' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/invalid timezone/i);
  });

  test('invalid format → VALIDATION', async () => {
    const body = await callErr({ format: 'rfc822' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/format must be one of/i);
  });

  test('non-string format → VALIDATION', async () => {
    const body = await callErr({ format: 42 });
    expect(body.code).toBe('VALIDATION');
  });
});
