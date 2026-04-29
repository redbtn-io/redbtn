/**
 * Vitest for native tool: count_tokens
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * The tool prefers `tiktoken` when installed and falls back to a coarse
 * estimate otherwise. We test both paths by checking only the *shape* of
 * the result (the exact count differs between encoders), and we exercise
 * a few canonical inputs.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import countTokensTool from '../../src/lib/tools/native/count-tokens';

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
  tokens: number;
  model: string;
}> {
  return countTokensTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return countTokensTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('count_tokens — schema', () => {
  test('exposes the documented inputs', () => {
    expect(countTokensTool.description.toLowerCase()).toMatch(
      /count|token/,
    );
    expect(countTokensTool.inputSchema.required).toEqual(['text']);
    expect(countTokensTool.inputSchema.properties.text).toBeDefined();
    expect(countTokensTool.inputSchema.properties.model).toBeDefined();
    expect(countTokensTool.inputSchema.properties.model.default).toBe('gpt-4');
    expect(countTokensTool.server).toBe('pattern');
  });
});

describe('count_tokens — happy path', () => {
  test('returns a positive integer for normal text', async () => {
    const body = await callOk({ text: 'Hello, world!' });
    expect(typeof body.tokens).toBe('number');
    expect(Number.isInteger(body.tokens)).toBe(true);
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.model).toBe('gpt-4');
  });

  test('larger text yields more tokens than smaller text', async () => {
    const small = await callOk({ text: 'hi' });
    const big = await callOk({
      text:
        'The quick brown fox jumps over the lazy dog. ' +
        'The quick brown fox jumps over the lazy dog. ' +
        'The quick brown fox jumps over the lazy dog.',
    });
    expect(big.tokens).toBeGreaterThan(small.tokens);
  });

  test('echoes the requested model in the response', async () => {
    const body = await callOk({ text: 'foo', model: 'gpt-3.5-turbo' });
    expect(body.model).toBe('gpt-3.5-turbo');
    expect(body.tokens).toBeGreaterThan(0);
  });

  test('whitespace-only model name falls back to default', async () => {
    const body = await callOk({ text: 'foo', model: '   ' });
    expect(body.model).toBe('gpt-4');
  });

  test('unknown model name still returns a count via fallback', async () => {
    const body = await callOk({ text: 'hello world', model: 'made-up-model' });
    expect(body.tokens).toBeGreaterThan(0);
    expect(body.model).toBe('made-up-model');
  });
});

describe('count_tokens — edge cases', () => {
  test('empty input → tokens: 0', async () => {
    const body = await callOk({ text: '' });
    expect(body.tokens).toBe(0);
    expect(body.model).toBe('gpt-4');
  });

  test('single character', async () => {
    const body = await callOk({ text: 'a' });
    expect(body.tokens).toBeGreaterThanOrEqual(1);
  });

  test('unicode (emoji + CJK) returns a positive count', async () => {
    const body = await callOk({ text: 'こんにちは 🌍 世界' });
    expect(body.tokens).toBeGreaterThan(0);
  });

  test('long text under reasonable bound', async () => {
    const text = 'word '.repeat(1000);
    const body = await callOk({ text });
    // ~1000 words ≈ 1000-2000 tokens depending on encoder; both bounds
    // protect against returning a wildly wrong number.
    expect(body.tokens).toBeGreaterThan(500);
    expect(body.tokens).toBeLessThan(5000);
  });

  test('newlines and tabs are tokenised', async () => {
    const body = await callOk({ text: 'a\nb\tc' });
    expect(body.tokens).toBeGreaterThan(0);
  });
});

describe('count_tokens — defaults', () => {
  test('omitting model defaults to "gpt-4"', async () => {
    const body = await callOk({ text: 'foo bar' });
    expect(body.model).toBe('gpt-4');
  });

  test('explicit model "gpt-4" same as default behaviour', async () => {
    const a = await callOk({ text: 'one two three four five' });
    const b = await callOk({ text: 'one two three four five', model: 'gpt-4' });
    expect(b.tokens).toBe(a.tokens);
  });
});

describe('count_tokens — validation errors', () => {
  test('missing text → VALIDATION', async () => {
    const body = await callErr({});
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('non-string text → VALIDATION', async () => {
    const body = await callErr({ text: 42 });
    expect(body.code).toBe('VALIDATION');
  });

  test('null text → VALIDATION', async () => {
    const body = await callErr({ text: null });
    expect(body.code).toBe('VALIDATION');
  });
});
