/**
 * URL Scraping Node
 * 
 * Fetches and extracts text content from a webpage via MCP with detailed progress events:
 * 1. Validates the URL
 * 2. Calls scrape_url MCP tool (Jina AI Reader)
 * 3. Returns content for chat node
 * 
 * Note: This node now uses the MCP (Model Context Protocol) web server
 * instead of direct scraping for better architecture and reusability.
 */

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { validateUrl, ValidationError } from './validator';
import { getNodeSystemPrefix } from '../../utils/node-helpers';

interface ScrapeNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // URL to scrape
  contextMessages?: any[]; // Pre-loaded context from router
  nodeNumber?: number; // Current node position in graph
}

/**
 * Main scrape node function
 */
export async function scrapeNode(state: ScrapeNodeState): Promise<Partial<any>> {
  const startTime = Date.now();
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  const currentNodeNumber = state.nodeNumber || 2; // If not set, default to 2
  const nextNodeNumber = currentNodeNumber + 1; // Responder will be next
  
  // Get URL from toolParam or extract from query
  const urlToScrape = state.toolParam || state.query?.message || '';

  // Create event publisher for real-time updates
  let publisher: any = null;
  if (redInstance?.messageQueue && messageId && conversationId) {
    publisher = createIntegratedPublisher(
      redInstance.messageQueue,
      'scrape', // Changed from 'web_search' to match frontend expectations
      'URL Scraper',
      messageId,
      conversationId
    );
  }

  try {
    // ==========================================
    // STEP 1: Start & Log
    // ==========================================
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `📄 Starting URL scrape via MCP`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'scrape_url',
        url: urlToScrape,
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishStart({
        input: { url: urlToScrape },
        expectedDuration: 5000, // ~5 seconds
      });
    }

    // ==========================================
    // STEP 2: Validate URL
    // ==========================================
    if (publisher) {
      await publisher.publishProgress('Validating URL...', { progress: 10 });
    }

    let validatedUrl: URL;
    try {
      validatedUrl = validateUrl(urlToScrape);
    } catch (error) {
      if (error instanceof ValidationError) {
        await redInstance.logger.log({
          level: 'error',
          category: 'tool',
          message: `✗ Invalid URL: ${error.message}`,
          conversationId,
          generationId,
          metadata: { error: error.message },
        });

        if (publisher) {
          await publisher.publishError(error.message);
        }

        return {
          messages: [
            new SystemMessage(
              `[INTERNAL CONTEXT]\n` +
              `URL validation failed: ${error.message}\n` +
              `Inform the user the URL is invalid.`
            )
          ],
          nextGraph: 'chat',
        };
      }
      throw error;
    }

    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `✓ URL validated: ${validatedUrl.hostname}`,
      conversationId,
      generationId,
      metadata: { 
        hostname: validatedUrl.hostname,
        protocol: validatedUrl.protocol 
      },
    });

    // ==========================================
    // STEP 3: Call MCP scrape_url Tool
    // ==========================================
    if (publisher) {
      await publisher.publishProgress(`Scraping ${validatedUrl.hostname} via MCP...`, {
        progress: 40,
        data: { hostname: validatedUrl.hostname },
      });
    }

    const scrapeResult = await redInstance.callMcpTool('scrape_url', {
      url: validatedUrl.toString()
    }, {
      conversationId,
      generationId,
      messageId
    });

    // Check for errors
    if (scrapeResult.isError) {
      throw new Error(scrapeResult.content[0]?.text || 'Scraping failed');
    }

    const scrapedContent = scrapeResult.content[0]?.text || '';

    if (!scrapedContent || scrapedContent.includes('No content could be extracted')) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'tool',
        message: `⚠️ No content extracted from URL`,
        conversationId,
        generationId,
      });

      if (publisher) {
        await publisher.publishComplete({
          result: 'No content extracted',
          metadata: { contentLength: 0 },
        });
      }

      return {
        messages: [
          new SystemMessage(
            `[INTERNAL CONTEXT]\n` +
            `Could not extract content from ${validatedUrl.toString()}\n` +
            `Inform the user.`
          )
        ],
        nextGraph: 'chat',
      };
    }

    const duration = Date.now() - startTime;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ URL scrape completed via MCP in ${(duration / 1000).toFixed(1)}s`,
      conversationId,
      generationId,
      metadata: { 
        duration,
        url: validatedUrl.toString(),
        contentLength: scrapedContent.length,
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishComplete({
        result: `Extracted ${scrapedContent.length} characters from ${validatedUrl.hostname}`,
        metadata: {
          duration,
          url: validatedUrl.toString(),
          contentLength: scrapedContent.length,
          protocol: 'MCP',
        },
      });
    }

    // ==========================================
    // STEP 4: Build Context with Scraped Content
    // ==========================================
    const messages: any[] = [];
    
    // Add system message
    const systemMessage = `${getNodeSystemPrefix(currentNodeNumber, 'Scrape')}

CRITICAL RULES:
1. Use the webpage content provided to answer the user's query
2. Be direct, helpful, and conversational`;

    messages.push({ role: 'system', content: systemMessage });
    
    // Use pre-loaded context from router (no need to load again)
    if (state.contextMessages && state.contextMessages.length > 0) {
      // Filter out the current user message
      const userQuery = state.query?.message || '';
      const filteredMessages = state.contextMessages.filter((msg: any) => 
        !(msg.role === 'user' && msg.content === userQuery)
      );
      
      messages.push(...filteredMessages);
    }
    
    // Add the user's query with scraped content in brackets
    const userQuery = state.query?.message || '';
    const userQueryWithContent = `${userQuery}\n\n[Webpage Content: ${scrapedContent}]`;
    messages.push({
      role: 'user',
      content: userQueryWithContent
    });

    return {
      messages,
      nextGraph: 'responder',
      nodeNumber: nextNodeNumber
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;
    
    await redInstance.logger.log({
      level: 'error',
      category: 'tool',
      message: `✗ URL scrape failed: ${errorMessage}`,
      conversationId,
      generationId,
      metadata: { 
        error: errorMessage,
        duration,
        url: urlToScrape 
      },
    });

    if (publisher) {
      await publisher.publishError(errorMessage);
    }

    return {
      messages: [
        {
          role: 'system',
          content: `You are Red, an AI assistant. URL scraping failed: ${errorMessage}. Inform the user and offer to help in another way.`
        },
        {
          role: 'user',
          content: state.query?.message || ''
        }
      ],
      nextGraph: 'responder',
      nodeNumber: nextNodeNumber
    };
  }
}
