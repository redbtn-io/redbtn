/**
 * HTML parser with intelligent content extraction and Markdown conversion.
 * Uses Happy-DOM to parse DOM nodes into structured GitHub-Flavored Markdown
 * preserving headings, code blocks, lists, links, and tables while stripping noise.
 */

import { Window } from 'happy-dom';

const MAX_CONTENT_LENGTH = 100000;
const FETCH_TIMEOUT = 25000;

export const DEFAULT_BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

export interface ParsedContent {
  title?: string;
  description?: string;
  publishedAt?: string;
  text: string;
  contentLength: number;
}

/**
 * Fetch and parse HTML from a URL with browser emulation headers
 */
export async function fetchAndParse(url: string, timeoutMs = FETCH_TIMEOUT): Promise<ParsedContent> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: DEFAULT_BROWSER_HEADERS,
      redirect: 'follow',
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml') && !contentType.includes('text/plain')) {
      throw new Error(`URL is not HTML (Content-Type: ${contentType})`);
    }

    const html = await response.text();
    return parseHtml(html, url);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse HTML string and convert main content to clean Markdown
 */
export function parseHtml(html: string, baseUrl?: string): ParsedContent {
  try {
    const window = new Window();
    const doc = window.document;
    doc.body.innerHTML = html;

    // Extract title
    const titleEl = doc.querySelector('title');
    const ogTitle = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    const title = cleanWhitespace(titleEl?.textContent || ogTitle || '');

    // Extract description
    const metaDesc =
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      doc.querySelector('meta[property="og:description"]')?.getAttribute('content') ||
      undefined;

    // Extract published date
    const metaDate =
      doc.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="date"]')?.getAttribute('content') ||
      doc.querySelector('meta[name="publishdate"]')?.getAttribute('content') ||
      undefined;

    // Remove noise tags from DOM
    const noiseSelectors = [
      'script',
      'style',
      'noscript',
      'iframe',
      'svg',
      'canvas',
      'nav',
      'footer',
      'aside',
      'header',
      'form',
      'dialog',
      '.ad',
      '.ads',
      '.advertisement',
      '.cookie-banner',
      '.cookie-consent',
      '.popup',
      '.modal',
      '.share-buttons',
      '.social-share',
    ];

    for (const selector of noiseSelectors) {
      try {
        const elements = doc.querySelectorAll(selector);
        for (const el of elements) {
          el.remove();
        }
      } catch {
        /* ignore selector errors */
      }
    }

    // Identify main content container if possible
    const mainContainer =
      doc.querySelector('article') ||
      doc.querySelector('main') ||
      doc.querySelector('[role="main"]') ||
      doc.querySelector('#content') ||
      doc.querySelector('.content') ||
      doc.querySelector('.post-content') ||
      doc.querySelector('.article-content') ||
      doc.body;

    let markdown = domToMarkdown(mainContainer, baseUrl);
    markdown = normalizeMarkdown(markdown);

    const originalLength = markdown.length;
    if (markdown.length > MAX_CONTENT_LENGTH) {
      markdown = markdown.substring(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated...]';
    }

    return {
      title: title || undefined,
      description: metaDesc ? cleanWhitespace(metaDesc) : undefined,
      publishedAt: metaDate ? cleanWhitespace(metaDate) : undefined,
      text: markdown,
      contentLength: originalLength,
    };
  } catch {
    // Fallback: regex text cleaner if DOM parser fails
    return fallbackRegexParser(html);
  }
}

/**
 * Convert a DOM node and its children into Markdown
 */
