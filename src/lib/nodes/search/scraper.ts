/**
 * Web page scraper
 * Fetches and extracts clean text content from search result URLs
 */

import type { SearchResult } from './types';

const MAX_CONTENT_LENGTH = 4000; // Characters
const FETCH_TIMEOUT = 8000; // 8 seconds per page

/**
 * Scrape a single URL and extract text content
 */
async function scrapeSingleUrl(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RedAI/1.0; +https://redbtn.io)',
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    
    // Remove script and style tags
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    // Decode common HTML entities
    text = text
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    // Truncate if too long
    if (text.length > MAX_CONTENT_LENGTH) {
      text = text.substring(0, MAX_CONTENT_LENGTH) + '...';
    }

    return text || null;
  } catch (error) {
    // Timeout, network error, etc. - just skip this URL
    return null;
  }
}

/**
 * Scrape multiple search results in parallel
 * Returns updated results with content field populated
 */
export async function scrapeSearchResults(
  results: SearchResult[],
  onProgress?: (current: number, total: number, url: string) => void
): Promise<SearchResult[]> {
  const scrapedResults: SearchResult[] = [];

  // Scrape up to 5 results in parallel to avoid overwhelming servers
  const batchSize = 5;
  
  for (let i = 0; i < results.length; i += batchSize) {
    const batch = results.slice(i, i + batchSize);
    
    const scrapedBatch = await Promise.all(
      batch.map(async (result, batchIndex) => {
        const globalIndex = i + batchIndex;
        
        if (onProgress) {
          onProgress(globalIndex + 1, results.length, result.url);
        }

        const content = await scrapeSingleUrl(result.url);
        
        return {
          ...result,
          content: content || undefined,
          scrapedAt: Date.now(),
        };
      })
    );

    scrapedResults.push(...scrapedBatch);
  }

  return scrapedResults;
}
