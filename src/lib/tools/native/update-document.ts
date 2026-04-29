/**
 * Update Document — Native Library Tool
 *
 * Updates a document's content and/or metadata via the webapp API
 * (`PATCH /api/v1/libraries/:libraryId/documents/:documentId`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), documentId (required), content?, metadata?
 *   - output: { ok: true, reprocessed: boolean }
 *
 * If `content` is supplied the webapp drops the old vector chunks and
 * re-embeds, returning `reprocessed: true`. Metadata-only edits return
 * `reprocessed: false`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateDocumentArgs {
  libraryId: string;
  documentId: string;
  content?: string;
  metadata?: Record<string, unknown>;
  title?: string;
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

const updateDocumentTool: NativeToolDefinition = {
  description:
    'Update a document\'s content or metadata. If `content` is supplied the document is re-chunked and re-embedded; otherwise only metadata is touched.',
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
        description: 'Document id to update.',
      },
      content: {
        type: 'string',
        description:
          'New text content. Triggers a vector re-build (reprocessed: true).',
      },
      metadata: {
        type: 'object',
        description: 'Metadata to merge over the existing document metadata.',
        additionalProperties: true,
      },
      title: {
        type: 'string',
        description: 'Optional new title.',
      },
    },
    required: ['libraryId', 'documentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateDocumentArgs>;
    const libraryId =
      typeof args.libraryId === 'string' ? args.libraryId.trim() : '';
    const documentId =
      typeof args.documentId === 'string' ? args.documentId.trim() : '';

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

    const content = typeof args.content === 'string' ? args.content : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined;
    const title = typeof args.title === 'string' ? args.title : undefined;

    if (
      content === undefined &&
      metadata === undefined &&
      title === undefined
    ) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Provide at least one of: content, metadata, title',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const body: AnyObject = {};
    if (content !== undefined) body.content = content;
    if (metadata !== undefined) body.metadata = metadata;
    if (title !== undefined) body.title = title;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
        headers: buildHeaders(context),
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
                  `Library document API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json().catch(() => ({}))) as AnyObject;
      const reprocessed =
        typeof data?.reprocessed === 'boolean' ? data.reprocessed : content !== undefined;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, reprocessed }),
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

export default updateDocumentTool;
module.exports = updateDocumentTool;
