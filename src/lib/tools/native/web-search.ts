/**
 * Web Search — Native Tool
 *
 * Performs a web search via Google Custom Search API. Returns a
 * normalised list of `{ title, url, snippet, publishedAt? }` results
 * shaped per TOOL-HANDOFF.md §4.1.
 *
 * Ported from: src/lib/mcp/servers/web-sse.ts → web_search
 *
 * Provider: Google Custom Search API
 *   - Credentials read from `GOOGLE_API_KEY` and
 *     `GOOGLE_SEARCH_ENGINE_ID` (also accepts `GOOGLE_CSE_ID` as alias).
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface WebSearchArgs {
  query: string;
  count?: number;
  queryPlan?: string;
}

interface NormalisedResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

/**
 * Fetch raw items from Google Custom Search.
 *
 * Google's `num` parameter is hard-capped at 10 per request. To support up to
 * 50 results, we page through using the `start` cursor.
 *
 * Exposed as a separate function so tests can stub it independently of fetch
 * timing logic, and so we can unit-test paging behaviour.
 */
async function googleSearch(
  apiKey: string,
  cx: string,
  query: string,
  count: number,
): Promise<{ items: AnyObject[]; totalResults: number }> {
  const PER_PAGE = 10;
  const desired = Math.max(1, Math.min(count, 50));
  const pages = Math.ceil(desired / PER_PAGE);

  const allItems: AnyObject[] = [];
  let totalResults = 0;

  for (let page = 0; page < pages; page++) {
    const start = page * PER_PAGE + 1; // Google uses 1-indexed cursors
    const num = Math.min(PER_PAGE, desired - allItems.length);
    if (num <= 0) break;

    const url =
      'https://www.googleapis.com/customsearch/v1' +
      `?key=${encodeURIComponent(apiKey)}` +
      `&cx=${encodeURIComponent(cx)}` +
      `&q=${encodeURIComponent(query)}` +
      `&num=${num}` +
      `&start=${start}`;

    const response = await fetch(url);

    if (!response.ok) {
      // Try to surface Google's error JSON when present
      let body = '';
      try {
        body = await response.text();
      } catch {
        /* ignore */
      }
      const err = new Error(
        `Google Custom Search ${response.status} ${response.statusText}` +
          (body ? `: ${body.slice(0, 200)}` : ''),
      ) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const data = (await response.json()) as AnyObject;
    const items = Array.isArray(data.items) ? data.items : [];
    allItems.push(...items);

    if (page === 0) {
      const tr = Number(data?.searchInformation?.totalResults || 0);
      totalResults = Number.isFinite(tr) ? tr : 0;
    }

    // Last page returned fewer than requested → no more results, stop early.
    if (items.length < num) break;
  }

  return { items: allItems, totalResults };
}

/**
 * Normalise a Google CSE item into the spec output shape.
 * `publishedAt` is best-effort — Google CSE doesn't always include a date,
 * so we look in pagemap/metatags for common fields.
 */
function normalise(item: AnyObject): NormalisedResult {
  const out: NormalisedResult = {
    title: String(item.title || ''),
    url: String(item.link || ''),
    snippet: String(item.snippet || ''),
  };

  // Best-effort published date extraction
  const meta =
    (item.pagemap?.metatags && item.pagemap.metatags[0]) ||
    (item.pagemap?.newsarticle && item.pagemap.newsarticle[0]) ||
    null;
  if (meta) {
    const date =
      meta['article:published_time'] ||
      meta['og:article:published_time'] ||
      meta['datepublished'] ||
      meta['publishdate'] ||
      meta['date'] ||
      null;
    if (date && typeof date === 'string') {
      out.publishedAt = date;
    }
  }

  return out;
}

const webSearchTool: NativeToolDefinition = {
  description:
    "Search the web for results. Use for current-events questions, fact-checking, or when context-history doesn't have the answer.",
  server: 'web',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query.',
      },
      count: {
        type: 'integer',
        description: 'Number of results to return (1-50, default 10).',
        minimum: 1,
        maximum: 50,
        default: 10,
      },
      queryPlan: {
        type: 'string',
        description:
          'Optional structured plan from the planner node. Currently passed through for telemetry only.',
      },
    },
    required: ['query'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<WebSearchArgs>;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const requestedCount = Number(args.count);
    const count = Number.isFinite(requestedCount)
      ? Math.max(1, Math.min(Math.floor(requestedCount), 50))
      : 10;

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

    const apiKey = process.env.GOOGLE_API_KEY || '';
    const cx =
      process.env.GOOGLE_SEARCH_ENGINE_ID ||
      process.env.GOOGLE_CSE_ID ||
      '';

    if (!apiKey || !cx) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                'Google Custom Search credentials not configured (GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID required)',
              code: 'CONFIGURATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();
    console.log(
      `[web_search] query="${query.slice(0, 80)}" count=${count}` +
        (args.queryPlan ? ' (with queryPlan)' : ''),
    );

    try {
      const { items, totalResults } = await googleSearch(apiKey, cx, query, count);
      const results = items.map(normalise).slice(0, count);

      const duration = Date.now() - startTime;
      console.log(
        `[web_search] returned ${results.length} results (totalResults=${totalResults}) in ${duration}ms`,
      );

      // Best-effort progress event
      const publisher = context?.publisher || null;
      if (publisher) {
        try {
          (publisher as AnyObject).publish?.({
            type: 'tool_output',
            nodeId: context?.nodeId || 'web_search',
            data: {
              chunk: `[web_search] ${results.length} results for "${query}" (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch {
          /* ignore */
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              results,
              totalResults,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      console.error(`[web_search] error: ${message}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              ...(status ? { status } : {}),
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default webSearchTool;
module.exports = webSearchTool;
