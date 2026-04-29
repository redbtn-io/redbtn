/**
 * Get Document — Native Library Tool
 *
 * Fetches a single document from a Knowledge Library in one of three shapes:
 *
 *   - format: 'metadata' (default) — bare metadata, no body. Hits
 *     GET /api/v1/libraries/:libraryId/documents/:documentId
 *   - format: 'full'                — fully reconstructed text content. Hits
 *     GET /api/v1/libraries/:libraryId/documents/:documentId/full
 *   - format: 'chunks'              — list of vector-store chunks (with
 *     metadata + chunk index). Hits
 *     GET /api/v1/libraries/:libraryId/documents/:documentId/chunks
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), documentId (required), format?
 *   - output: full / chunks / metadata
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetDocumentArgs {
  libraryId: string;
  documentId: string;
  format?: 'full' | 'chunks' | 'metadata';
}

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

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

const getDocumentTool: NativeToolDefinition = {
  description:
    'Fetch a document from a Knowledge Library. Pick `format`: "metadata" (default, no body), "full" (reconstructed text), or "chunks" (list of vector chunks).',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id the document belongs to.',
      },
      documentId: {
        type: 'string',
        description: 'Document id to fetch.',
      },
      format: {
        type: 'string',
        enum: ['full', 'chunks', 'metadata'],
        description:
          'Response shape. "metadata" (default) returns just the doc record; "full" returns reconstructed text; "chunks" returns the underlying vector chunks.',
      },
    },
    required: ['libraryId', 'documentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetDocumentArgs>;
    const libraryId =
      typeof args.libraryId === 'string' ? args.libraryId.trim() : '';
    const documentId =
      typeof args.documentId === 'string' ? args.documentId.trim() : '';
    const format =
      args.format === 'full' || args.format === 'chunks' || args.format === 'metadata'
        ? args.format
        : 'metadata';

    if (!libraryId || !documentId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'libraryId and documentId are required',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const root = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`;

    let url: string;
    if (format === 'full') url = `${root}/full`;
    else if (format === 'chunks') url = `${root}/chunks`;
    else url = root;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

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
                  `Library document API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      // Echo the API response verbatim for callers — the shape varies by
      // format. The spec says "full / chunks / metadata" without prescribing
      // a unified envelope, so the most truthful thing is to forward.
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
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

export default getDocumentTool;
module.exports = getDocumentTool;
