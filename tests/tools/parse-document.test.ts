/**
 * Vitest for native tool: parse_document
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * Wraps the shared DocumentParser. We exercise the formats that don't need a
 * native binary parser (text, markdown, json, csv) directly with real bytes,
 * and stub DocumentParser.parse() for the PDF/DOCX path so we can validate
 * the metadata fan-out (pageCount + wordCount) without dragging pdf-parse or
 * mammoth into the test runner.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import parseDocumentTool from '../../src/lib/tools/native/parse-document';
import * as documentParserModule from '../../src/lib/memory/documentParser';

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

function toB64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('parse_document — schema', () => {
  test('exposes the documented inputs per spec', () => {
    expect(parseDocumentTool.description.toLowerCase()).toContain('parse');
    expect(parseDocumentTool.inputSchema.required).toEqual([
      'fileBase64',
      'mimeType',
    ]);
    expect(parseDocumentTool.inputSchema.properties.fileBase64).toBeDefined();
    expect(parseDocumentTool.inputSchema.properties.mimeType).toBeDefined();
    expect(parseDocumentTool.inputSchema.properties.format).toBeDefined();
    expect(parseDocumentTool.inputSchema.properties.format.enum).toEqual([
      'text',
      'markdown',
    ]);
    expect(parseDocumentTool.server).toBe('system');
  });
});

describe('parse_document — happy path (real parser, text-ish formats)', () => {
  test('parses plain text and reports word count', async () => {
    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64('hello world from the parse_document tool'),
        mimeType: 'text/plain',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('hello world from the parse_document tool');
    // 6 whitespace-delimited tokens (parse_document counts as one word)
    expect(body.wordCount).toBe(6);
    expect(body.pageCount).toBeUndefined();
  });

  test('parses markdown and preserves the structure', async () => {
    const md = '# Title\n\nThis is **bold** with a [link](https://x.com).';
    const result = await parseDocumentTool.handler(
      { fileBase64: toB64(md), mimeType: 'text/markdown' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toContain('# Title');
    expect(body.text).toContain('**bold**');
    expect(body.wordCount).toBeGreaterThan(0);
  });

  test("format: 'text' strips leading markdown heading markers", async () => {
    const md = '# Title\n## Subhead\nbody line';
    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64(md),
        mimeType: 'text/markdown',
        format: 'text',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // Both heading lines should be stripped of their hashes
    expect(body.text).toContain('Title');
    expect(body.text).toContain('Subhead');
    expect(body.text).toContain('body line');
    expect(body.text).not.toMatch(/^#/m);
  });

  test('parses JSON and pretty-prints valid input', async () => {
    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64('{"a":1,"b":[2,3]}'),
        mimeType: 'application/json',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    // Pretty-printed: contains newlines and indentation
    expect(body.text).toContain('"a": 1');
    expect(body.text).toContain('"b"');
  });

  test('parses CSV verbatim', async () => {
    const csv = 'name,age\nAda,36\nGrace,85';
    const result = await parseDocumentTool.handler(
      { fileBase64: toB64(csv), mimeType: 'text/csv' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toContain('name,age');
    expect(body.text).toContain('Ada');
    expect(body.text).toContain('Grace');
  });

  test('strips data: URI prefix from fileBase64', async () => {
    const dataUri = 'data:text/plain;base64,' + toB64('plain inside data uri');
    const result = await parseDocumentTool.handler(
      { fileBase64: dataUri, mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('plain inside data uri');
  });

  test('strips whitespace (newlines, spaces) from base64 input', async () => {
    const wrapped = toB64('whitespace tolerant')
      .replace(/(.{8})/g, '$1\n');
    const result = await parseDocumentTool.handler(
      { fileBase64: wrapped, mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('whitespace tolerant');
  });
});

describe('parse_document — happy path (mocked parser, paginated formats)', () => {
  let parseSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    parseSpy = null;
  });

  afterEach(() => {
    if (parseSpy) parseSpy.mockRestore();
    parseSpy = null;
  });

  test('passes through pageCount + wordCount from PDF parser', async () => {
    parseSpy = vi
      .spyOn(documentParserModule.DocumentParser, 'parse')
      .mockResolvedValue({
        content: 'Three sentences. Across two pages. Yes.',
        metadata: { format: 'pdf', pageCount: 2, wordCount: 6 },
      });

    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64('%PDF-1.4 fake'),
        mimeType: 'application/pdf',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('Three sentences. Across two pages. Yes.');
    expect(body.pageCount).toBe(2);
    expect(body.wordCount).toBe(6);

    expect(parseSpy).toHaveBeenCalledOnce();
    const callArgs = parseSpy.mock.calls[0];
    // Buffer + filename + mimeType
    expect(Buffer.isBuffer(callArgs[0])).toBe(true);
    expect(callArgs[1]).toBe('document.pdf');
    expect(callArgs[2]).toBe('application/pdf');
  });

  test('omits pageCount when the parser metadata lacks it (DOCX path)', async () => {
    parseSpy = vi
      .spyOn(documentParserModule.DocumentParser, 'parse')
      .mockResolvedValue({
        content: 'docx body content',
        metadata: { format: 'docx', wordCount: 3 },
      });

    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64('PK fake docx'),
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('docx body content');
    expect(body.wordCount).toBe(3);
    expect(body.pageCount).toBeUndefined();

    expect(parseSpy).toHaveBeenCalledOnce();
    expect(parseSpy.mock.calls[0][1]).toBe('document.docx');
  });

  test('infers a synthetic .bin filename for unknown MIME types', async () => {
    parseSpy = vi
      .spyOn(documentParserModule.DocumentParser, 'parse')
      .mockResolvedValue({
        content: '',
        metadata: { format: 'unknown' },
      });

    await parseDocumentTool.handler(
      { fileBase64: toB64('whatever'), mimeType: 'application/x-bizarre' },
      makeMockContext(),
    );
    expect(parseSpy).toHaveBeenCalledOnce();
    expect(parseSpy.mock.calls[0][1]).toBe('document.bin');
  });

  test('derives wordCount when parser metadata omits it', async () => {
    parseSpy = vi
      .spyOn(documentParserModule.DocumentParser, 'parse')
      .mockResolvedValue({
        content: 'one two three four',
        metadata: { format: 'unknown' /* no wordCount */ },
      });

    const result = await parseDocumentTool.handler(
      { fileBase64: toB64('xxx'), mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.wordCount).toBe(4);
  });
});

