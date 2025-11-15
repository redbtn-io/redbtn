/**
 * URL Scraper MCP Server
 * Provides web scraping capabilities using Jina AI Reader
 */

import { Redis } from 'ioredis';
import { McpServer } from '../server';
import { CallToolResult } from '../types';

export class UrlScraperServer extends McpServer {
  constructor(redis: Redis) {
    super(redis, 'url-scraper', '1.0.0');
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'scrape_url',
      description: 'Scrape and extract clean text content from a URL. Returns the main content of the page without ads, navigation, or other clutter. Works with articles, documentation, blog posts, and most web pages.',
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
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    if (name === 'scrape_url') {
      return await this.scrapeUrl(args);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  /**
   * Scrape URL
   */
  private async scrapeUrl(args: Record<string, unknown>): Promise<CallToolResult> {
    const url = args.url as string;

    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Invalid URL - must start with http:// or https://'
        }],
        isError: true
      };
    }

    try {
      // Use Jina AI Reader API
      const jinaUrl = `https://r.jina.ai/${url}`;
      const response = await fetch(jinaUrl, {
        headers: {
          'Accept': 'text/plain',
          'X-Return-Format': 'markdown'
        }
      });

      if (!response.ok) {
        throw new Error(`Jina API error: ${response.status} ${response.statusText}`);
      }

      const content = await response.text();

      if (!content || content.trim().length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No content could be extracted from ${url}`
          }]
        };
      }

      // Add metadata
      const result = `# Content from ${url}\n\n${content}`;

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
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
