/**
 * Scrape URL — Native Tool
 *
 * Fetches a URL and extracts its main readable content as markdown / text /
 * raw html. Reuses the existing `fetchAndParse` smart-extractor in
 * `src/lib/nodes/scrape/parser.ts` for the markdown / text path; for raw
 * html we do a separate fetch since the parser strips html.
 *
 * Ported from: src/lib/mcp/servers/web-sse.ts → scrape_url
 *
 * Spec: TOOL-HANDOFF.md §4.1
 *   - inputs: url (required), format ('markdown'|'text'|'html', default 'markdown'),
 *             timeout (ms, default 30000, max 120000)
 *   - output: { url, title, content, contentLength, scrapedAt }
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { fetchAndParse } from '../../nodes/scrape/parser';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ScrapeUrlArgs {
  url: string;
  format?: 'markdown' | 'text' | 'html';
  timeout?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function isHttpUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

/**
 * Fetch raw HTML — used by the `'html'` format only.
 *
 * Mirrors the User-Agent and Accept headers from `fetchAndParse` so that
 * sites that gate on those headers behave the same way regardless of which
 * `format` was requested.
 */
async function fetchRawHtml(
  url: string,
  timeoutMs: number,
  abortSignal: AbortSignal | null,
): Promise<{ title?: string; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Forward run-level abort to this request
  const onRunAbort = abortSignal ? () => controller.abort() : null;
  if (abortSignal && onRunAbort) {
    if (abortSignal.aborted) controller.abort();
    abortSignal.addEventListener('abort', onRunAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RedAI/1.0; +https://redbtn.io)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : undefined;

    return { title, html };
  } finally {
    clearTimeout(timer);
    if (abortSignal && onRunAbort) {
      abortSignal.removeEventListener('abort', onRunAbort);
    }
  }
}

const scrapeUrlTool: NativeToolDefinition = {
  description:
    'Fetch a URL and extract its main readable content as markdown. Use to read article bodies, docs, or any URL whose content you need to summarize.',
  server: 'web',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to scrape (must start with http:// or https://).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'html'],
        description: "Output format (default 'markdown').",
        default: 'markdown',
      },
      timeout: {
        type: 'integer',
        description:
          'Request timeout in milliseconds (default 30000, max 120000).',
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
      },
    },
    required: ['url'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ScrapeUrlArgs>;
    const url = typeof args.url === 'string' ? args.url.trim() : '';
    const formatRaw = typeof args.format === 'string' ? args.format.toLowerCase() : 'markdown';
    const format: 'markdown' | 'text' | 'html' =
      formatRaw === 'html' || formatRaw === 'text' ? (formatRaw as 'html' | 'text') : 'markdown';

    let timeout = Number(args.timeout);
    if (!Number.isFinite(timeout) || timeout <= 0) {
      timeout = DEFAULT_TIMEOUT_MS;
    }
    timeout = Math.min(Math.floor(timeout), MAX_TIMEOUT_MS);

    if (!url) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'url is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (!isHttpUrl(url)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'url must start with http:// or https://',
              code: 'VALIDATION',
              url,
            }),
          },
        ],
        isError: true,
      };
    }

    const startTime = Date.now();
    console.log(`[scrape_url] url="${url}" format=${format} timeout=${timeout}ms`);

    try {
      let title: string | undefined;
      let content = '';

      if (format === 'html') {
        const { title: t, html } = await fetchRawHtml(
          url,
          timeout,
          context?.abortSignal || null,
        );
        title = t;
        content = html;
      } else {
        // markdown / text — use the smart extractor (returns plain text).
        // The parser today returns a plaintext-ish form; we surface it as
        // both 'markdown' (LLM-consumable) and 'text' aliases.
        const parsed = await fetchAndParse(url);
        title = parsed.title;
        content = parsed.text;
      }

      const scrapedAt = new Date().toISOString();
      const contentLength = content.length;
      const duration = Date.now() - startTime;

      console.log(
        `[scrape_url] ${url} → ${contentLength} chars (${duration}ms, format=${format})`,
      );

      // Best-effort progress event
      const publisher = context?.publisher || null;
      if (publisher) {
        try {
          (publisher as AnyObject).publish?.({
            type: 'tool_output',
            nodeId: context?.nodeId || 'scrape_url',
            data: {
              chunk: `[scrape_url] ${url} → ${contentLength} chars (${duration}ms)\n`,
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
              url,
              title: title || null,
              content,
              contentLength,
              scrapedAt,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[scrape_url] error: ${message}`);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              url,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default scrapeUrlTool;
module.exports = scrapeUrlTool;
