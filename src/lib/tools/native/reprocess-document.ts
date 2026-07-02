/**
 * Reprocess Document — Native Library Tool
 *
 * Re-runs OCR / parsing / re-embedding for an existing document via the
 * webapp API (`POST /api/v1/libraries/:libraryId/documents/:documentId/process`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), documentId (required)
 *   - output: { ok: true, chunks: number }
 *
 * The webapp /process route currently focuses on image OCR (and is gated
 * behind a 503 if the OCR pipeline isn't wired). It returns information
 * about the new chunk count when it succeeds; we surface that here.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { waitForDocumentProcessing, WAIT_SCHEMA_PROPERTIES } from './library-wait';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ReprocessDocumentArgs {
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

const reprocessDocumentTool: NativeToolDefinition = {
  description:
    'Reprocess a document — re-run parsing/OCR and re-embed its chunks. Useful after the source file changed or when an earlier process failed.',
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
        description: 'Document id to reprocess.',
      },
      ...WAIT_SCHEMA_PROPERTIES,
    },
    required: ['libraryId', 'documentId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ReprocessDocumentArgs>;
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
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/documents/${encodeURIComponent(documentId)}/process`;

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
                  `Library reprocess API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json().catch(() => ({}))) as AnyObject;

      // Async ingestion (202): the reprocess is queued on the background
      // worker. Poll to completion unless the caller opted out.
      if (data?.processingStatus === 'pending' && data?.jobId) {
        if (args.wait === false) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ok: true,
                  processingStatus: 'pending',
                  jobId: data.jobId,
                  note: 'Reprocess runs in the background; poll status until processingStatus is completed.',
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
                  error: final.processingError || 'Document reprocessing failed',
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
                ok: final.processingStatus === 'completed',
                chunks: final.chunkCount ?? 0,
                processingStatus: final.processingStatus,
                ...(final.timedOut ? { timedOut: true } : {}),
              }),
            },
          ],
        };
      }

      const chunks =
        typeof data?.chunkCount === 'number'
          ? data.chunkCount
          : typeof data?.chunks === 'number'
          ? data.chunks
          : 0;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, chunks }),
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

export default reprocessDocumentTool;
module.exports = reprocessDocumentTool;
