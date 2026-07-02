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
  permanent?: boolean;
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
    'Delete a document from a Knowledge Library. By default this ARCHIVES it (vectors removed from search, raw source retained — reversible with restore_document). Pass permanent: true to destroy it for good.',
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
      permanent: {
        type: 'boolean',
        description:
          'true = permanently destroy the document (record, vectors, stored source). Default false = archive (reversible).',
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
    const docBase = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}`;

    try {
      let response: Response;
      if (args.permanent === true) {
        // The webapp's DELETE is archive-first (a live doc gets archived,
        // an archived doc gets purged), so permanent = archive, then DELETE.
        // The archive step MUST succeed — silently proceeding would let the
        // DELETE merely archive a still-live doc while we report deleted.
        const archiveResp = await fetch(`${docBase}/archive`, {
          method: 'POST',
          headers: buildHeaders(context),
        });
        if (!archiveResp.ok) {
          const errBody = await archiveResp.text().catch(() => '');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error:
                    `Archive step before permanent delete failed: ${archiveResp.status} ${archiveResp.statusText}` +
                    (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                  status: archiveResp.status,
                }),
              },
            ],
            isError: true,
          };
        }
        response = await fetch(docBase, { method: 'DELETE', headers: buildHeaders(context) });
      } else {
        response = await fetch(`${docBase}/archive`, {
          method: 'POST',
          headers: buildHeaders(context),
        });
      }

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

      let data: AnyObject = {};
      try {
        data = (await response.json()) as AnyObject;
      } catch {
        /* ignore */
      }

      // Permanent path: the webapp DELETE is archive-first, so verify it
      // actually purged rather than archived — anything else is a failure
      // we must not report as deletion.
      if (args.permanent === true && data?.deleted === false) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Permanent delete did not purge — the API archived the document instead. Retry.',
                archived: data?.archived === true,
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              args.permanent === true
                ? { ok: true, deleted: true }
                : { ok: true, archived: true, note: 'Archived (reversible). Use restore_document to bring it back, or permanent: true to destroy.' }
            ),
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

export default deleteDocumentTool;
module.exports = deleteDocumentTool;
