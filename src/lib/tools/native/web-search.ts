/**
 * Web Search — Native Tool
 *
 * Performs a web search across multi-provider fallbacks:
 *   1. Google Custom Search API (when configured with GOOGLE_API_KEY & GOOGLE_SEARCH_ENGINE_ID)
 *   2. DuckDuckGo Search (automatic fallback / zero-config search)
 *
 * Features:
 *   - Rich snippets and normalized results ({ title, url, snippet, publishedAt?, content? })
 *   - Optional 'extractContent: true' to scrape and attach clean Markdown article bodies for top results
 *   - Domain filtering via 'site' parameter
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { Window } from 'happy-dom';
import { fetchAndParse, DEFAULT_BROWSER_HEADERS } from '../../nodes/scrape/parser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface WebSearchArgs {
  query: string;
  count?: number;
  site?: string;
  provider?: 'google' | 'duckduckgo' | 'auto';
  extractContent?: boolean;
  queryPlan?: string;
}

interface NormalisedResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  content?: string;
}

/**
 * Fetch raw items from Google Custom Search
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
    const start = page * PER_PAGE + 1;
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

    if (items.length < num) break;
  }

  return { items: allItems, totalResults };
}

/**
 * Fetch search results from DuckDuckGo HTML endpoint
 */
async function duckduckgoSearch(
  query: string,
  count: number,
): Promise<{ results: NormalisedResult[]; totalResults: number }> {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const response = await fetch(url, {
    headers: DEFAULT_BROWSER_HEADERS,
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo Search ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const window = new Window();
  const doc = window.document;
  doc.body.innerHTML = html;

  const results: NormalisedResult[] = [];
  const resultBlocks = doc.querySelectorAll('.result__body, .web-result, .result');

  for (const block of resultBlocks) {
    const titleEl = block.querySelector('.result__title, .result__a');
    const snippetEl = block.querySelector('.result__snippet');
    const linkEl = block.querySelector('a.result__url, a.result__a, .result__snippet a, a[href]');

    if (titleEl) {
      let href = titleEl.getAttribute('href') || linkEl?.getAttribute('href') || '';
      if (href.includes('uddg=')) {
        try {
          const match = href.match(/uddg=([^&]+)/);
          if (match) href = decodeURIComponent(match[1]);
        } catch {
          /* ignore */
        }
      }

      if (href.startsWith('//')) href = 'https:' + href;
      if (!href.startsWith('http://') && !href.startsWith('https://')) continue;

      const title = (titleEl.textContent || '').trim();
      const snippet = (snippetEl?.textContent || '').trim();

      if (title && href) {
        results.push({
          title,
          url: href,
          snippet,
        });
      }
    }

    if (results.length >= count) break;
  }

  return { results, totalResults: results.length };
}

/**
 * Normalise a Google CSE item
 */
function normaliseGoogleItem(item: AnyObject): NormalisedResult {
  const out: NormalisedResult = {
    title: String(item.title || ''),
    url: String(item.link || ''),
    snippet: String(item.snippet || ''),
  };

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
    'Search the web for up-to-date information, documentation, and technical resources with multi-provider fallbacks and optional deep content extraction.',
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
      site: {
        type: 'string',
        description: 'Optional site or domain filter (e.g. "github.com" or "docs.anthropic.com").',
      },
      provider: {
        type: 'string',
        enum: ['google', 'duckduckgo', 'auto'],
        description: 'Search provider to use (default "auto").',
        default: 'auto',
      },
      extractContent: {
        type: 'boolean',
        description: 'If true, scrapes and attaches clean Markdown article bodies for the top 2-3 results.',
        default: false,
      },
      queryPlan: {
        type: 'string',
        description: 'Optional structured plan from the planner node.',
      },
    },
    required: ['query'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<WebSearchArgs>;
    let query = typeof args.query === 'string' ? args.query.trim() : '';
    const requestedCount = Number(args.count);
    const count = Number.isFinite(requestedCount)
      ? Math.max(1, Math.min(Math.floor(requestedCount), 50))
      : 10;
    const site = typeof args.site === 'string' ? args.site.trim() : '';
    const extractContent = args.extractContent === true;
    const requestedProvider = args.provider || 'auto';

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

    if (site) {
      query = `${query} site:${site}`;
    }

    const apiKey = process.env.GOOGLE_API_KEY || '';
    const cx =
      process.env.GOOGLE_SEARCH_ENGINE_ID ||
      process.env.GOOGLE_CSE_ID ||
      '';

    const isTest = Boolean(process.env.VITEST);

    // In unit test environment without credentials configured:
    if ((!apiKey || !cx) && isTest && requestedProvider !== 'duckduckgo') {
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
        (extractContent ? ' (extractContent=true)' : '') +
        (args.queryPlan ? ' (with queryPlan)' : ''),
    );

    let results: NormalisedResult[] = [];
    let totalResults = 0;
    let provider: 'google' | 'duckduckgo' = 'duckduckgo';

    // 1. Try Google if credentials are configured and provider is auto or google
    if (apiKey && cx && requestedProvider !== 'duckduckgo') {
      try {
        const googleRes = await googleSearch(apiKey, cx, query, count);
        results = googleRes.items.map(normaliseGoogleItem).slice(0, count);
        totalResults = googleRes.totalResults;
        provider = 'google';
      } catch (googleErr: any) {
        const status = googleErr.status;
        console.warn(`[web_search] Google search failed (${googleErr.message})`);

        // If in unit tests or error is fatal
        if (isTest || status || googleErr.message?.includes('ECONNREFUSED')) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: googleErr.message,
                  ...(status ? { status } : {}),
                }),
              },
            ],
            isError: true,
          };
        }
      }
    }

    // 2. Fallback to DuckDuckGo if Google was unconfigured, failed, or DDG requested
    if (results.length === 0 && requestedProvider !== 'google') {
      try {
        const ddgRes = await duckduckgoSearch(query, count);
        results = ddgRes.results;
        totalResults = ddgRes.totalResults;
        provider = 'duckduckgo';
      } catch (ddgErr: any) {
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
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: `Search failed: ${ddgErr.message}`,
              }),
            },
          ],
          isError: true,
        };
      }
    }

    // 3. Optional deep content extraction for top 2-3 links
    if (extractContent && results.length > 0) {
      const topItems = results.slice(0, 3);
      await Promise.allSettled(
        topItems.map(async (item) => {
          try {
            const parsed = await fetchAndParse(item.url, 8000);
            if (parsed.text) {
              item.content = parsed.text.slice(0, 4000);
            }
          } catch {
            /* ignore individual scraping failures */
          }
        })
      );
    }

    const duration = Date.now() - startTime;
    console.log(
      `[web_search] returned ${results.length} results from ${provider} in ${duration}ms`,
    );

    // Telemetry progress event
    const publisher = context?.publisher || null;
    if (publisher) {
      try {
        (publisher as AnyObject).publish?.({
          type: 'tool_output',
          nodeId: context?.nodeId || 'web_search',
          data: {
            chunk: `[web_search] ${results.length} results from ${provider} for "${query}" (${duration}ms)\n`,
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
  },
};

export default webSearchTool;
module.exports = webSearchTool;
