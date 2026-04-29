/**
 * Vitest for native tool: extract_thinking
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * Pure utility — wraps the engine's extractThinking() helper.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import extractThinkingTool from '../../src/lib/tools/native/extract-thinking';

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
  thinking: string;
  content: string;
}> {
  return extractThinkingTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return extractThinkingTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('extract_thinking — schema', () => {
  test('exposes the documented inputs', () => {
    expect(extractThinkingTool.description.toLowerCase()).toMatch(
      /think|reasoning/,
    );
    expect(extractThinkingTool.inputSchema.required).toEqual(['text']);
    expect(extractThinkingTool.inputSchema.properties.text).toBeDefined();
    expect(extractThinkingTool.server).toBe('pattern');
  });
});

describe('extract_thinking — happy path', () => {
  test('extracts a single <think> block', async () => {
    const body = await callOk({
      text: '<think>Reasoning here</think>The answer is 42.',
    });
    expect(body.thinking).toBe('Reasoning here');
    expect(body.content).toBe('The answer is 42.');
  });

  test('extracts multi-line thinking and tidies surrounding whitespace', async () => {
    const body = await callOk({
      text:
        '<think>\nFirst, I weighed the options.\nThen I picked the best one.\n</think>\n\n\nFinal answer: pizza.',
    });
    expect(body.thinking).toMatch(/First, I weighed the options/);
    expect(body.thinking).toMatch(/Then I picked the best one/);
    expect(body.content).toBe('Final answer: pizza.');
  });

  test('joins multiple <think> blocks with a separator', async () => {
    const body = await callOk({
      text:
        '<think>First thought</think>Some content.<think>Second thought</think>More content.',
    });
    expect(body.thinking).toContain('First thought');
    expect(body.thinking).toContain('Second thought');
    expect(body.thinking).toContain('---');
    expect(body.content).toMatch(/Some content/);
    expect(body.content).toMatch(/More content/);
  });

  test('case-insensitive tag match (<THINK>...</THINK>)', async () => {
    const body = await callOk({
      text: '<THINK>upper-case tag</THINK>plain content',
    });
    expect(body.thinking).toBe('upper-case tag');
    expect(body.content).toBe('plain content');
  });
});

describe('extract_thinking — passthrough', () => {
  test('no <think> tags → thinking: "" and content unchanged', async () => {
    const body = await callOk({ text: 'Just a plain answer.' });
    expect(body.thinking).toBe('');
    expect(body.content).toBe('Just a plain answer.');
  });

  test('empty input → both empty', async () => {
    const body = await callOk({ text: '' });
    expect(body.thinking).toBe('');
    expect(body.content).toBe('');
  });

  test('only thinking, no content → thinking populated, content empty', async () => {
    const body = await callOk({ text: '<think>only thoughts</think>' });
    expect(body.thinking).toBe('only thoughts');
    expect(body.content).toBe('');
  });

  test('content with whitespace only around tags is collapsed', async () => {
    const body = await callOk({
      text: '\n\n\n<think>x</think>\n\n\nAnswer.\n\n\n',
    });
    expect(body.thinking).toBe('x');
    expect(body.content).toBe('Answer.');
  });
});

describe('extract_thinking — edge cases', () => {
  test('unicode inside think block is preserved', async () => {
    const body = await callOk({
      text: '<think>思考中… 🤔</think>答案是42',
    });
    expect(body.thinking).toBe('思考中… 🤔');
    expect(body.content).toBe('答案是42');
  });

  test('think tags adjacent to content', async () => {
    const body = await callOk({
      text: 'pre<think>middle</think>post',
    });
    expect(body.thinking).toBe('middle');
    expect(body.content).toBe('prepost');
  });

  test('unclosed think tag is left in content (no false extraction)', async () => {
    const body = await callOk({
      text: '<think>incomplete reasoning here',
    });
    expect(body.thinking).toBe('');
    expect(body.content).toBe('<think>incomplete reasoning here');
  });

  test('preserves max 2 consecutive newlines in content', async () => {
    const body = await callOk({
      text: '<think>x</think>line1\n\n\n\n\nline2',
    });
    expect(body.content).toBe('line1\n\nline2');
  });
});

describe('extract_thinking — validation errors', () => {
  test('missing text → VALIDATION', async () => {
    const body = await callErr({});
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('non-string text → VALIDATION', async () => {
    const body = await callErr({ text: 123 });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('null text → VALIDATION', async () => {
    const body = await callErr({ text: null });
    expect(body.code).toBe('VALIDATION');
  });
});
