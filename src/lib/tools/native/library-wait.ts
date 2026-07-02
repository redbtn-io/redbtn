/**
 * Shared wait-for-embedding helper for the library ingestion tools.
 *
 * With async ingestion enabled webapp-side (ASYNC_INGESTION=1), the
 * ingestion routes return 202 with `processingStatus: 'pending'` and a
 * background worker chunks+embeds. Graph authors mostly expect the legacy
 * synchronous semantics ("the tool returns when the doc is searchable"), so
 * the tools poll the status endpoint to completion by default (`wait: true`)
 * — tool calls run inside graph executions where there is no edge-proxy
 * timeout, and each poll is a cheap GET.
 *
 * Pass `wait: false` for fire-and-forget bulk pipelines; the tool then
 * returns `{ documentId, processingStatus: 'pending', jobId }` immediately.
 */

/** Default end-to-end wait budget (10 min) and poll interval. */
const DEFAULT_WAIT_TIMEOUT_MS = 600_000;
const POLL_INTERVAL_MS = 2_000;

export interface DocumentProcessingStatus {
  processingStatus: 'pending' | 'processing' | 'completed' | 'failed';
  processingError?: string;
  processingProgress?: number;
  jobId?: string;
  chunkCount?: number;
  charCount?: number;
  /** True when the wait budget expired before a terminal state */
  timedOut?: boolean;
}

/** Does this ingestion response indicate deferred (async) processing? */
export function isDeferredIngestion(doc: Record<string, unknown> | undefined | null): boolean {
  const status = doc?.processingStatus;
  return status === 'pending' || status === 'processing';
}

/**
 * Poll GET /api/v1/libraries/:libraryId/documents/:documentId/process until
 * the document reaches a terminal processingStatus or the budget expires.
 */
export async function waitForDocumentProcessing(
  baseUrl: string,
  libraryId: string,
  documentId: string,
  headers: Record<string, string>,
  timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS
): Promise<DocumentProcessingStatus> {
  const url =
    `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}` +
    `/documents/${encodeURIComponent(documentId)}/process`;
  const deadline = Date.now() + Math.max(timeoutMs, POLL_INTERVAL_MS);
  let last: DocumentProcessingStatus = { processingStatus: 'pending' };

  // Permanent HTTP statuses end the poll immediately: the doc was deleted
  // (404) or the credentials are bad (401/403) — waiting cannot fix either,
  // and stalling a graph run for the full budget on them is pure waste.
  const PERMANENT_STATUSES = new Set([401, 403, 404]);
  let consecutivePermanent = 0;

  for (;;) {
    try {
      const response = await fetch(url, { method: 'GET', headers });
      if (response.ok) {
        consecutivePermanent = 0;
        const data = (await response.json()) as Record<string, unknown>;
        last = {
          processingStatus:
            (data.processingStatus as DocumentProcessingStatus['processingStatus']) ?? 'pending',
          processingError: data.processingError as string | undefined,
          processingProgress: data.processingProgress as number | undefined,
          jobId: data.jobId as string | undefined,
          chunkCount: data.chunkCount as number | undefined,
          charCount: data.charCount as number | undefined,
        };
        if (last.processingStatus === 'completed' || last.processingStatus === 'failed') {
          return last;
        }
      } else if (PERMANENT_STATUSES.has(response.status)) {
        // Two in a row guards against a single poll racing a routing blip.
        consecutivePermanent += 1;
        if (consecutivePermanent >= 2) {
          return {
            ...last,
            processingStatus: 'failed',
            processingError: `status poll returned ${response.status} — document gone or access revoked`,
          };
        }
      } else {
        consecutivePermanent = 0;
        // Other non-OK responses (5xx, 429) are transient — keep polling.
      }
    } catch {
      // Network hiccup — keep polling.
    }
    if (Date.now() + POLL_INTERVAL_MS > deadline) {
      return { ...last, timedOut: true };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/**
 * Resolve an ingestion response into the tool's result payload, honoring
 * `wait` (default true). Legacy synchronous responses (already terminal)
 * pass straight through; deferred responses poll to completion.
 */
export async function resolveIngestionOutcome(
  doc: Record<string, unknown>,
  args: { wait?: boolean; waitTimeoutMs?: number },
  baseUrl: string,
  libraryId: string,
  headers: Record<string, string>
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  const documentId = (doc.documentId as string | undefined) ?? null;
  const base: Record<string, unknown> = {
    documentId,
    chunks: typeof doc.chunkCount === 'number' ? doc.chunkCount : 0,
  };

  if (!isDeferredIngestion(doc) || !documentId) {
    return { payload: base, isError: false };
  }

  if (args.wait === false) {
    return {
      payload: {
        ...base,
        processingStatus: doc.processingStatus,
        jobId: doc.jobId,
        note: 'Embedding runs in the background; poll get_document or reprocess status until processingStatus is completed.',
      },
      isError: false,
    };
  }

  const final = await waitForDocumentProcessing(
    baseUrl,
    libraryId,
    documentId,
    headers,
    typeof args.waitTimeoutMs === 'number' ? args.waitTimeoutMs : undefined
  );

  if (final.processingStatus === 'completed') {
    return {
      payload: {
        documentId,
        chunks: final.chunkCount ?? 0,
        processingStatus: 'completed',
      },
      isError: false,
    };
  }
  if (final.processingStatus === 'failed') {
    return {
      payload: {
        documentId,
        error: final.processingError || 'Document processing failed',
        processingStatus: 'failed',
        jobId: final.jobId ?? doc.jobId,
      },
      isError: true,
    };
  }
  // Timed out while still pending/processing — surface state, not an error.
  return {
    payload: {
      documentId,
      chunks: final.chunkCount ?? 0,
      processingStatus: final.processingStatus,
      processingProgress: final.processingProgress,
      jobId: final.jobId ?? doc.jobId,
      timedOut: true,
      note: 'Wait budget expired; embedding continues in the background.',
    },
    isError: false,
  };
}

/** Schema fragments the ingestion tools splice into their inputSchema. */
export const WAIT_SCHEMA_PROPERTIES = {
  wait: {
    type: 'boolean',
    description:
      'Wait for chunking + embedding to complete before returning (default true). Set false to return immediately with { processingStatus: "pending", jobId } and poll later.',
  },
  waitTimeoutMs: {
    type: 'number',
    description:
      'Max milliseconds to wait for embedding completion when wait=true (default 600000).',
  },
} as const;