describe('parse_document — validation errors', () => {
  test('missing fileBase64 returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      { mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/fileBase64 is required/i);
  });

  test('empty fileBase64 returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      { fileBase64: '', mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });

  test('missing mimeType returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      { fileBase64: toB64('hi') },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/mimeType is required/i);
  });

  test('invalid format returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      {
        fileBase64: toB64('hi'),
        mimeType: 'text/plain',
        format: 'pdf-pretty',
      },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/format must be one of/i);
  });

  test('garbage base64 returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      { fileBase64: '@@@not-base64!!!', mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only base64 returns isError + VALIDATION', async () => {
    const result = await parseDocumentTool.handler(
      { fileBase64: '   \n\t  ', mimeType: 'text/plain' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('VALIDATION');
  });
});

describe('parse_document — upstream error', () => {
  let parseSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    if (parseSpy) parseSpy.mockRestore();
    parseSpy = null;
  });

  test('parser exception surfaces as isError', async () => {
    parseSpy = vi
      .spyOn(documentParserModule.DocumentParser, 'parse')
      .mockRejectedValue(new Error('pdf-parse blew up'));

    const result = await parseDocumentTool.handler(
      { fileBase64: toB64('%PDF garbage'), mimeType: 'application/pdf' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/Failed to parse document/);
    expect(body.error).toMatch(/pdf-parse blew up/);
    expect(body.mimeType).toBe('application/pdf');
  });

  test('unsupported format from underlying parser bubbles up cleanly', async () => {
    // The real parser throws on detectFormat() === 'unknown'. Trigger that
    // path with bytes whose mime is not in the supported set.
    const result = await parseDocumentTool.handler(
      { fileBase64: toB64('some bytes'), mimeType: 'application/x-not-a-thing' },
      makeMockContext(),
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/Failed to parse document/);
    expect(body.error).toMatch(/unsupported format/i);
  });
});
