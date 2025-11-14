/**
 * Web MCP Server - SSE Transport
 * Combines web search and URL scraping capabilities
 */

import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
import { McpEventPublisher } from '../event-publisher';
import { fetchAndParse } from '../../nodes/scrape/parser';

export class WebServerSSE extends McpServerSSE {
  private googleApiKey: string;
  private googleSearchEngineId: string;

  constructor(name: string, version: string, port: number = 3001, googleApiKey?: string, googleSearchEngineId?: string) {
    super(name, version, port, '/mcp');
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
        return await this.executeWebSearch(args, meta);
      
      case 'scrape_url':
        return await this.executeScrapeUrl(args, meta);
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Execute web_search tool
   */
  private async executeWebSearch(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const query = args.query as string;
    const count = (args.count as number) || 10;

    if (!this.googleApiKey || !this.googleSearchEngineId) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Google API credentials not configured',
            results: []
          })
        }],
        isError: true
      };
    }

    try {
      const url = `https://www.googleapis.com/customsearch/v1?key=${this.googleApiKey}&cx=${this.googleSearchEngineId}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Google API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      
      const results = (data.items || []).map((item: any) => ({
        title: item.title,
        link: item.link,
        snippet: item.snippet,
        displayLink: item.displayLink
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            query,
            searchEngine: 'Google Custom Search',
            totalResults: data.searchInformation?.totalResults || '0',
            results
          })
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            results: []
          })
        }],
        isError: true
      };
    }
  }

  /**
   * Execute scrape_url tool
   */
  private async executeScrapeUrl(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const url = args.url as string;

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: 'Invalid URL: must start with http:// or https://',
            url
          })
        }],
        isError: true
      };
    }

    try {
      const result = await fetchAndParse(url);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            url,
            title: result.title,
            content: result.text,
            contentLength: result.contentLength
          })
        }]
      };

    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            url
          })
        }],
        isError: true
      };
    }
  }
}
