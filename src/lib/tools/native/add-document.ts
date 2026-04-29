/**
 * Add Document — Native Library Tool (consolidated)
 *
 * Adds a document to a Knowledge Library. Replaces the old `library_write`
 * tool — both text content and binary uploads now go through this single
 * entry point.
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), content?: string OR fileBase64?: string,
 *             filename?, metadata?, mimeType?, sourceType?, title?
 *   - output: { documentId, chunks: number }
 *
 * Routing logic:
 *   - `content` (text)  → POST /api/v1/libraries/:libraryId/documents (json)
 *   - `fileBase64`      → POST /api/v1/libraries/:libraryId/upload (multipart)
 *
 * Either `content` or `fileBase64` is required. Providing both is rejected
 * (the routes handle them differently — pick one).
 *
 * Migration note: the prior `library_write` tool's `title` and `sourceType`
 * args are still accepted and forwarded, so existing graph configs that
 * change `toolName: library_write` → `toolName: add_document` continue to
 * work without further parameter rewrites.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface AddDocumentArgs {
  libraryId: string;
  content?: string;
  fileBase64?: string;
  filename?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  sourceType?: string;
  title?: string;
}

function getBaseUrl(): string {
  return (
    process.env.WEBAPP_URL ||
    process.env.BASE_URL ||
    process.env.NEXTAUTH_URL ||
    'http://localhost:3000'
  );
}

function buildHeaders(context: NativeToolContext, contentType: string | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

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

const addDocument: NativeToolDefinition = {
  description:
    'Add a document to a Knowledge Library. Supply `content` for plain text or `fileBase64` for binary files (pdf/docx/etc). The document is chunked, embedded, and indexed for semantic search. Replaces the legacy `library_write` tool.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Target Knowledge Library id.',
      },
      content: {
        type: 'string',
        description:
          'Text content to ingest. Mutually exclusive with `fileBase64`.',
      },
      fileBase64: {
        type: 'string',
        description:
          'Base64-encoded binary file content. Mutually exclusive with `content`. Requires `filename` (and ideally `mimeType`).',
      },
      filename: {
        type: 'string',
        description:
          'Filename for the document. Required for `fileBase64`; optional for text — defaults to a slugged title.',
      },
      mimeType: {
        type: 'string',
        description:
          'MIME type. Required for `fileBase64` so the parser dispatches correctly. Default for text is "text/markdown".',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata bag attached to the document.',
        additionalProperties: true,
      },
      sourceType: {
        type: 'string',
        description:
          'Source type tag for the document. Defaults to "text" for content uploads, "file" for binary uploads.',
      },
      title: {
        type: 'string',
        description:
          'Optional title for the document. Defaults to the filename (without extension) for files, or a generated label for text.',
      },
    },
    required: ['libraryId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<AddDocumentArgs>;
    const libraryId =
      typeof args.libraryId === 'string' ? args.libraryId.trim() : '';

    if (!libraryId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'libraryId is required',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const hasContent =
      typeof args.content === 'string' && args.content.length > 0;
    const hasBase64 =
      typeof args.fileBase64 === 'string' && args.fileBase64.length > 0;

    if (!hasContent && !hasBase64) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Provide either `content` (text) or `fileBase64` (binary)',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }
    if (hasContent && hasBase64) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: '`content` and `fileBase64` are mutually exclusive',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();

    try {
      if (hasContent) {
        // ── Text path → POST /documents (json) ─────────────────────────────
        const content = args.content as string;
        const sourceType = (args.sourceType as string) || 'text';
        const filename = args.filename;
        const title =
          (args.title as string) ||
          (filename ? filename.replace(/\.[^.]+$/, '') : 'Untitled');

        const body: AnyObject = {
          title,
          content,
          sourceType,
        };
        if (filename) body.source = filename;
        if (args.mimeType) body.mimeType = args.mimeType;
        if (args.metadata) body.metadata = args.metadata;

        const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents`;
        const response = await fetch(url, {
          method: 'POST',
          headers: buildHeaders(context, 'application/json'),
          body: JSON.stringify(body),
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
                    `Library API ${response.status} ${response.statusText}` +
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
      }

      // ── Binary path → POST /upload (multipart) ────────────────────────────
      const filename = args.filename;
      if (!filename) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: '`filename` is required when using `fileBase64`',
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }

      const mimeType =
        (args.mimeType as string) || 'application/octet-stream';

      let buffer: Buffer;
      try {
        buffer = Buffer.from(args.fileBase64 as string, 'base64');
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

      const formData = new FormData();
      // Convert Node Buffer to Uint8Array so it satisfies BlobPart strict typing.
      const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
      formData.append('file', blob, filename);

      const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/upload`;
      // Multipart fetch — do NOT set Content-Type, let fetch generate the boundary.
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context, null),
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
          {
            type: 'text',
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default addDocument;
module.exports = addDocument;
