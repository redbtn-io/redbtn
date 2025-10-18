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
  description = "Search the web using Google and get actual content from the pages. Use this when you need current information, facts, news, or data that you don't have in your training data. Returns up to 10 search results with titles, snippets, URLs, and relevant body content from each page.";
  schema = searchSchema as any; // Type assertion to bypass deep instantiation

  async _call({ query }: { query: string }, runManager?: any): Promise<string> {
    const startTime = Date.now();
    
    // Check ALL arguments passed to this function
    console.log(`[Web Search Tool] _call invoked with ${arguments.length} arguments`);
    console.log(`[Web Search Tool] arg[0] (input):`, arguments[0]);
    console.log(`[Web Search Tool] arg[1] (runManager):`, typeof arguments[1]);
    console.log(`[Web Search Tool] arg[2] (config):`, typeof arguments[2], arguments[2]);
    
    const config = arguments[2];
    
    // Get tool event publisher from config if available
    let publisher: any = null;
    const { createIntegratedPublisher } = await import('../events/integrated-publisher');
    const redInstance = config?.metadata?.redInstance;
    const messageId = config?.metadata?.messageId;
    const conversationId = config?.metadata?.conversationId;
    
    console.log(`[Web Search Tool] Config check:`, {
      hasConfig: !!config,
      hasMetadata: !!config?.metadata,
      hasRedInstance: !!redInstance,
      hasMessageQueue: !!redInstance?.messageQueue,
      messageId,
      conversationId
    });
    
    if (redInstance?.messageQueue && messageId && conversationId) {
      console.log(`[Web Search Tool] Creating publisher...`);
      publisher = createIntegratedPublisher(
        redInstance.messageQueue,
        'web_search',
        'Web Search',
        messageId,
        conversationId
      );
      
      console.log(`[Web Search Tool] Publishing start event...`);
      await publisher.publishStart({
        input: { query, maxResults: 10 },
        expectedDuration: 5000,
      });
      console.log(`[Web Search Tool] Start event published!`);
    } else {
      console.log(`[Web Search Tool] Cannot create publisher - missing required data`);
    }
    
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
      if (publisher) {
        await publisher.publishProgress('Searching Google...', {
          progress: 10,
          data: { query, provider: 'Google Custom Search' }
        });
      }
      
      const searchStartTime = Date.now();
      const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${searchEngineId}&q=${encodeURIComponent(query)}&num=10`;
      
      const response = await fetch(url);
      const searchDuration = Date.now() - searchStartTime;
      console.log(`[Web Search Tool] ⏱️  Google search took ${searchDuration}ms`);
      
      if (!response.ok) {
        const errorData = await response.text();
        const error = `Error searching Google: ${response.status} ${response.statusText}. ${errorData}`;
        if (publisher) await publisher.publishError(error, 'SEARCH_API_ERROR');
        return error;
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        const error = `No results found for query: "${query}"`;
        if (publisher) {
          await publisher.publishComplete(
            { resultsFound: 0 },
            { duration: Date.now() - startTime }
          );
        }
        return error;
      }

      if (publisher) {
        await publisher.publishProgress(`Found ${data.items.length} results`, {
          progress: 30,
          data: { resultCount: data.items.length }
        });
      }

      // Scrape each result URL in parallel
      console.log(`[Web Search Tool] Scraping ${data.items.length} results...`);
      if (publisher) {
        await publisher.publishProgress(`Extracting content from ${data.items.length} pages...`, {
          progress: 40,
          data: { resultCount: data.items.length }
        });
      }
      
      const scrapeStartTime = Date.now();
      const scrapePromises = data.items.map((item: any) => 
        this.scrapeUrl(item.link, query).catch(err => `Error: ${err.message}`)
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
   
   Content:
   ${content}`;
      }).join('\n\n---\n\n');

      const totalDuration = Date.now() - startTime;
      console.log(`[Web Search Tool] ⏱️  Total execution time: ${totalDuration}ms`);

      if (publisher) {
        await publisher.publishComplete(
          { resultsFound: data.items.length, query },
          { duration: totalDuration, searchDuration, scrapeDuration }
        );
      }

      return `Search results for "${query}":\n\n${results}`;
    } catch (error) {
      const totalDuration = Date.now() - startTime;
      console.error(`[Web Search Tool] Error after ${totalDuration}ms:`, error);
      const errorMessage = `Error performing web search: ${error instanceof Error ? error.message : String(error)}`;
      if (publisher) {
        await publisher.publishError(errorMessage, 'SEARCH_FAILED');
      }
      return errorMessage;
    }
  }

  /**
   * Scrape a URL and extract relevant text content based on query keywords
   * Extracts up to 1500 tokens of the most relevant content
   */
  private async scrapeUrl(url: string, query: string): Promise<string> {
    const scrapeStart = Date.now();
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RedBot/1.0; +https://redbtn.io)'
        },
        signal: AbortSignal.timeout(8000) // 8 second timeout per page
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

      // Extract relevant sections based on query keywords
      const relevantContent = this.extractRelevantSections(textContent, query, 1500);
      const duration = Date.now() - scrapeStart;
      console.log(`[Web Search Tool] ⏱️  ${url} - Success (${duration}ms, ${relevantContent.length} chars)`);
      return relevantContent;
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
   * Extract the most relevant sections from text based on query keywords
   * Uses keyword matching to find paragraphs/sections that contain query terms
   */
  private extractRelevantSections(text: string, query: string, maxTokens: number): string {
    // Extract keywords from query (remove common words)
    const stopWords = new Set(['a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might',
      'what', 'when', 'where', 'who', 'which', 'why', 'how', 'for', 'to', 'of', 'in', 'on', 'at',
      'by', 'with', 'from', 'about', 'as', 'into', 'through', 'during', 'before', 'after', 'above',
      'below', 'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'all', 'any',
      'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only',
      'own', 'same', 'so', 'than', 'too', 'very', 'can', 'just', 'today', 'tonight', 'this', 'that']);
    
    const keywords = query.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));
    
    if (keywords.length === 0) {
      // No meaningful keywords, just truncate from beginning
      return this.truncateToTokens(text, maxTokens);
    }
    
    // Split text into sentences
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
    
    // Score each sentence based on keyword matches
    const scoredSentences = sentences.map(sentence => {
      const lowerSentence = sentence.toLowerCase();
      let score = 0;
      
      for (const keyword of keywords) {
        const regex = new RegExp(`\\b${keyword}\\w*\\b`, 'gi');
        const matches = lowerSentence.match(regex);
        if (matches) {
          score += matches.length * 10; // Weight keyword matches heavily
        }
      }
      
      // Bonus for sentences with numbers (often contain useful data like dates, scores, times)
      if (/\d+/.test(sentence)) {
        score += 5;
      }
      
      return { sentence: sentence.trim(), score };
    });
    
    // Sort by score (highest first) and collect relevant content
    scoredSentences.sort((a, b) => b.score - a.score);
    
    let collectedText = '';
    const usedSentences = new Set<string>();
    
    // First pass: collect high-scoring sentences
    for (const item of scoredSentences) {
      if (item.score > 0 && !usedSentences.has(item.sentence)) {
        const potentialText = collectedText + (collectedText ? ' ' : '') + item.sentence;
        const tokenCount = this.estimateTokens(potentialText);
        
        if (tokenCount > maxTokens) {
          break;
        }
        
        collectedText = potentialText;
        usedSentences.add(item.sentence);
      }
    }
    
    // If we didn't collect enough content, add some context from the beginning
    if (this.estimateTokens(collectedText) < maxTokens * 0.5) {
      const beginningText = sentences.slice(0, 10).map(s => s.trim()).join(' ');
      const combined = beginningText + ' ... ' + collectedText;
      return this.truncateToTokens(combined, maxTokens);
    }
    
    return collectedText || this.truncateToTokens(text, maxTokens);
  }

  /**
   * Estimate token count (rough approximation: 1 token ≈ 4 characters)
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
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
