/**
 * Upload To Library — Native Library Tool
 *
 * Uploads a binary file (base64-encoded) to a Knowledge Library via the
 * webapp API (`POST /api/v1/libraries/:libraryId/upload`, multipart).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), fileBase64 (required), filename (required), mimeType (required)
 *   - output: { documentId, chunks: number }
 *
 * For text-only ingestion, prefer `add_document` with `content`. This tool
 * is the dedicated path for binary files (pdf/docx/png/etc.) where the
 * webapp does the parsing + OCR + indexing.
 *
 * Functionally a focused subset of `add_document` (binary path only). Kept
 * separate so agents have a clear "I have a file" entry point that requires
 * only the four binary fields.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UploadToLibraryArgs {
  libraryId: string;
  fileBase64: string;
  filename: string;
  mimeType: string;
}

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  // Multipart fetch — do NOT set Content-Type, fetch generates the boundary.
  const headers: Record<string, string> = {};

  const authToken =
    (context?.state?.authToken as string | undefined) ||
    (context?.state?.data?.authToken as string | undefined);
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

const uploadToLibraryTool: NativeToolDefinition = {
  description:
    'Upload a binary file (base64) to a Knowledge Library. The webapp parses, chunks, and embeds the file. Use for pdf/docx/png/csv/etc. For plain text ingestion, prefer `add_document`.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id to upload into.',
      },
      fileBase64: {
        type: 'string',
        description: 'Base64-encoded file contents.',
      },
      filename: {
        type: 'string',
        description: 'Filename including extension (used for parser dispatch).',
      },
      mimeType: {
        type: 'string',
        description: 'MIME type, e.g. "application/pdf" or "image/png".',
      },
    },
    required: ['libraryId', 'fileBase64', 'filename', 'mimeType'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UploadToLibraryArgs>;
    const libraryId =
      typeof args.libraryId === 'string' ? args.libraryId.trim() : '';
    const filename = typeof args.filename === 'string' ? args.filename : '';
    const mimeType = typeof args.mimeType === 'string' ? args.mimeType : '';
    const fileBase64 =
      typeof args.fileBase64 === 'string' ? args.fileBase64 : '';

    if (!libraryId || !filename || !mimeType || !fileBase64) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'libraryId, fileBase64, filename, and mimeType are all required',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileBase64, 'base64');
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'Failed to decode fileBase64: ' +
                (err instanceof Error ? err.message : String(err)),
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/upload`;

    try {
      const formData = new FormData();
      const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
      formData.append('file', blob, filename);

      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: formData,
      });

      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Library upload API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const doc = (data?.document as AnyObject) ?? {};

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              documentId: doc.documentId ?? null,
              chunks: typeof doc.chunkCount === 'number' ? doc.chunkCount : 0,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  },
};

export default uploadToLibraryTool;
module.exports = uploadToLibraryTool;
