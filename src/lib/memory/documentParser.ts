/**
 * @file src/lib/memory/documentParser.ts
 * @description Document parser for extracting plain-text content from uploaded
 * files. Supports PDF, DOCX, legacy DOC, XLSX, CSV, JSON, plain text, and
 * markdown. Images are NOT handled here — vision/OCR is a separate pipeline.
 *
 * Used by the webapp's /api/v1/libraries/:id/upload route (and downstream
 * processing route) to turn a Buffer of bytes into a string of text that can
 * be chunked and embedded via VectorStoreManager.
 *
 * Design notes:
 * - All dependencies are optional / lazy-required inside each branch so a
 *   missing native module (e.g. a peer that only works on certain platforms)
 *   only breaks the one format, not the whole parser.
 * - The static `DocumentParser.parse()` entry point matches the legacy shape
 *   the webapp was originally written against:
 *     `DocumentParser.parse(buffer, filename, mimeType) => { content, metadata }`
 */

export interface ParsedDocument {
  /** Extracted plain-text content, ready to be chunked for embeddings. */
  content: string;
  /**
   * Best-effort metadata about the source document. Shape is intentionally
   * loose — callers should treat every field as optional.
   */
  metadata: {
    title?: string;
    author?: string;
    pageCount?: number;
    wordCount?: number;
    mimeType?: string;
    /** Format family detected by the parser. */
    format?: 'pdf' | 'docx' | 'doc' | 'xlsx' | 'csv' | 'json' | 'text' | 'markdown' | 'unknown';
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.text']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);

function getExtension(filename: string): string {
  const match = filename.toLowerCase().match(/\.[^./\\]+$/);
  return match ? match[0] : '';
}

type Format = NonNullable<ParsedDocument['metadata']['format']>;

function detectFormat(filename: string, mimeType: string): Format {
  const ext = getExtension(filename);
  const mt = (mimeType || '').toLowerCase();

  if (mt === 'application/pdf' || ext === '.pdf') return 'pdf';

  if (
    mt === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    return 'docx';
  }

  if (mt === 'application/msword' || ext === '.doc') return 'doc';

  if (
    mt === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mt === 'application/vnd.ms-excel' ||
    ext === '.xlsx' ||
    ext === '.xls'
  ) {
    return 'xlsx';
  }

  if (mt === 'text/csv' || ext === '.csv') return 'csv';

  if (mt === 'application/json' || ext === '.json') return 'json';

  if (MARKDOWN_EXTENSIONS.has(ext) || mt === 'text/markdown') return 'markdown';

  if (TEXT_EXTENSIONS.has(ext) || mt.startsWith('text/')) return 'text';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Per-format parsers
// ---------------------------------------------------------------------------

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  // pdf-parse is CJS with a slightly quirky entry point (it tries to run a
  // self-test on require when loaded from index.js in a test harness). Hitting
  // the inner module avoids that.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const result = await pdfParse(buffer);
  const info = (result?.info ?? {}) as Record<string, unknown>;
  const title = typeof info.Title === 'string' ? info.Title.trim() || undefined : undefined;
  const author = typeof info.Author === 'string' ? info.Author.trim() || undefined : undefined;
  return {
    content: String(result?.text ?? ''),
    metadata: {
      format: 'pdf',
      pageCount: typeof result?.numpages === 'number' ? result.numpages : undefined,
      title,
      author,
    },
  };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return {
    content: String(result?.value ?? ''),
    metadata: { format: 'docx' },
  };
}

async function parseDoc(buffer: Buffer): Promise<ParsedDocument> {
  // word-extractor works off a temp file on disk. We pipe the buffer through
  // os.tmpdir so we don't assume a writable cwd.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const WordExtractor = require('word-extractor');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  const tempPath = path.join(
    os.tmpdir(),
    `docparser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.doc`,
  );
  try {
    fs.writeFileSync(tempPath, buffer);
    const extractor = new WordExtractor();
    const doc = await extractor.extract(tempPath);
    return {
      content: String(doc?.getBody?.() ?? ''),
      metadata: { format: 'doc' },
    };
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
  }
}

async function parseXlsx(buffer: Buffer): Promise<ParsedDocument> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sheetNames: string[] = workbook?.SheetNames ?? [];
  const parts: string[] = [];
  for (const name of sheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv: string = XLSX.utils.sheet_to_csv(sheet);
    if (csv && csv.trim().length > 0) {
      parts.push(`# ${name}\n${csv}`);
    }
  }
  return {
    content: parts.join('\n\n'),
    metadata: { format: 'xlsx', sheetCount: sheetNames.length },
  };
}

