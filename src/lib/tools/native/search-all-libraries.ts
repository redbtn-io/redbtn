/**
 * Search All Libraries — Native Library Tool
 *
 * Cross-library semantic search. Lists every library the caller has access
 * to, then runs the per-library semantic-search endpoint against each one
 * and merges the results.
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: query (required), limit? (default 10), libraryIds?, minScore?
 *   - output: { results: [{ libraryId, documentId, content, score }] }
 *
 * The webapp does not expose a single "search across all my libraries"
 * route — we fan out client-side here. `libraryIds` (when supplied) acts as
 * a filter on which libraries are queried; otherwise we hit every library
 * the caller can read.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SearchAllLibrariesArgs {
  query: string;
  limit?: number;
  libraryIds?: string[];
  minScore?: number;
}

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(
  context: NativeToolContext,
  contentType: string | null = 'application/json',
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (contentType) headers['Content-Type'] = contentType;

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

const searchAllLibrariesTool: NativeToolDefinition = {
  description:
    'Search every Knowledge Library the caller can access. Returns the top-scoring results across libraries, optionally narrowed to a specific subset via `libraryIds`.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language query to search semantically.',
      },
      limit: {
        type: 'integer',
        description: 'Max number of merged results to return (default 10, max 100).',
        minimum: 1,
        maximum: 100,
      },
      libraryIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional filter: only search these libraries. Default is every library the caller can read.',
      },
      minScore: {
        type: 'number',
        description:
          'Minimum similarity score (0..1). Results below this are dropped.',
        minimum: 0,
        maximum: 1,
      },
    },
    required: ['query'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<SearchAllLibrariesArgs>;
    const query = typeof args.query === 'string' ? args.query.trim() : '';

    if (!query) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'query is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(100, Math.max(1, Math.floor(Number(args.limit))))
        : 10;
    const filterIds = Array.isArray(args.libraryIds)
      ? args.libraryIds.filter((s: unknown) => typeof s === 'string' && s.length > 0)
      : null;
    const minScore =
      args.minScore !== undefined && Number.isFinite(Number(args.minScore))
        ? Math.max(0, Math.min(1, Number(args.minScore)))
        : null;

    const baseUrl = getBaseUrl();

    try {
      // Step 1: figure out which libraries to search.
      let targetIds: string[];
      if (filterIds && filterIds.length > 0) {
        targetIds = filterIds;
      } else {
        const listUrl = `${baseUrl}/api/v1/libraries`;
        const listResp = await fetch(listUrl, {
          headers: buildHeaders(context),
        });
        if (!listResp.ok) {
          let errBody = '';
          try {
            errBody = await listResp.text();
          } catch {
            /* ignore */
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error:
                    `Library list API ${listResp.status} ${listResp.statusText}` +
                    (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                  status: listResp.status,
                }),
              },
            ],
            isError: true,
          };
        }
        const listBody = (await listResp.json()) as AnyObject;
        const all = Array.isArray(listBody?.libraries) ? listBody.libraries : [];
        targetIds = all
          .map((l: AnyObject) =>
            typeof l?.libraryId === 'string'
              ? l.libraryId
              : typeof l?.id === 'string'
              ? l.id
              : null,
          )
          .filter((s: string | null) => typeof s === 'string') as string[];
      }

      if (targetIds.length === 0) {
        return {
          content: [
            { type: 'text', text: JSON.stringify({ results: [] }) },
          ],
        };
      }

      // Step 2: fan out search calls in parallel (cap concurrency at 8).
      const perLibLimit = Math.max(1, Math.min(50, limit));
      const allResults: AnyObject[] = [];

      const runOne = async (libraryId: string): Promise<void> => {
        const searchUrl = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}/search`;
        try {
          const r = await fetch(searchUrl, {
            method: 'POST',
            headers: buildHeaders(context),
            body: JSON.stringify({
              query,
              limit: perLibLimit,
              ...(minScore !== null ? { threshold: minScore } : {}),
            }),
          });
          if (!r.ok) return;
          const j = (await r.json()) as AnyObject;
          const items = Array.isArray(j?.results) ? j.results : [];
          for (const it of items) {
            const meta = (it?.metadata as AnyObject) ?? {};
            allResults.push({
              libraryId,
              documentId: meta.documentId ?? null,
              content: typeof it?.text === 'string' ? it.text : '',
              score: typeof it?.score === 'number' ? it.score : 0,
              metadata: meta,
            });
          }
        } catch {
          // Per-library failure is non-fatal — keep going across the rest.
        }
      };

      // Simple parallel fan-out with a soft cap.
      const concurrency = 8;
      for (let i = 0; i < targetIds.length; i += concurrency) {
        const slice = targetIds.slice(i, i + concurrency);
        await Promise.all(slice.map(runOne));
      }

      // Step 3: filter by minScore (extra safety on top of the per-call threshold)
      // and sort by score descending.
      const filtered =
        minScore !== null
          ? allResults.filter((r) => (r.score ?? 0) >= minScore)
          : allResults;

      filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      const trimmed = filtered.slice(0, limit);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ results: trimmed }),
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

export default searchAllLibrariesTool;
module.exports = searchAllLibrariesTool;
