import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const searchSchema = z.object({
  query: z.string().describe("The search query to look up on Google"),
});

/**
 * Web Search Tool - Searches Google using Custom Search API and scrapes each result
 * Requires GOOGLE_API_KEY and GOOGLE_SEARCH_ENGINE_ID environment variables
 */
class WebSearchTool extends StructuredTool {
  name = "web_search";
  description = "Search the web using Google and get actual content from the pages. Use this when you need current information, facts, news, or data that you don't have in your training data. Returns up to 5 search results with titles, snippets, URLs, and 200 tokens of body content from each page.";
  schema = searchSchema as any; // Type assertion to bypass deep instantiation

  async _call({ query }: { query: string }): Promise<string> {
    const startTime = Date.now();
    try {
      const apiKey = process.env.GOOGLE_API_KEY;
      const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID;

      if (!apiKey) {
        return "Error: GOOGLE_API_KEY environment variable is not set. Cannot perform web search.";
      }

      if (!searchEngineId) {
        return "Error: GOOGLE_SEARCH_ENGINE_ID or GOOGLE_CSE_ID environment variable is not set. Cannot perform web search.";
      }

      console.log(`[Web Search Tool] Searching for: "${query}"`);
      const searchStartTime = Date.now();
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=5`;
      
      const response = await fetch(url);
      const searchDuration = Date.now() - searchStartTime;
      console.log(`[Web Search Tool] ⏱️  Google search took ${searchDuration}ms`);
      
      if (!response.ok) {
        const errorData = await response.text();
        return `Error searching Google: ${response.status} ${response.statusText}. ${errorData}`;
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        return `No results found for query: "${query}"`;
      }

      // Scrape each result URL in parallel
      console.log(`[Web Search Tool] Scraping ${data.items.length} results...`);
      const scrapeStartTime = Date.now();
      const scrapePromises = data.items.map((item: any) => 
        this.scrapeUrl(item.link).catch(err => `Error: ${err.message}`)
      );
      
      const scrapedContents = await Promise.all(scrapePromises);
      const scrapeDuration = Date.now() - scrapeStartTime;
      console.log(`[Web Search Tool] ⏱️  Scraped ${data.items.length} pages in ${scrapeDuration}ms (${Math.round(scrapeDuration / data.items.length)}ms avg)`);

      // Format results with scraped content
      const results = data.items.map((item: any, index: number) => {
        const content = scrapedContents[index];
        return `${index + 1}. **${item.title}**
   Snippet: ${item.snippet}
   URL: ${item.link}
   
   Content preview:
   ${content}`;
      }).join('\n\n---\n\n');

      const totalDuration = Date.now() - startTime;
      console.log(`[Web Search Tool] ⏱️  Total execution time: ${totalDuration}ms`);

      return `Search results for "${query}":\n\n${results}`;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      console.error(`[Web Search Tool] Error after ${totalDuration}ms:`, error);
      return `Error performing web search: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * Scrape a URL and extract text content, limited to 200 tokens
   */
  private async scrapeUrl(url: string): Promise<string> {
    const scrapeStart = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RedBot/1.0; +https://redbtn.io)'
        },
        signal: AbortSignal.timeout(5000) // 5 second timeout per page
      });

      if (!response.ok) {
        console.log(`[Web Search Tool] ⏱️  ${url} - Failed (${Date.now() - scrapeStart}ms): HTTP ${response.status}`);
        return `[Failed to fetch: HTTP ${response.status}]`;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        console.log(`[Web Search Tool] ⏱️  ${url} - Skipped (${Date.now() - scrapeStart}ms): ${contentType}`);
        return `[Non-HTML content: ${contentType}]`;
      }

      const html = await response.text();
      const textContent = this.extractTextFromHtml(html);
      
      if (!textContent.trim()) {
        console.log(`[Web Search Tool] ⏱️  ${url} - Empty (${Date.now() - scrapeStart}ms)`);
        return '[No text content found]';
      }

      const truncated = this.truncateToTokens(textContent, 200);
      const duration = Date.now() - scrapeStart;
      console.log(`[Web Search Tool] ⏱️  ${url} - Success (${duration}ms, ${truncated.length} chars)`);
      return truncated;
    } catch (error: any) {
      const duration = Date.now() - scrapeStart;
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        console.log(`[Web Search Tool] ⏱️  ${url} - Timeout (${duration}ms)`);
        return '[Timeout]';
      }
      console.log(`[Web Search Tool] ⏱️  ${url} - Error (${duration}ms): ${error.message}`);
      return `[Error: ${error.message}]`;
    }
  }

  /**
   * Extract text from HTML by removing scripts, styles, and tags
   */
  private extractTextFromHtml(html: string): string {
    let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ');
    text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ');
    text = text.replace(/<!--[\s\S]*?-->/g, ' ');
    text = text.replace(/<[^>]+>/g, ' ');
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");
    text = text.replace(/&mdash;/g, '—');
    text = text.replace(/&ndash;/g, '–');
    text = text.replace(/\s+/g, ' ');
    text = text.trim();
    return text;
  }

  /**
   * Truncate text to a maximum number of tokens
   */
  private truncateToTokens(text: string, maxTokens: number): string {
    try {
      // Lazy-load tiktoken to avoid build-time issues with WASM
      const { encoding_for_model } = require('tiktoken');
      const encoding = encoding_for_model('gpt-3.5-turbo');
      const tokens = encoding.encode(text);
      
      if (tokens.length <= maxTokens) {
        encoding.free();
        return text;
      }
      
      const truncatedTokens = tokens.slice(0, maxTokens);
      const truncated = new TextDecoder().decode(encoding.decode(truncatedTokens));
      
      encoding.free();
      return truncated + '...';
    } catch (error) {
      // Fallback if tiktoken fails to load
      const estimatedChars = maxTokens * 4;
      if (text.length <= estimatedChars) {
        return text;
      }
      return text.substring(0, estimatedChars) + '...';
    }
  }
}

export const webSearchTool = new WebSearchTool() as any; // Type assertion for export
