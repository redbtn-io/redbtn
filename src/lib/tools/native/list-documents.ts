/**
 * List Documents — Native Library Tool
 *
 * Lists documents in a Knowledge Library, paginated.
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), limit?, offset?
 *   - output: { documents: [{ id, filename, chunks, createdAt }], total }
 *
 * The webapp library detail route paginates by `page` (1-based) + `limit`,
 * not `offset` directly. We translate `offset` → `page` here so callers can
 * use either model. If both are supplied, `offset` wins.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListDocumentsArgs {
  libraryId: string;
  limit?: number;
  offset?: number;
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

const listDocumentsTool: NativeToolDefinition = {
  description:
    'List documents in a Knowledge Library, paginated. Returns id/filename/chunks/createdAt for each. Use to enumerate documents before reading or operating on them.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id whose documents to list.',
      },
      limit: {
        type: 'integer',
        description: 'Max documents per page (default 50, max 200).',
        minimum: 1,
        maximum: 200,
      },
      offset: {
        type: 'integer',
        description: 'Pagination offset (default 0). Translated server-side into a page index.',
        minimum: 0,
      },
    },
    required: ['libraryId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListDocumentsArgs>;
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

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(200, Math.max(1, Math.floor(Number(args.limit))))
        : 50;
    const offset =
      args.offset !== undefined && Number.isFinite(Number(args.offset))
        ? Math.max(0, Math.floor(Number(args.offset)))
        : 0;
    const page = Math.floor(offset / limit) + 1;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}?page=${page}&limit=${limit}`;

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
      const rawDocs = Array.isArray(data?.documents) ? (data.documents as AnyObject[]) : [];
      const documents = rawDocs.map((d) => ({
        id: typeof d?.documentId === 'string' ? d.documentId : (d?.id ?? null),
        filename:
          typeof d?.source === 'string'
            ? d.source
            : typeof d?.title === 'string'
            ? d.title
            : null,
        chunks: typeof d?.chunkCount === 'number' ? d.chunkCount : 0,
        createdAt: d?.addedAt ?? d?.createdAt ?? null,
      }));

      const total =
        typeof data?.pagination?.total === 'number'
          ? data.pagination.total
          : typeof data?.documentCount === 'number'
          ? data.documentCount
          : documents.length;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ documents, total }),
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

export default listDocumentsTool;
module.exports = listDocumentsTool;
