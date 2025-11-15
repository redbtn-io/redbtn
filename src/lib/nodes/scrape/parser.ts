/**
 * HTML parser with smart content extraction
 * Custom algorithm for extracting main content from HTML without external dependencies
 */

const MAX_CONTENT_LENGTH = 50000; // Increased - 50k characters
const FETCH_TIMEOUT = 15000; // 15 seconds for larger pages

export interface ParsedContent {
  title?: string;
  text: string;
  contentLength: number;
}

interface ContentBlock {
  text: string;
  score: number;
  linkDensity: number;
}

/**
 * Fetch and parse HTML from a URL
 */
export async function fetchAndParse(url: string): Promise<ParsedContent> {
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
 * Parse HTML and intelligently extract main content
 */
function parseHtml(html: string): ParsedContent {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const title = titleMatch ? cleanText(titleMatch[1]) : undefined;

  // Remove noise elements
  html = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Remove common non-content areas by id/class patterns
  html = removeElementsByPattern(html, [
    'nav', 'header', 'footer', 'sidebar', 'menu', 'advertisement',
    'ad-', 'cookie', 'banner', 'popup', 'modal', 'comment', 'social',
    'share', 'related', 'recommended'
  ]);

  // Extract content blocks with scoring
  const blocks = extractContentBlocks(html);
  
  // Sort by score and take best blocks
  blocks.sort((a, b) => b.score - a.score);
  
  // Combine top scoring blocks
  let text = blocks
    .slice(0, Math.min(10, blocks.length)) // Top 10 blocks
    .map(b => b.text)
    .join('\n\n');

  // Clean up
  text = cleanText(text);

  // Truncate if needed
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
 * Remove elements matching common non-content patterns
 */
function removeElementsByPattern(html: string, patterns: string[]): string {
  for (const pattern of patterns) {
    // Remove by class
    html = html.replace(new RegExp(`<[^>]+class="[^"]*${pattern}[^"]*"[^>]*>[\s\S]*?</[^>]+>`, 'gi'), '');
    // Remove by id
    html = html.replace(new RegExp(`<[^>]+id="[^"]*${pattern}[^"]*"[^>]*>[\s\S]*?</[^>]+>`, 'gi'), '');
  }
  return html;
}

/**
 * Extract and score content blocks
 */
function extractContentBlocks(html: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  
  // Find potential content containers (div, section, article, main, p)
  const containerPattern = /<(div|section|article|main|p)([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  
  while ((match = containerPattern.exec(html)) !== null) {
    const tag = match[1];
    const attributes = match[2];
    const content = match[3];
    
    // Skip if it's likely a non-content container
    if (isNonContentContainer(attributes)) {
      continue;
    }
    
    // Extract text from this block (strip nested HTML)
    const text = extractTextFromHtml(content);
    
    if (text.length < 50) continue; // Skip tiny blocks
    
    // Calculate score
    const score = scoreContent(text, content, tag, attributes);
    const linkDensity = calculateLinkDensity(content, text);
    
    blocks.push({
      text: text.trim(),
      score,
      linkDensity
    });
  }
  
  return blocks;
}

/**
 * Check if attributes suggest non-content container
 */
function isNonContentContainer(attributes: string): boolean {
  const nonContentPatterns = [
    'nav', 'sidebar', 'menu', 'footer', 'header', 'ad', 'comment',
    'social', 'share', 'cookie', 'banner', 'popup'
  ];
  
  const attrLower = attributes.toLowerCase();
  return nonContentPatterns.some(pattern => attrLower.includes(pattern));
}

/**
 * Score content block based on multiple signals
 */
function scoreContent(text: string, html: string, tag: string, attributes: string): number {
  let score = 0;
  
  // Tag bonus
  if (tag === 'article') score += 30;
  else if (tag === 'main') score += 25;
  else if (tag === 'section') score += 10;
  else if (tag === 'p') score += 5;
  
  // Attribute bonus for content indicators
  const attrLower = attributes.toLowerCase();
  if (/article|content|main|post|entry|text|body/i.test(attrLower)) {
    score += 20;
  }
  
  // Text length bonus (more text = more likely main content)
  const textLength = text.length;
  if (textLength > 500) score += 15;
  if (textLength > 1000) score += 15;
  if (textLength > 2000) score += 10;
  
  // Paragraph count (real articles have multiple paragraphs)
  const paragraphs = (html.match(/<p[^>]*>/gi) || []).length;
  score += Math.min(paragraphs * 3, 30);
  
  // Sentence structure (periods suggest real content)
  const sentences = (text.match(/[.!?]+/g) || []).length;
  score += Math.min(sentences * 2, 20);
  
  // Penalize high link density
  const linkDensity = calculateLinkDensity(html, text);
  if (linkDensity > 0.5) score -= 30;
  else if (linkDensity > 0.3) score -= 15;
  
  // Penalize very short text
  if (textLength < 100) score -= 20;
  
  return score;
}

/**
 * Calculate link density (links vs text ratio)
 */
function calculateLinkDensity(html: string, text: string): number {
  const linkTextLength = (html.match(/<a[^>]*>([\s\S]*?)<\/a>/gi) || [])
    .map(link => extractTextFromHtml(link).length)
    .reduce((sum, len) => sum + len, 0);
    
  return text.length > 0 ? linkTextLength / text.length : 1;
}

/**
 * Extract plain text from HTML (strip all tags)
 */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ') // Remove tags
    .replace(/\s+/g, ' ')      // Normalize whitespace
    .trim();
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
    // Remove excessive whitespace
    .replace(/\s+/g, ' ')
    .replace(/\n\s*\n\s*\n/g, '\n\n') // Max 2 newlines
    .trim();
}
