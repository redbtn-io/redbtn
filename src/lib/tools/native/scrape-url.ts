/**
 * Scrape URL — Native Tool
 *
 * Fetches a URL and extracts its main readable content as structured Markdown,
 * clean plaintext, or raw HTML using Happy-DOM content extraction.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { fetchAndParse, DEFAULT_BROWSER_HEADERS } from '../../nodes/scrape/parser';

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
 * Fetch raw HTML — used by the 'html' format only.
 */
async function fetchRawHtml(
  url: string,
  timeoutMs: number,
  abortSignal: AbortSignal | null,
): Promise<{ title?: string; html: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const onRunAbort = abortSignal ? () => controller.abort() : null;
  if (abortSignal && onRunAbort) {
    if (abortSignal.aborted) controller.abort();
    abortSignal.addEventListener('abort', onRunAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: DEFAULT_BROWSER_HEADERS,
      redirect: 'follow',
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
    'Fetch a URL and extract its main readable content as clean Markdown with headings, lists, tables, and code blocks preserved.',
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
        const parsed = await fetchAndParse(url, timeout);
        title = parsed.title;
        content = parsed.text;
      }

      const scrapedAt = new Date().toISOString();
      const contentLength = content.length;
      const duration = Date.now() - startTime;

      console.log(
        `[scrape_url] ${url} → ${contentLength} chars (${duration}ms, format=${format})`,
      );

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