function domToMarkdown(node: any, baseUrl?: string): string {
  if (!node) return '';

  // Node type 3: Text node
  if (node.nodeType === 3) {
    return cleanInlineWhitespace(node.textContent || '');
  }

  // Node type 1: Element node
  if (node.nodeType !== 1) return '';

  const tag = (node.tagName || '').toUpperCase();
  const children = Array.from(node.childNodes || []);

  const renderChildren = () => children.map(child => domToMarkdown(child, baseUrl)).join('');

  switch (tag) {
    case 'H1':
      return `\n\n# ${renderChildren().trim()}\n\n`;
    case 'H2':
      return `\n\n## ${renderChildren().trim()}\n\n`;
    case 'H3':
      return `\n\n### ${renderChildren().trim()}\n\n`;
    case 'H4':
      return `\n\n#### ${renderChildren().trim()}\n\n`;
    case 'H5':
      return `\n\n##### ${renderChildren().trim()}\n\n`;
    case 'H6':
      return `\n\n###### ${renderChildren().trim()}\n\n`;

    case 'P': {
      const text = renderChildren().trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    case 'BR':
      return '\n';

    case 'HR':
      return '\n\n---\n\n';

    case 'B':
    case 'STRONG': {
      const text = renderChildren().trim();
      return text ? ` **${text}** ` : '';
    }

    case 'I':
    case 'EM': {
      const text = renderChildren().trim();
      return text ? ` *${text}* ` : '';
    }

    case 'CODE': {
      const parentTag = (node.parentNode?.tagName || '').toUpperCase();
      if (parentTag === 'PRE') {
        return node.textContent || '';
      }
      const code = (node.textContent || '').trim();
      return code ? ` \`${code}\` ` : '';
    }

    case 'PRE': {
      const codeEl = node.querySelector('code');
      const langClass = (codeEl?.getAttribute('class') || node.getAttribute('class') || '');
      const langMatch = langClass.match(/language-([a-zA-Z0-9_-]+)/);
      const lang = langMatch ? langMatch[1] : '';
      const code = (codeEl?.textContent || node.textContent || '').trim();
      return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
    }

    case 'BLOCKQUOTE': {
      const inner = renderChildren().trim();
      return inner
        ? '\n\n' + inner.split('\n').map(line => `> ${line}`).join('\n') + '\n\n'
        : '';
    }

    case 'UL':
    case 'OL': {
      const isOrdered = tag === 'OL';
      const items = Array.from(node.children || []).filter((el: any) => (el.tagName || '').toUpperCase() === 'LI');
      if (items.length === 0) return renderChildren();
      const rendered = items.map((li: any, idx) => {
        const prefix = isOrdered ? `${idx + 1}. ` : '* ';
        const itemText = domToMarkdown(li, baseUrl).trim();
        return `${prefix}${itemText}`;
      }).join('\n');
      return `\n\n${rendered}\n\n`;
    }

    case 'LI': {
      return renderChildren().trim();
    }

    case 'A': {
      const href = node.getAttribute('href');
      const text = renderChildren().trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
        return text;
      }
      let fullUrl = href;
      if (baseUrl && !href.startsWith('http://') && !href.startsWith('https://')) {
        try {
          fullUrl = new URL(href, baseUrl).toString();
        } catch {
          fullUrl = href;
        }
      }
      return text ? `[${text}](${fullUrl})` : '';
    }

    case 'TABLE': {
      return renderTable(node, baseUrl);
    }

    case 'SECTION':
    case 'ARTICLE':
    case 'MAIN':
    case 'DIV': {
      return renderChildren();
    }

    default:
      return renderChildren();
  }
}

/**
 * Convert HTML Table to Markdown Table
 */
function renderTable(tableNode: any, baseUrl?: string): string {
  try {
    const rows = Array.from(tableNode.querySelectorAll('tr'));
    if (rows.length === 0) return '';

    const tableData: string[][] = [];
    for (const row of rows as any[]) {
      const cells = Array.from(row.querySelectorAll('th, td'));
      if (cells.length > 0) {
        tableData.push(
          cells.map((cell: any) => {
            return domToMarkdown(cell, baseUrl).replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim();
          })
        );
      }
    }

    if (tableData.length === 0) return '';

    const maxCols = Math.max(...tableData.map(r => r.length));
    if (maxCols === 0) return '';

    const header = tableData[0];
    while (header.length < maxCols) header.push('');
    const separator = Array(maxCols).fill('---');

    const lines = [
      `| ${header.join(' | ')} |`,
      `| ${separator.join(' | ')} |`,
    ];

    for (let i = 1; i < tableData.length; i++) {
      const row = tableData[i];
      while (row.length < maxCols) row.push('');
      lines.push(`| ${row.join(' | ')} |`);
    }

    return `\n\n${lines.join('\n')}\n\n`;
  } catch {
    return '';
  }
}

/**
 * Clean inline whitespace without removing line breaks
 */
function cleanInlineWhitespace(text: string): string {
  return text.replace(/[ \t\r\f]+/g, ' ');
}

/**
 * Clean global whitespace and decode common HTML entities
 */
function cleanWhitespace(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize markdown layout (remove excessive blank lines)
 */
function normalizeMarkdown(md: string): string {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^[ \t]+/gm, '')
    .trim();
}

/**
 * Regex-based fallback parser
 */
function fallbackRegexParser(html: string): ParsedContent {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? cleanWhitespace(titleMatch[1]) : undefined;

  let cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const originalLength = cleaned.length;
  if (cleaned.length > MAX_CONTENT_LENGTH) {
    cleaned = cleaned.substring(0, MAX_CONTENT_LENGTH) + '...';
  }

  return {
    title,
    text: cleaned,
    contentLength: originalLength,
  };
}
