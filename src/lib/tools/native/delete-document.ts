/**
 * Delete Document — Native Library Tool
 *
 * Removes a document from a Knowledge Library (and its vectors) via the
 * webapp API (`DELETE /api/v1/libraries/:libraryId/documents/:documentId`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), documentId (required)
 *   - output: { ok: true }
 *
 * The webapp also supports the legacy form
 *   `DELETE /api/v1/libraries/:libraryId/documents?documentId=…`
 * — we use the REST-shaped per-id route added alongside this pack so the
 * action surface is consistent.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteDocumentArgs {
  libraryId: string;
  documentId: string;
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

const deleteDocumentTool: NativeToolDefinition = {
  description:
    'Delete a single document from a Knowledge Library. Removes both the document record and its vector chunks. Destructive — there is no undo.',
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
        description: 'Document id to delete.',
      },
    },
    required: ['libraryId', 'documentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteDocumentArgs>;
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

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`;

    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: buildHeaders(context),
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

      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
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

export default deleteDocumentTool;
module.exports = deleteDocumentTool;
