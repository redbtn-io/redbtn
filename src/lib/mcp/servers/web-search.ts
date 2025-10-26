/**
 * Web Search MCP Server
 * Provides web search capabilities via Brave Search API
 */

import { Redis } from 'ioredis';
import { McpServer } from '../server';
import { CallToolResult } from '../types';

export class WebSearchServer extends McpServer {
  private braveApiKey: string;

  constructor(redis: Redis, braveApiKey?: string) {
    super(redis, 'web-search', '1.0.0');
    this.braveApiKey = braveApiKey || process.env.BRAVE_API_KEY || '';
    
    if (!this.braveApiKey) {
      console.warn('[Web Search] No Brave API key provided - search will not work');
    }
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'web_search',
      description: 'Search the web using Brave Search API. Returns relevant web results for queries about current events, news, or any information that needs to be looked up online.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          },
          count: {
            type: 'number',
            description: 'Number of results to return (1-20, default: 5)'
          }
        },
        required: ['query']
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
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    if (name === 'web_search') {
      return await this.searchWeb(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Perform web search
   */
  private async searchWeb(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = args.query as string;
    const count = Math.min((args.count as number) || 5, 20);

    if (!this.braveApiKey) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Brave API key not configured'
        }],
        isError: true
      };
    }

    try {
      const response = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
        {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': this.braveApiKey
          }
        }
      );

      if (!response.ok) {
        throw new Error(`Brave API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      
      // Format results
      const results = data.web?.results || [];
      
      if (results.length === 0) {
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
        text += `${result.url}\n`;
        text += `${result.description || ''}\n\n`;
      }

      return {
        content: [{
          type: 'text',
          text: text.trim()
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      return {
        content: [{
          type: 'text',
          text: `Web search failed: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
}
