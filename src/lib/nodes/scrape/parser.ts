/**
 * HTML parser
 * Extracts clean text content from HTML documents
 */

const MAX_CONTENT_LENGTH = 10000; // Characters
const FETCH_TIMEOUT = 10000; // 10 seconds

export interface ParsedContent {
  title?: string;
  text: string;
  contentLength: number;
}

/**
 * Fetch and parse HTML from a URL
 */
export async function fetchAndParse(url: string): Promise<ParsedContent> {
  // Fetch with timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RedAI/1.0; +https://redbtn.io)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`URL is not HTML (Content-Type: ${contentType})`);
    }

    const html = await response.text();
    
    return parseHtml(html);
    
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Request timeout after ${FETCH_TIMEOUT}ms`);
    }
    throw error;
  }
}

/**
 * Parse HTML and extract text content
 */
function parseHtml(html: string): ParsedContent {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : undefined;

  // Remove script and style tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, ''); // Remove comments

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, ' ');

  // Clean up the text
  text = cleanText(text);

  // Truncate if too long
  const originalLength = text.length;
  if (text.length > MAX_CONTENT_LENGTH) {
    text = text.substring(0, MAX_CONTENT_LENGTH) + '\n\n[Content truncated...]';
  }

  return {
    title,
    text,
    contentLength: originalLength,
  };
}

/**
 * Clean and normalize text
 */
function cleanText(text: string): string {
  return text
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Normalize whitespace
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}
