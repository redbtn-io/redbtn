/**
 * Vitest for native tool: regex_match
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * The tool is a pure utility — no fetch, no env, no side effects — so the
 * tests focus on regex semantics, mode switching, and graceful failure.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import regexMatchTool from '../../src/lib/tools/native/regex-match';

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
  matches: Array<{ match: string; groups: unknown; index: number }>;
}> {
  return regexMatchTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return regexMatchTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('regex_match — schema', () => {
  test('exposes the documented inputs', () => {
    expect(regexMatchTool.description.toLowerCase()).toMatch(/regex|regular expression/);
    expect(regexMatchTool.inputSchema.required).toEqual(['text', 'pattern']);
    expect(regexMatchTool.inputSchema.properties.text).toBeDefined();
    expect(regexMatchTool.inputSchema.properties.pattern).toBeDefined();
    expect(regexMatchTool.inputSchema.properties.flags).toBeDefined();
    expect(regexMatchTool.inputSchema.properties.mode).toBeDefined();
    expect(regexMatchTool.inputSchema.properties.mode.enum).toEqual(['first', 'all']);
    expect(regexMatchTool.server).toBe('pattern');
  });
});

describe('regex_match — happy path (first mode)', () => {
  test('returns the first match with positional groups', async () => {
    const body = await callOk({
      text: 'order ABC-123 placed on 2024-04-27',
      pattern: '([A-Z]+)-(\\d+)',
    });
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('ABC-123');
    expect(body.matches[0].index).toBe(6);
    expect(body.matches[0].groups).toEqual(['ABC', '123']);
  });

  test('returns named groups when present', async () => {
    const body = await callOk({
      text: 'Sent on 2024-04-27 at 09:30',
      pattern: '(?<year>\\d{4})-(?<month>\\d{2})-(?<day>\\d{2})',
    });
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].groups).toEqual({ year: '2024', month: '04', day: '27' });
    expect(body.matches[0].match).toBe('2024-04-27');
  });

  test('respects the i flag (case-insensitive)', async () => {
    const body = await callOk({ text: 'Hello WORLD', pattern: 'world', flags: 'i' });
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('WORLD');
    expect(body.matches[0].index).toBe(6);
  });

  test('returns empty matches when no hit', async () => {
    const body = await callOk({ text: 'foo bar baz', pattern: 'qux' });
    expect(body.matches).toEqual([]);
  });

  test('returns empty groups array when pattern has no captures', async () => {
    const body = await callOk({ text: 'hello world', pattern: 'world' });
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('world');
    expect(body.matches[0].groups).toEqual([]);
  });
});

describe('regex_match — happy path (all mode)', () => {
  test('returns every match', async () => {
    const body = await callOk({
      text: 'a1 b2 c3 d4',
      pattern: '[a-z](\\d)',
      mode: 'all',
    });
    expect(body.matches).toHaveLength(4);
    expect(body.matches.map((m: any) => m.match)).toEqual(['a1', 'b2', 'c3', 'd4']);
    expect(body.matches.map((m: any) => m.groups[0])).toEqual(['1', '2', '3', '4']);
    expect(body.matches.map((m: any) => m.index)).toEqual([0, 3, 6, 9]);
  });

  test('auto-adds the g flag in mode: all', async () => {
    // Caller passes flags: 'i' (no 'g'); the tool should still find every match.
    const body = await callOk({
      text: 'X x X x',
      pattern: 'x',
      flags: 'i',
      mode: 'all',
    });
    expect(body.matches).toHaveLength(4);
  });

  test('returns first match\'s index correctly when mode: all', async () => {
    const body = await callOk({
      text: '....foo....bar',
      pattern: '(foo|bar)',
      mode: 'all',
    });
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0].index).toBe(4);
    expect(body.matches[1].index).toBe(11);
  });

  test('mode: all + no matches returns empty array', async () => {
    const body = await callOk({ text: 'a b c', pattern: 'z+', mode: 'all' });
    expect(body.matches).toEqual([]);
  });
});

describe('regex_match — edge cases', () => {
  test('empty input text returns no matches', async () => {
    const body = await callOk({ text: '', pattern: '\\w+', mode: 'all' });
    expect(body.matches).toEqual([]);
  });

  test('handles unicode pattern with the u flag', async () => {
    const body = await callOk({
      text: 'Hello 🌍 world 🚀',
      pattern: '\\p{Emoji_Presentation}',
      flags: 'gu',
      mode: 'all',
    });
    expect(body.matches.length).toBeGreaterThanOrEqual(2);
    const matched = body.matches.map((m: any) => m.match);
    expect(matched).toContain('🌍');
    expect(matched).toContain('🚀');
  });

  test('multiline flag (m) matches per-line', async () => {
    const body = await callOk({
      text: 'foo\nbar\nbaz',
      pattern: '^bar$',
      flags: 'm',
    });
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('bar');
  });

  test('zero-width matches in mode: all do not loop forever', async () => {
    // \\b is a zero-width assertion; matchAll with /g yields finite hits.
    const body = await callOk({
      text: 'one two three',
      pattern: '\\b',
      flags: 'g',
      mode: 'all',
    });
    // 6 word boundaries (start/end of each of the three words)
    expect(body.matches.length).toBeGreaterThanOrEqual(3);
    expect(body.matches.length).toBeLessThanOrEqual(20);
  });

  test('special regex chars in pattern source are honoured', async () => {
    const body = await callOk({
      text: 'price is $10.50',
      pattern: '\\$\\d+\\.\\d{2}',
    });
    expect(body.matches[0].match).toBe('$10.50');
  });
});

describe('regex_match — validation errors', () => {
  test('missing text → VALIDATION', async () => {
    const body = await callErr({ pattern: 'foo' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('non-string text → VALIDATION', async () => {
    const body = await callErr({ text: 123, pattern: 'foo' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('missing pattern → VALIDATION', async () => {
    const body = await callErr({ text: 'foo' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/pattern is required/i);
  });

  test('empty pattern → VALIDATION', async () => {
    const body = await callErr({ text: 'foo', pattern: '' });
    expect(body.code).toBe('VALIDATION');
  });

  test('non-string flags → VALIDATION', async () => {
    const body = await callErr({ text: 'foo', pattern: 'f', flags: 7 as any });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/flags must be a string/i);
  });

  test('malformed regex → VALIDATION', async () => {
    const body = await callErr({ text: 'foo', pattern: '[unclosed' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/invalid regex/i);
  });

  test('unknown flag → VALIDATION', async () => {
    const body = await callErr({ text: 'foo', pattern: 'foo', flags: 'qz' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/invalid regex/i);
  });
});

describe('regex_match — defaults', () => {
  test('mode defaults to "first"', async () => {
    const body = await callOk({
      text: 'aa bb cc',
      pattern: '\\w+',
    });
    // First mode → only 1 match
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('aa');
  });

  test('flags default to empty', async () => {
    const body = await callOk({ text: 'AAA aaa', pattern: 'aaa' });
    // Without 'i', only the lowercase match is found
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].match).toBe('aaa');
    expect(body.matches[0].index).toBe(4);
  });
});
