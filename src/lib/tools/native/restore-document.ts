/**
 * Restore Document — Native Library Tool
 *
 * Restores an archived document via the webapp API
 * (`POST /api/v1/libraries/:libraryId/documents/:documentId/restore`).
 * The document re-embeds from its stored source through the
 * document-processing queue; by default the tool waits for embedding to
 * complete (same wait semantics as add_document).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { waitForDocumentProcessing, WAIT_SCHEMA_PROPERTIES } from './library-wait';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface RestoreDocumentArgs {
  libraryId: string;
  documentId: string;
  wait?: boolean;
  waitTimeoutMs?: number;
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

const restoreDocumentTool: NativeToolDefinition = {
  description:
    'Restore an archived Knowledge Library document. Re-embeds it from the stored source; the document becomes searchable again when processing completes (waited on by default).',
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
        description: 'Archived document id to restore.',
      },
      ...WAIT_SCHEMA_PROPERTIES,
    },
    required: ['libraryId', 'documentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RestoreDocumentArgs>;
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
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}/restore`;

    try {
      const response = await fetch(url, {
        method: 'POST',
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
                  `Library restore API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json().catch(() => ({}))) as AnyObject;

      if (args.wait === false) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ok: true,
                restored: true,
                processingStatus: 'pending',
                jobId: data.jobId,
                note: 'Re-embed runs in the background; poll reprocess status until processingStatus is completed.',
              }),
            },
          ],
        };
      }

      const final = await waitForDocumentProcessing(
        baseUrl,
        libraryId,
        documentId,
        buildHeaders(context),
        typeof args.waitTimeoutMs === 'number' ? args.waitTimeoutMs : undefined
      );
      if (final.processingStatus === 'failed') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: final.processingError || 'Restore re-embed failed',
                processingStatus: 'failed',
                jobId: final.jobId ?? data.jobId,
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
            text: JSON.stringify({
              ok: true,
              restored: final.processingStatus === 'completed',
              processingStatus: final.processingStatus,
              chunks: final.chunkCount ?? 0,
              ...(final.timedOut ? { timedOut: true } : {}),
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

export default restoreDocumentTool;
module.exports = restoreDocumentTool;
