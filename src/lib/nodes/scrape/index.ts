/**
 * URL Scraping Node
 * 
 * Fetches and extracts text content from a webpage with detailed progress events:
 * 1. Validates the URL
 * 2. Fetches the HTML
 * 3. Parses and extracts clean text
 * 4. Returns content for chat node
 */

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { validateUrl, ValidationError } from './validator';
import { fetchAndParse } from './parser';

interface ScrapeNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // URL to scrape
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
  
  // Get URL from toolParam or extract from query
  const urlToScrape = state.toolParam || state.query?.message || '';

  // Create event publisher for real-time updates
  let publisher: any = null;
  if (redInstance?.messageQueue && messageId && conversationId) {
    publisher = createIntegratedPublisher(
      redInstance.messageQueue,
      'web_search', // Using web_search type for now, could add 'scrape' to ToolType
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
      message: `📄 Starting URL scrape`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'scrape_url',
        url: urlToScrape 
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
          await publisher.publishError({
            error: error.message,
          });
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
    // STEP 3: Fetch Page
    // ==========================================
    if (publisher) {
      await publisher.publishProgress(`Fetching ${validatedUrl.hostname}...`, {
        progress: 30,
        data: { hostname: validatedUrl.hostname },
      });
    }

    const parsed = await fetchAndParse(validatedUrl.toString());

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Page fetched: ${parsed.contentLength} characters`,
      conversationId,
      generationId,
      metadata: { 
        contentLength: parsed.contentLength,
        title: parsed.title 
      },
    });

    // ==========================================
    // STEP 4: Parse HTML
    // ==========================================
    if (publisher) {
      await publisher.publishProgress('Extracting text content...', {
        progress: 70,
        data: { 
          title: parsed.title,
          contentLength: parsed.contentLength 
        },
      });
    }

    const duration = Date.now() - startTime;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ URL scrape completed in ${(duration / 1000).toFixed(1)}s`,
      conversationId,
      generationId,
      metadata: { 
        duration,
        url: validatedUrl.toString(),
        title: parsed.title,
        textLength: parsed.text.length,
      },
    });

    if (publisher) {
      await publisher.publishComplete({
        result: `Extracted ${parsed.text.length} characters from ${validatedUrl.hostname}`,
        metadata: {
          duration,
          url: validatedUrl.toString(),
          title: parsed.title,
          contentLength: parsed.contentLength,
          textLength: parsed.text.length,
        },
      });
    }

    // ==========================================
    // STEP 5: Return Content for Chat
    // ==========================================
    const contextMessage = [
      `[INTERNAL CONTEXT - User cannot see this]`,
      `Content from ${validatedUrl.toString()}:`,
      parsed.title ? `\nTitle: ${parsed.title}` : '',
      `\n${parsed.text}`,
      `\nUse this information to answer the user's query.`,
    ].filter(Boolean).join('\n');

    return {
      messages: [new SystemMessage(contextMessage)],
      nextGraph: 'chat',
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
      await publisher.publishError({
        error: errorMessage,
      });
    }

    return {
      messages: [
        new SystemMessage(
          `[INTERNAL CONTEXT]\n` +
          `URL scraping failed: ${errorMessage}\n` +
          `Inform the user and offer to help in another way.`
        )
      ],
      nextGraph: 'chat',
    };
  }
}
