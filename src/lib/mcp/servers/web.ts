/**
 * Web MCP Server
 * Combines web search and URL scraping capabilities
 */

import { Redis } from 'ioredis';
import { McpServer } from '../server';
import { CallToolResult } from '../types';
import { McpEventPublisher } from '../event-publisher';
import { fetchAndParse } from '../../nodes/scrape/parser';

export class WebServer extends McpServer {
  private googleApiKey: string;
  private googleSearchEngineId: string;

  constructor(redis: Redis, googleApiKey?: string, googleSearchEngineId?: string) {
    super(redis, 'web', '1.0.0');
    this.googleApiKey = googleApiKey || process.env.GOOGLE_API_KEY || '';
    this.googleSearchEngineId = googleSearchEngineId || process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID || '';
    
    if (!this.googleApiKey || !this.googleSearchEngineId) {
      console.warn('[Web Server] Google API credentials not configured - search will not work');
    }
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    // Define web_search tool
    this.defineTool({
      name: 'web_search',
      description: 'Search the web using Google Custom Search API. Returns relevant web results for queries about current events, news, or any information that needs to be looked up online.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          },
          count: {
            type: 'number',
            description: 'Number of results to return (1-10, default: 10)'
          }
        },
        required: ['query']
      }
    });

    // Define scrape_url tool
    this.defineTool({
      name: 'scrape_url',
      description: 'Scrape and extract clean text content from a URL using custom content extraction. Returns the main content of the page without ads, navigation, or other clutter. Works with articles, documentation, blog posts, and most web pages.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The URL to scrape (must start with http:// or https://)'
          }
        },
        required: ['url']
      }
    });

    this.capabilities = {
      tools: {
        listChanged: false
      }
    };
  }

  /**
   * Execute tool
   */
  protected async executeTool(
    name: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    switch (name) {
      case 'web_search':
        return await this.searchWeb(args, meta);
      
      case 'scrape_url':
        return await this.scrapeUrl(args, meta);
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Perform web search
   */
  private async searchWeb(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const query = args.query as string;
    const count = Math.min((args.count as number) || 10, 10); // Google API limit is 10

    // Create event publisher (use publishRedis for events)
    const publisher = new McpEventPublisher(this.publishRedis, 'web_search', 'Web Search', meta);

    await publisher.publishStart({ input: { query, count } });
    await publisher.publishLog('info', `🔍 Web search: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}" (count=${count})`);

    if (!this.googleApiKey || !this.googleSearchEngineId) {
      const error = 'Google API credentials not configured';
      await publisher.publishError(error);
      await publisher.publishLog('error', `✗ ${error}`);
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error}`
        }],
        isError: true
      };
    }

    try {
      await publisher.publishProgress('Calling Google Custom Search API...', { progress: 30 });
      
      const url = new URL('https://www.googleapis.com/customsearch/v1');
      url.searchParams.set('key', this.googleApiKey);
      url.searchParams.set('cx', this.googleSearchEngineId);
      url.searchParams.set('q', query);
      url.searchParams.set('num', count.toString());

      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
        }
      });

      if (!response.ok) {
        const error = `Google API error: ${response.status} ${response.statusText}`;
        await publisher.publishError(error);
        await publisher.publishLog('error', `✗ ${error}`, { duration: publisher.getDuration() });
        throw new Error(error);
      }

      await publisher.publishProgress('Processing search results...', { progress: 60 });

      const data = await response.json() as any;
      
      // Format results from Google Custom Search
      const results = data.items || [];
      const duration = publisher.getDuration();
      
      await publisher.publishLog('info', `✓ Received ${results.length} results in ${duration}ms`);
      
      if (results.length === 0) {
        await publisher.publishComplete({ message: 'No results found' });
        await publisher.publishLog('warn', '⚠️ No results found');
        
        return {
          content: [{
            type: 'text',
            text: `No results found for query: ${query}`
          }]
        };
      }

      // Build formatted response
      let text = `Web Search Results for "${query}":\n\n`;
      
      for (const result of results) {
        text += `**${result.title}**\n`;
        text += `${result.link}\n`;
        text += `${result.snippet || ''}\n\n`;
      }

      await publisher.publishComplete({
        resultCount: results.length,
        resultLength: text.length
      }, {
        duration,
        protocol: 'MCP'
      });

      await publisher.publishLog('success', `✓ Complete - ${results.length} results, ${text.length} chars`, {
        duration,
        resultCount: results.length
      });

      return {
        content: [{
          type: 'text',
          text: text.trim()
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Web search failed: ${errorMessage}`, { duration });
      
      return {
        content: [{
          type: 'text',
          text: `Web search failed: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Scrape URL using custom parser
   */
  private async scrapeUrl(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const url = args.url as string;

    // Create event publisher (use publishRedis for events)
    const publisher = new McpEventPublisher(this.publishRedis, 'scrape_url', 'URL Scraper', meta);

    await publisher.publishStart({ input: { url } });
    await publisher.publishLog('info', `📄 Scraping URL: ${url}`);

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      const error = 'Invalid URL - must start with http:// or https://';
      await publisher.publishError(error);
      await publisher.publishLog('error', `✗ ${error}`);
      
      return {
        content: [{
          type: 'text',
          text: `Error: ${error}`
        }],
        isError: true
      };
    }

    try {
      await publisher.publishProgress('Fetching page...', { progress: 30 });
      
      // Use custom parser
      const parsed = await fetchAndParse(url);
      const duration = publisher.getDuration();

      await publisher.publishLog('info', `✓ Extracted ${parsed.contentLength} chars in ${duration}ms`);

      if (!parsed.text || parsed.text.trim().length === 0) {
        await publisher.publishComplete({ message: 'No content extracted' });
        await publisher.publishLog('warn', '⚠️ No content extracted');
        
        return {
          content: [{
            type: 'text',
            text: `No content could be extracted from ${url}`
          }]
        };
      }

      await publisher.publishProgress('Processing content...', { progress: 70 });

      // Format result with title if available
      let result = '';
      if (parsed.title) {
        result += `# ${parsed.title}\n\n`;
      }
      result += `Source: ${url}\n\n${parsed.text}`;

      await publisher.publishComplete({
        contentLength: result.length,
        title: parsed.title
      }, {
        duration,
        protocol: 'Custom Parser'
      });

      await publisher.publishLog('success', `✓ Complete - ${result.length} chars`, {
        duration,
        contentLength: result.length,
        title: parsed.title
      });

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Scraping failed: ${errorMessage}`, { duration });
      
      return {
        content: [{
          type: 'text',
          text: `Failed to scrape ${url}: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
}
