/**
 * Delete Library — Native Library Tool
 *
 * Permanently deletes a Knowledge Library and all of its documents via the
 * webapp API (`DELETE /api/v1/libraries/:libraryId?permanent=true`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required)
 *   - output: { ok: true, deletedDocuments: number }
 *
 * The webapp DELETE route supports both archive (default) and permanent
 * delete (`?permanent=true`). The spec wording — `deletedDocuments` — implies
 * a hard delete, so we always pass `permanent=true` here. To soft-archive
 * instead, callers should use `update_library` (the API uses isArchived).
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
    'Permanently delete a Knowledge Library and all of its documents. Destructive — there is no undo. Use carefully.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id to permanently delete.',
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

    // Step 2 — actually delete (permanent=true).
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}?permanent=true`;
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
                  `Library API ${response.status} ${response.statusText}` +
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
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              deletedDocuments,
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

export default deleteLibraryTool;
module.exports = deleteLibraryTool;
