/**
 * Unit tests for DocumentParser.
 *
 * Exercises each format branch using tiny in-memory buffers so the test
 * doesn't depend on fixture files being present on disk.
 */

import { describe, test, expect } from 'vitest';
import { DocumentParser } from '../src/lib/memory/documentParser';

describe('DocumentParser', () => {
  describe('format detection', () => {
    test('detects by MIME type', () => {
      expect(DocumentParser.detectFormat('file.xyz', 'application/pdf')).toBe('pdf');
      expect(DocumentParser.detectFormat('file.xyz', 'application/json')).toBe('json');
      expect(DocumentParser.detectFormat('file.xyz', 'text/csv')).toBe('csv');
      expect(DocumentParser.detectFormat('file.xyz', 'text/markdown')).toBe('markdown');
      expect(
        DocumentParser.detectFormat(
          'file.xyz',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ),
      ).toBe('docx');
    });

    test('detects by extension when MIME is blank', () => {
      expect(DocumentParser.detectFormat('report.pdf', '')).toBe('pdf');
      expect(DocumentParser.detectFormat('notes.md', '')).toBe('markdown');
      expect(DocumentParser.detectFormat('data.csv', '')).toBe('csv');
      expect(DocumentParser.detectFormat('config.json', '')).toBe('json');
      expect(DocumentParser.detectFormat('plain.txt', '')).toBe('text');
      expect(DocumentParser.detectFormat('sheet.xlsx', '')).toBe('xlsx');
      expect(DocumentParser.detectFormat('doc.docx', '')).toBe('docx');
      expect(DocumentParser.detectFormat('doc.doc', '')).toBe('doc');
    });

    test('returns unknown for unsupported formats', () => {
      expect(DocumentParser.detectFormat('image.png', 'image/png')).toBe('unknown');
      expect(DocumentParser.detectFormat('video.mp4', 'video/mp4')).toBe('unknown');
      expect(DocumentParser.detectFormat('arch.zip', 'application/zip')).toBe('unknown');
    });

    test('canParse mirrors detectFormat', () => {
      expect(DocumentParser.canParse('file.pdf')).toBe(true);
      expect(DocumentParser.canParse('file.png', 'image/png')).toBe(false);
    });
  });

  describe('parse', () => {
    test('parses plain text', async () => {
      const buf = Buffer.from('Hello world.\n\nA second paragraph.\n');
      const result = await DocumentParser.parse(buf, 'hello.txt', 'text/plain');
      expect(result.content).toContain('Hello world');
      expect(result.content).toContain('A second paragraph');
      expect(result.metadata.format).toBe('text');
      expect(result.metadata.title).toBe('hello');
      expect(result.metadata.wordCount).toBeGreaterThan(0);
    });

    test('parses markdown', async () => {
      const buf = Buffer.from('# Title\n\nSome **bold** text.\n');
      const result = await DocumentParser.parse(buf, 'notes.md', 'text/markdown');
      expect(result.content).toContain('# Title');
      expect(result.metadata.format).toBe('markdown');
      expect(result.metadata.title).toBe('notes');
    });

    test('parses JSON and pretty-prints valid JSON', async () => {
      const buf = Buffer.from('{"a":1,"b":[1,2,3]}');
      const result = await DocumentParser.parse(buf, 'data.json', 'application/json');
      // Pretty-printed output contains a newline.
      expect(result.content).toContain('\n');
      expect(result.content).toContain('"a"');
      expect(result.metadata.format).toBe('json');
    });

    test('parses invalid JSON as raw text (does not throw)', async () => {
      const buf = Buffer.from('{ this is not valid json');
      const result = await DocumentParser.parse(buf, 'data.json', 'application/json');
      expect(result.content).toContain('not valid json');
      expect(result.metadata.format).toBe('json');
    });

    test('parses CSV as UTF-8 text', async () => {
      const buf = Buffer.from('a,b,c\n1,2,3\n4,5,6\n');
      const result = await DocumentParser.parse(buf, 'table.csv', 'text/csv');
      expect(result.content).toContain('a,b,c');
      expect(result.metadata.format).toBe('csv');
    });

    test('normalizes Windows line endings', async () => {
      const buf = Buffer.from('line one\r\nline two\r\nline three\r\n');
      const result = await DocumentParser.parse(buf, 'mixed.txt', 'text/plain');
      expect(result.content).not.toContain('\r');
      expect(result.content).toContain('line one\nline two');
    });

    test('falls back to filename when no title is embedded', async () => {
      const buf = Buffer.from('content');
      const result = await DocumentParser.parse(buf, 'my-report.txt', 'text/plain');
      expect(result.metadata.title).toBe('my-report');
    });

    test('rejects unsupported formats', async () => {
      const buf = Buffer.from('binary');
      await expect(
        DocumentParser.parse(buf, 'image.png', 'image/png'),
      ).rejects.toThrow(/unsupported format/);
    });

    test('rejects empty buffers', async () => {
      await expect(
        DocumentParser.parse(Buffer.alloc(0), 'empty.txt', 'text/plain'),
      ).rejects.toThrow(/empty/);
    });
  });
});
