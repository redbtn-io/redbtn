/**
 * Parse Document — Native Files Tool
 *
 * Decodes a base64-encoded document and extracts its readable text using the
 * shared `DocumentParser` (`redbtn/src/lib/memory/documentParser.ts`). This is
 * the same parser the webapp's library upload route uses, so anything that's
 * legal as a knowledge-library document is legal here.
 *
 * Spec: TOOL-HANDOFF.md §4.14
 *   - inputs:  fileBase64 (required), mimeType (required), format? ('text' | 'markdown', default 'markdown')
 *   - output:  { text, pageCount?, wordCount }
 *
 * Format selection:
 *   - For PDFs and DOCX/DOC files the parser already returns plain text (no
 *     markdown structure is reconstructed), so 'text' and 'markdown' return
 *     the same content for those formats.
 *   - For XLSX, the parser produces a markdown-ish "# SheetName\n<csv>"
 *     layout. When `format: 'text'` is requested we strip the leading
 *     markdown heading marker so callers asking for plain text don't see
 *     stray '#' characters.
 *   - For text/markdown/csv/json sources the parser returns the original
 *     content verbatim — `format` is informational only.
 *
 * Use this when an agent has the bytes of a document (e.g. fresh from
 * `download_file`, `upload_attachment`, or a base64 input field) and needs
 * the readable text content for summarisation, RAG, or downstream prompting.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { DocumentParser } from '../../memory/documentParser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ParseDocumentArgs {
  fileBase64?: string;
  mimeType?: string;
  format?: 'text' | 'markdown';
}

const VALID_FORMATS = new Set<'text' | 'markdown'>(['text', 'markdown']);

// Best-effort filename inference from MIME type. Used only to give the
// underlying parser a hint about the expected extension since DocumentParser
// uses both filename and mime to detect the format.
const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-excel': 'xlsx',
  'text/csv': 'csv',
  'application/json': 'json',
  'text/markdown': 'md',
  'text/plain': 'txt',
};

function syntheticFilenameFor(mimeType: string): string {
  const cleaned = (mimeType || '').toLowerCase().split(';')[0]?.trim() || '';
  const ext = MIME_TO_EXT[cleaned];
  return ext ? `document.${ext}` : 'document.bin';
}

/**
 * Decode base64 robustly. Strips data: URI prefix and whitespace, both common
 * artefacts when base64 is pasted from clipboards or sourced from data: URLs.
 */
function decodeBase64(raw: string): { ok: true; buffer: Buffer } | { ok: false; error: string } {
  let cleaned = raw;
  // Strip data:<mime>;base64, prefix if present
  const dataUriMatch = cleaned.match(/^data:[^;,]+(?:;[^,]+)?,(.+)$/);
  if (dataUriMatch) {
    cleaned = dataUriMatch[1];
  }
  // Remove all whitespace (newlines from PEM-style wrapping, spaces, etc.)
  cleaned = cleaned.replace(/\s+/g, '');

  if (!cleaned) {
    return { ok: false, error: 'fileBase64 is empty after stripping whitespace' };
  }

  try {
    const buffer = Buffer.from(cleaned, 'base64');
    // Buffer.from is permissive — re-encode to detect garbage. If round-trip
    // doesn't match (modulo padding), we received non-base64 input.
    const reencoded = buffer.toString('base64').replace(/=+$/, '');
    const expected = cleaned.replace(/=+$/, '');
    if (reencoded !== expected) {
      return { ok: false, error: 'fileBase64 is not valid base64' };
    }
    if (buffer.length === 0) {
      return { ok: false, error: 'fileBase64 decoded to zero bytes' };
    }
    return { ok: true, buffer };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to decode base64: ${message}` };
  }
}

const parseDocumentTool: NativeToolDefinition = {
  description:
    'Parse a base64-encoded document (PDF, DOCX, DOC, XLSX, CSV, JSON, TXT, MD) and extract its readable text content using the shared DocumentParser. ' +
    'Returns the extracted text plus a word count and (for paginated formats) a page count. ' +
    'Use after download_file or upload_attachment to turn raw bytes into text an LLM can read.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: {
      fileBase64: {
        type: 'string',
        description:
          'Base64-encoded file content. May include a data: URI prefix or whitespace; both are stripped.',
      },
      mimeType: {
        type: 'string',
        description:
          'MIME type of the file (e.g. application/pdf, text/markdown). Drives format detection.',
      },
      format: {
        type: 'string',
        enum: ['text', 'markdown'],
        description:
          "Output format. 'markdown' (default) preserves the parser's layout (e.g. XLSX sheet headings); 'text' strips markdown heading markers so the result is plain text.",
      },
    },
    required: ['fileBase64', 'mimeType'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    void _context;
    const args = rawArgs as Partial<ParseDocumentArgs>;
    const fileBase64 = typeof args.fileBase64 === 'string' ? args.fileBase64 : '';
    const mimeType =
      typeof args.mimeType === 'string' ? args.mimeType.trim() : '';
    const format: 'text' | 'markdown' =
      typeof args.format === 'string' && VALID_FORMATS.has(args.format)
        ? (args.format as 'text' | 'markdown')
        : 'markdown';

    // ── Validation ──────────────────────────────────────────────────────────
    if (!fileBase64) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'fileBase64 is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (!mimeType) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'mimeType is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (
      typeof args.format === 'string' &&
      !VALID_FORMATS.has(args.format as 'text' | 'markdown')
    ) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `format must be one of: text, markdown (got '${args.format}')`,
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    // ── Decode ──────────────────────────────────────────────────────────────
    const decoded = decodeBase64(fileBase64);
    if (!decoded.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: decoded.error, code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    // ── Parse ───────────────────────────────────────────────────────────────
    const filename = syntheticFilenameFor(mimeType);

    let parsed;
    try {
      parsed = await DocumentParser.parse(decoded.buffer, filename, mimeType);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to parse document: ${message}`,
              mimeType,
            }),
          },
        ],
        isError: true,
      };
    }

    // For 'text' format, strip the leading markdown heading marker the
    // XLSX parser uses for sheet names. PDF/DOCX/DOC paths return plain
    // text already so the substitution is a no-op there.
    let outputText = parsed.content || '';
    if (format === 'text') {
      outputText = outputText
        .split('\n')
        .map((line) => line.replace(/^#{1,6}\s+/, ''))
        .join('\n');
    }

    const result: { text: string; pageCount?: number; wordCount: number } = {
      text: outputText,
      wordCount:
        typeof parsed.metadata?.wordCount === 'number'
          ? parsed.metadata.wordCount
          : outputText
              ? outputText.split(/\s+/).filter(Boolean).length
              : 0,
    };
    if (typeof parsed.metadata?.pageCount === 'number') {
      result.pageCount = parsed.metadata.pageCount;
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
    };
  },
};

export default parseDocumentTool;
module.exports = parseDocumentTool;
