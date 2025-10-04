import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";

const urlSchema = z.object({
  url: z.string().describe("The URL to scrape (must be http or https)"),
});

class ScrapeUrlTool extends StructuredTool {
  name = "scrape_url";
  description = "Fetch and extract text content from a webpage. Returns the main body text from the URL, limited to 1000 tokens.";
  schema = urlSchema as any;

  async _call({ url }: { url: string }): Promise<string> {
    const startTime = Date.now();
    try {
      let validUrl: URL;
      try {
        validUrl = new URL(url);
      } catch {
        return `Error: Invalid URL format: ${url}`;
      }

      if (!['http:', 'https:'].includes(validUrl.protocol)) {
        return `Error: Only HTTP and HTTPS protocols are allowed`;
      }

      console.log(`[Scrape URL Tool] Fetching: ${url}`);
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RedBot/1.0; +https://redbtn.io)'
        },
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        return `Error: HTTP ${response.status} ${response.statusText}`;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
        return `Error: URL does not return HTML or text content (got: ${contentType})`;
      }

      const html = await response.text();
      const textContent = extractTextFromHtml(html);
      
      if (!textContent.trim()) {
        return `Error: No text content found on the page`;
      }

      const truncated = truncateToTokens(textContent, 1000);
      const duration = Date.now() - startTime;
      console.log(`[Scrape URL Tool] ⏱️  Scraped successfully in ${duration}ms (${truncated.length} chars)`);
      return `Content from ${url}:\n\n${truncated}`;
    } catch (error: any) {
      const duration = Date.now() - startTime;
      console.error(`[Scrape URL Tool] ⏱️  Error after ${duration}ms:`, error);
      
      if (error.name === 'AbortError' || error.name === 'TimeoutError') {
        return `Error: Request timed out after 10 seconds`;
      }
      
      return `Error scraping URL: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function extractTextFromHtml(html: string): string {
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

function truncateToTokens(text: string, maxTokens: number): string {
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
    return truncated + '\n\n... (content truncated to 1000 tokens)';
  } catch (error) {
    // Fallback if tiktoken fails to load (e.g., in browser environments)
    const estimatedChars = maxTokens * 4;
    if (text.length <= estimatedChars) {
      return text;
    }
    return text.substring(0, estimatedChars) + '\n\n... (content truncated to ~1000 tokens)';
  }
}

export const scrapeUrlTool = new ScrapeUrlTool() as any;
