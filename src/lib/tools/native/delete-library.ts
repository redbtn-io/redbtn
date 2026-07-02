/**
 * Delete Library — Native Library Tool
 *
 * ARCHIVES a Knowledge Library by default (reversible with restore_library);
 * `permanent: true` destroys it — record, Chroma collection, and stored
 * files. The webapp only permits permanent deletion of an already-archived
 * library, so the permanent path archives first, then purges.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface DeleteLibraryArgs {
  libraryId: string;
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

const deleteLibraryTool: NativeToolDefinition = {
  description:
    'Delete a Knowledge Library. By default this ARCHIVES it (hidden from listings, fully reversible with restore_library). Pass permanent: true to destroy the library, its documents, vectors, and stored files for good.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id to delete.',
      },
      permanent: {
        type: 'boolean',
        description:
          'true = permanently destroy the library and everything in it. Default false = archive (reversible).',
      },
    },
    required: ['libraryId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<DeleteLibraryArgs>;
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

    const baseUrl = getBaseUrl();

    // Step 1 — peek at the library to learn the document count BEFORE deleting,
    // so we can report `deletedDocuments` in the response. Best-effort; if the
    // GET fails for any reason we fall back to 0 and continue with the delete.
    let deletedDocuments = 0;
    try {
      const peekResp = await fetch(
        `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}`,
        { headers: buildHeaders(context) },
      );
      if (peekResp.ok) {
        const peek = (await peekResp.json()) as AnyObject;
        if (typeof peek?.documentCount === 'number') {
          deletedDocuments = peek.documentCount;
        } else if (typeof peek?.pagination?.total === 'number') {
          deletedDocuments = peek.pagination.total;
        }
      }
    } catch {
      /* ignore — fall through to the delete */
    }

    // Step 2 — archive (default) or archive-then-purge (permanent).
    const libBase = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}`;
    try {
      let response: Response;
      if (args.permanent === true) {
        // Permanent deletion requires the archived state — archive first,
        // and FAIL LOUD if that step doesn't succeed (a swallowed failure
        // here would let the DELETE be rejected or downgraded to archive
        // while we report deleted).
        const archiveResp = await fetch(`${libBase}/archive`, {
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
        response = await fetch(`${libBase}?permanent=true`, {
          method: 'DELETE',
          headers: buildHeaders(context),
        });
      } else {
        response = await fetch(`${libBase}/archive`, {
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
                  `Library API ${response.status} ${response.statusText}` +
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

      // Permanent path: verify the API actually purged (archive-first DELETE
      // reports { archived: true } when it merely archived).
      if (args.permanent === true && data?.deleted !== true) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'Permanent delete did not purge — the API archived the library instead. Retry.',
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
                ? { ok: true, deleted: true, deletedDocuments }
                : {
                    ok: true,
                    archived: true,
                    documents: deletedDocuments,
                    note: 'Archived (reversible). Use restore_library to bring it back, or permanent: true to destroy.',
                  }
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

export default deleteLibraryTool;
module.exports = deleteLibraryTool;
