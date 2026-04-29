/**
 * Vitest for native tool: strip_formatting
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + edge cases.
 *
 * Pure utility — both Markdown and HTML branches.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import stripFormattingTool from '../../src/lib/tools/native/strip-formatting';

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

function callOk(args: Record<string, unknown>): Promise<{ text: string }> {
  return stripFormattingTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBeFalsy();
    return JSON.parse(r.content[0].text);
  });
}

function callErr(args: Record<string, unknown>) {
  return stripFormattingTool.handler(args, makeMockContext()).then((r) => {
    expect(r.isError).toBe(true);
    return JSON.parse(r.content[0].text);
  });
}

describe('strip_formatting — schema', () => {
  test('exposes the documented inputs', () => {
    expect(stripFormattingTool.description.toLowerCase()).toMatch(
      /strip|formatting|markdown|html/,
    );
    expect(stripFormattingTool.inputSchema.required).toEqual(['text', 'format']);
    expect(stripFormattingTool.inputSchema.properties.text).toBeDefined();
    expect(stripFormattingTool.inputSchema.properties.format.enum).toEqual([
      'markdown',
      'html',
    ]);
    expect(stripFormattingTool.server).toBe('pattern');
  });
});

describe('strip_formatting — markdown', () => {
  test('strips bold/italic/strike markers', async () => {
    const body = await callOk({
      text: 'Hello **bold** and _italic_ and ~~struck~~ words',
      format: 'markdown',
    });
    expect(body.text).toBe('Hello bold and italic and struck words');
  });

  test('strips bold-italic compound (***)', async () => {
    const body = await callOk({
      text: 'Make it ***pop*** here',
      format: 'markdown',
    });
    expect(body.text).toBe('Make it pop here');
  });

  test('removes heading markers but keeps the text', async () => {
    const body = await callOk({
      text: '# Title\n\n## Subtitle\n\nSome body.',
      format: 'markdown',
    });
    expect(body.text).toBe('Title\n\nSubtitle\n\nSome body.');
  });

  test('removes blockquote markers', async () => {
    const body = await callOk({
      text: '> A wise quote\n> spans many lines',
      format: 'markdown',
    });
    expect(body.text).toBe('A wise quote\nspans many lines');
  });

  test('removes list bullets', async () => {
    const body = await callOk({
      text: '- one\n- two\n- three',
      format: 'markdown',
    });
    expect(body.text).toBe('one\ntwo\nthree');
  });

  test('removes ordered-list numbers', async () => {
    const body = await callOk({
      text: '1. first\n2. second\n3. third',
      format: 'markdown',
    });
    expect(body.text).toBe('first\nsecond\nthird');
  });

  test('extracts the visible text from inline links', async () => {
    const body = await callOk({
      text: 'Visit [my site](https://example.com) for details.',
      format: 'markdown',
    });
    expect(body.text).toBe('Visit my site for details.');
  });

  test('extracts alt-text from images', async () => {
    const body = await callOk({
      text: 'See ![the chart](https://example.com/c.png) below.',
      format: 'markdown',
    });
    expect(body.text).toBe('See the chart below.');
  });

  test('strips inline code backticks but keeps the code text', async () => {
    const body = await callOk({
      text: 'Run `npm install` to set up.',
      format: 'markdown',
    });
    expect(body.text).toBe('Run npm install to set up.');
  });

  test('strips code fences but keeps the body', async () => {
    const body = await callOk({
      text: 'Example:\n\n```js\nconsole.log("hi");\n```\n\nDone.',
      format: 'markdown',
    });
    expect(body.text).toContain('console.log("hi");');
    expect(body.text).not.toContain('```');
  });

  test('strips horizontal rules', async () => {
    const body = await callOk({
      text: 'one\n\n---\n\ntwo',
      format: 'markdown',
    });
    expect(body.text).toBe('one\n\ntwo');
  });

  test('removes table separator and pipes', async () => {
    const body = await callOk({
      text: '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |',
      format: 'markdown',
    });
    expect(body.text).not.toContain('|');
    expect(body.text).not.toContain('---');
    expect(body.text).toContain('a');
    expect(body.text).toContain('b');
    expect(body.text).toContain('1');
    expect(body.text).toContain('2');
  });

  test('strips reference-style links + drops the reference definition', async () => {
    const body = await callOk({
      text: 'Here is [a link][1] in text.\n\n[1]: https://example.com',
      format: 'markdown',
    });
    expect(body.text).toContain('Here is a link in text.');
    expect(body.text).not.toContain('https://example.com');
  });
});

describe('strip_formatting — html', () => {
  test('strips simple tags', async () => {
    const body = await callOk({
      text: '<p>Hello <b>world</b></p>',
      format: 'html',
    });
    expect(body.text).toBe('Hello world');
  });

  test('drops <script> blocks (and their content)', async () => {
    const body = await callOk({
      text: '<p>Visible</p><script>alert("nope")</script><p>Also visible</p>',
      format: 'html',
    });
    expect(body.text).not.toContain('alert');
    expect(body.text).not.toContain('nope');
    expect(body.text).toContain('Visible');
    expect(body.text).toContain('Also visible');
  });

  test('drops <style> blocks (and their content)', async () => {
    const body = await callOk({
      text: '<style>body { color: red; }</style><p>Body text</p>',
      format: 'html',
    });
    expect(body.text).not.toContain('color: red');
    expect(body.text).toContain('Body text');
  });

  test('decodes common HTML entities', async () => {
    const body = await callOk({
      text: '<p>Tom &amp; Jerry &lt;3 &quot;cheese&quot; &mdash; yum!</p>',
      format: 'html',
    });
    expect(body.text).toBe('Tom & Jerry <3 "cheese" — yum!');
  });

  test('decodes numeric and hex entities', async () => {
    const body = await callOk({
      text: 'A &#65; and a &#x42;',
      format: 'html',
    });
    expect(body.text).toBe('A A and a B');
  });

  test('inserts newlines on block-level closes', async () => {
    const body = await callOk({
      text: '<h1>Title</h1><p>Para 1</p><p>Para 2</p>',
      format: 'html',
    });
    expect(body.text).toBe('Title\nPara 1\nPara 2');
  });

  test('strips HTML comments', async () => {
    const body = await callOk({
      text: '<!-- secret comment --><p>visible</p>',
      format: 'html',
    });
    expect(body.text).toBe('visible');
    expect(body.text).not.toContain('secret');
  });

  test('handles nested tags', async () => {
    const body = await callOk({
      text: '<div><span><em>nested</em></span></div>',
      format: 'html',
    });
    expect(body.text).toBe('nested');
  });

  test('handles attributes on tags', async () => {
    const body = await callOk({
      text: '<a href="https://example.com" class="x">link</a>',
      format: 'html',
    });
    expect(body.text).toBe('link');
  });

  test('<br> becomes a newline', async () => {
    const body = await callOk({
      text: 'one<br>two<br/>three',
      format: 'html',
    });
    expect(body.text).toBe('one\ntwo\nthree');
  });
});

describe('strip_formatting — edge cases', () => {
  test('empty input returns empty text (markdown)', async () => {
    const body = await callOk({ text: '', format: 'markdown' });
    expect(body.text).toBe('');
  });

  test('empty input returns empty text (html)', async () => {
    const body = await callOk({ text: '', format: 'html' });
    expect(body.text).toBe('');
  });

  test('plain text passes through markdown unchanged', async () => {
    const body = await callOk({
      text: 'no formatting here',
      format: 'markdown',
    });
    expect(body.text).toBe('no formatting here');
  });

  test('plain text passes through html unchanged', async () => {
    const body = await callOk({
      text: 'no tags here',
      format: 'html',
    });
    expect(body.text).toBe('no tags here');
  });

  test('unicode is preserved (markdown)', async () => {
    const body = await callOk({
      text: '## こんにちは\n\n**世界** 🌍',
      format: 'markdown',
    });
    expect(body.text).toContain('こんにちは');
    expect(body.text).toContain('世界');
    expect(body.text).toContain('🌍');
  });

  test('unicode is preserved (html)', async () => {
    const body = await callOk({
      text: '<h1>こんにちは</h1><p>🌍 世界</p>',
      format: 'html',
    });
    expect(body.text).toBe('こんにちは\n🌍 世界');
  });

  test('html with mixed-case tags', async () => {
    const body = await callOk({
      text: '<P>Mixed</P><B>case</B>',
      format: 'html',
    });
    expect(body.text).toContain('Mixed');
    expect(body.text).toContain('case');
  });

  test('markdown with stray HTML still sanitised', async () => {
    const body = await callOk({
      text: '# Title\n\n<span class="x">extra</span> text',
      format: 'markdown',
    });
    expect(body.text).toContain('Title');
    expect(body.text).toContain('extra text');
    expect(body.text).not.toContain('<span');
  });
});

describe('strip_formatting — validation errors', () => {
  test('missing text → VALIDATION', async () => {
    const body = await callErr({ format: 'markdown' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('non-string text → VALIDATION', async () => {
    const body = await callErr({ text: 42, format: 'markdown' });
    expect(body.code).toBe('VALIDATION');
  });

  test('missing format → VALIDATION', async () => {
    const body = await callErr({ text: 'hello' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/format is required/i);
  });

  test('invalid format → VALIDATION', async () => {
    const body = await callErr({ text: 'hello', format: 'docx' });
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/markdown|html/i);
  });

  test('null format → VALIDATION', async () => {
    const body = await callErr({ text: 'hello', format: null });
    expect(body.code).toBe('VALIDATION');
  });
});