function parseCsv(buffer: Buffer): ParsedDocument {
  // CSV is already human-readable text — just normalize encoding.
  return {
    content: buffer.toString('utf8'),
    metadata: { format: 'csv' },
  };
}

function parseJson(buffer: Buffer): ParsedDocument {
  const raw = buffer.toString('utf8');
  // Pretty-print if valid so embeddings see human-readable structure. Fall
  // back to the raw string if parsing fails.
  try {
    const parsed = JSON.parse(raw);
    return {
      content: JSON.stringify(parsed, null, 2),
      metadata: { format: 'json' },
    };
  } catch {
    return {
      content: raw,
      metadata: { format: 'json' },
    };
  }
}

function parseText(buffer: Buffer, format: 'text' | 'markdown'): ParsedDocument {
  return {
    content: buffer.toString('utf8'),
    metadata: { format },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * DocumentParser — extract plain-text content from an uploaded file.
 *
 * Usage:
 *   const { content, metadata } = await DocumentParser.parse(buffer, name, mimeType);
 */
export class DocumentParser {
  /**
   * Parse a buffer of file bytes into plain text plus light metadata.
   *
   * @param buffer   The raw file contents.
   * @param filename The original filename — used as a fallback when MIME type
   *                 is ambiguous or missing.
   * @param mimeType The reported MIME type. Optional; we fall back to the
   *                 extension if blank.
   * @throws If the file format is not supported or a parser library fails.
   */
  static async parse(
    buffer: Buffer,
    filename: string,
    mimeType: string = '',
  ): Promise<ParsedDocument> {
    if (!buffer || buffer.length === 0) {
      throw new Error('DocumentParser.parse: empty or missing buffer');
    }

    const format = detectFormat(filename || '', mimeType || '');
    let parsed: ParsedDocument;

    switch (format) {
      case 'pdf':
        parsed = await parsePdf(buffer);
        break;
      case 'docx':
        parsed = await parseDocx(buffer);
        break;
      case 'doc':
        parsed = await parseDoc(buffer);
        break;
      case 'xlsx':
        parsed = await parseXlsx(buffer);
        break;
      case 'csv':
        parsed = parseCsv(buffer);
        break;
      case 'json':
        parsed = parseJson(buffer);
        break;
      case 'markdown':
        parsed = parseText(buffer, 'markdown');
        break;
      case 'text':
        parsed = parseText(buffer, 'text');
        break;
      default:
        throw new Error(
          `DocumentParser.parse: unsupported format (filename="${filename}", mimeType="${mimeType}")`,
        );
    }

    // Normalize whitespace — strip windows line endings and trim excessive
    // blank-line runs so chunk boundaries behave.
    const normalized = parsed.content
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Derive a title if the underlying parser didn't supply one. Use the
    // filename sans extension.
    const fallbackTitle = filename.replace(/\.[^.]+$/, '') || undefined;
    const title = parsed.metadata.title || fallbackTitle;

    const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0;

    return {
      content: normalized,
      metadata: {
        ...parsed.metadata,
        title,
        mimeType: mimeType || undefined,
        wordCount,
      },
    };
  }

  /** Returns true if the given filename/mime combination is supported. */
  static canParse(filename: string, mimeType: string = ''): boolean {
    return detectFormat(filename || '', mimeType || '') !== 'unknown';
  }

  /** Exposed for external callers that want to know which branch we'd take. */
  static detectFormat(filename: string, mimeType: string = ''): Format {
    return detectFormat(filename || '', mimeType || '');
  }
}
