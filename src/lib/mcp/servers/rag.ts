/**
 * RAG MCP Server
 * Provides vector database operations for Retrieval-Augmented Generation
 */

import { Redis } from 'ioredis';
import { McpServer } from '../server';
import { CallToolResult } from '../types';
import { McpEventPublisher } from '../event-publisher';
import { VectorStoreManager, ChunkingConfig, SearchConfig } from '../../memory/vectors';

export class RagServer extends McpServer {
  private vectorStore: VectorStoreManager;
  private chromaUrl: string;
  private ollamaUrl: string;

  constructor(redis: Redis, chromaUrl?: string, ollamaUrl?: string) {
    super(redis, 'rag', '1.0.0');
    this.chromaUrl = chromaUrl || process.env.CHROMA_URL || 'http://localhost:8024';
    this.ollamaUrl = ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    
    // Initialize vector store manager
    this.vectorStore = new VectorStoreManager(this.chromaUrl, this.ollamaUrl);
    
    console.log('[RAG Server] Initialized with ChromaDB at', this.chromaUrl);
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    // Define add_document tool
    this.defineTool({
      name: 'add_document',
      description: 'Add a document to the vector database for semantic search. Automatically chunks large documents and generates embeddings. Use this to index knowledge that the AI can later retrieve.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The document text to add (will be automatically chunked if large)'
          },
          collection: {
            type: 'string',
            description: 'Collection name to add to (e.g., "documentation", "articles", "code")',
            default: 'general'
          },
          source: {
            type: 'string',
            description: 'Source identifier (URL, file path, or description)'
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata (title, author, date, category, etc.)',
            additionalProperties: true
          },
          chunkSize: {
            type: 'number',
            description: 'Chunk size in characters (default: 2000)',
            default: 2000
          },
          chunkOverlap: {
            type: 'number',
            description: 'Overlap between chunks in characters (default: 200)',
            default: 200
          }
        },
        required: ['text']
      }
    });

    // Define search_documents tool
    this.defineTool({
      name: 'search_documents',
      description: 'Search the vector database using semantic similarity. Returns the most relevant documents for a query. Use this to retrieve knowledge from previously indexed documents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (natural language question or keywords)'
          },
          collection: {
            type: 'string',
            description: 'Collection name to search in (default: "general")',
            default: 'general'
          },
          topK: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
            default: 5
          },
          threshold: {
            type: 'number',
            description: 'Minimum similarity threshold 0-1 (default: 0.7)',
            default: 0.7
          },
          filter: {
            type: 'object',
            description: 'Metadata filter to narrow results (e.g., {"category": "api"})',
            additionalProperties: true
          },
          mergeChunks: {
            type: 'boolean',
            description: 'Merge overlapping chunks from same source (default: true)',
            default: true
          }
        },
        required: ['query']
      }
    });

    // Define delete_documents tool
    this.defineTool({
      name: 'delete_documents',
      description: 'Delete documents from the vector database by ID or metadata filter. Use to remove outdated or incorrect information.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to delete from',
            default: 'general'
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of document IDs to delete'
          },
          filter: {
            type: 'object',
            description: 'Metadata filter for deletion (e.g., {"source": "old-url"})',
            additionalProperties: true
          }
        },
        required: ['collection']
      }
    });

    // Define list_collections tool
    this.defineTool({
      name: 'list_collections',
      description: 'List all available collections in the vector database. Use to discover what knowledge bases exist.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    });

    // Define get_collection_stats tool
    this.defineTool({
      name: 'get_collection_stats',
      description: 'Get statistics about a collection (document count, metadata). Use to check collection size and info.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name to get stats for',
            default: 'general'
          }
        },
        required: ['collection']
      }
    });
  }

  /**
   * Execute tool - implementation of abstract method
   */
  protected async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    switch (toolName) {
      case 'add_document':
        return this.addDocument(args, meta);
      case 'search_documents':
        return this.searchDocuments(args, meta);
      case 'delete_documents':
        return this.deleteDocuments(args, meta);
      case 'list_collections':
        return this.listCollections(args, meta);
      case 'get_collection_stats':
        return this.getCollectionStats(args, meta);
      default:
        return {
          content: [{
            type: 'text',
            text: `Unknown tool: ${toolName}`
          }],
          isError: true
        };
    }
  }

  /**
   * Add document to vector database
   */
  private async addDocument(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const text = args.text as string;
    const collection = (args.collection as string) || 'general';
    const source = (args.source as string) || 'unknown';
    const metadata = (args.metadata as Record<string, any>) || {};
    const chunkSize = (args.chunkSize as number) || 2000;
    const chunkOverlap = (args.chunkOverlap as number) || 200;

    // Create event publisher
    const publisher = new McpEventPublisher(this.publishRedis, 'rag_add', 'RAG Add Document', meta);

    await publisher.publishStart({ input: { textLength: text.length, collection, source } });
    await publisher.publishLog('info', `📚 Adding document to collection: ${collection}`);

    if (!text || text.trim().length === 0) {
      const error = 'No text provided';
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
      // Health check
      await publisher.publishProgress('Checking vector database connection...', { progress: 10 });
      const isHealthy = await this.vectorStore.healthCheck();
      
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible. Check connection.');
      }

      // Prepare metadata
      await publisher.publishProgress('Preparing document metadata...', { progress: 20 });
      const fullMetadata = {
        ...metadata,
        source,
        addedAt: Date.now(),
        conversationId: meta?.conversationId,
        generationId: meta?.generationId
      };

      // Prepare chunking config
      const chunkingConfig: ChunkingConfig = {
        chunkSize,
        chunkOverlap,
        preserveParagraphs: true
      };

      // Add document (this will automatically chunk and embed)
      await publisher.publishProgress('Chunking and embedding document...', { progress: 40 });
      const chunksAdded = await this.vectorStore.addDocument(
        collection,
        text,
        fullMetadata,
        chunkingConfig
      );

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Document added: ${chunksAdded} chunks in ${duration}ms`);
      await publisher.publishComplete({
        chunksAdded,
        collection,
        duration
      });

      const result = `Successfully added document to collection "${collection}".\n\n` +
                    `- Text length: ${text.length} characters\n` +
                    `- Chunks created: ${chunksAdded}\n` +
                    `- Source: ${source}\n` +
                    `- Duration: ${duration}ms`;

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to add document: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to add document: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Search documents in vector database
   */
  private async searchDocuments(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const query = args.query as string;
    const collection = (args.collection as string) || 'general';
    const topK = (args.topK as number) || 5;
    const threshold = (args.threshold as number) || 0.7;
    const filter = args.filter as Record<string, any> | undefined;
    const mergeChunks = args.mergeChunks !== false; // Default: true

    // Create event publisher
    const publisher = new McpEventPublisher(this.publishRedis, 'rag_search', 'RAG Search', meta);

    await publisher.publishStart({ input: { query: query.substring(0, 100), collection } });
    await publisher.publishLog('info', `🔍 Searching collection: ${collection}`);

    if (!query || query.trim().length === 0) {
      const error = 'No query provided';
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
      // Health check
      await publisher.publishProgress('Checking vector database connection...', { progress: 10 });
      const isHealthy = await this.vectorStore.healthCheck();
      
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible. Check connection.');
      }

      // Prepare search config
      await publisher.publishProgress('Generating query embedding...', { progress: 30 });
      const searchConfig: SearchConfig = {
        topK,
        threshold,
        filter
      };

      // Perform search
      await publisher.publishProgress('Searching for relevant documents...', { progress: 60 });
      const results = await this.vectorStore.search(
        collection,
        query,
        searchConfig
      );

      // Merge chunks if requested
      let processedResults = results;
      if (mergeChunks && results.length > 0) {
        await publisher.publishProgress('Merging overlapping chunks...', { progress: 80 });
        processedResults = this.groupAndMergeResults(results);
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Search complete: ${processedResults.length} results in ${duration}ms`);
      await publisher.publishComplete({
        resultsCount: processedResults.length,
        duration
      });

      // Format results
      if (processedResults.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No relevant documents found in collection "${collection}" for query: "${query}"`
          }]
        };
      }

      // Build formatted response
      let resultText = `# Search Results for: "${query}"\n\n`;
      resultText += `Found ${processedResults.length} relevant document(s) in collection "${collection}":\n\n`;

      for (let i = 0; i < processedResults.length; i++) {
        const result = processedResults[i];
        const relevance = (result.score * 100).toFixed(1);
        const source = result.metadata?.source || 'unknown';
        const mergedCount = result.metadata?.mergedChunks;
        const mergeInfo = mergedCount > 1 ? ` (${mergedCount} chunks merged)` : '';

        resultText += `## Result ${i + 1} - ${relevance}% relevant${mergeInfo}\n`;
        resultText += `**Source:** ${source}\n\n`;
        resultText += `${result.text}\n\n`;
        resultText += `---\n\n`;
      }

      return {
        content: [{
          type: 'text',
          text: resultText
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Search failed: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Search failed: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Group results by source and merge overlapping chunks
   */
  private groupAndMergeResults(results: Array<any>): Array<any> {
    // Group by source
    const groupedBySource = new Map<string, Array<any>>();
    
    for (const result of results) {
      const source = result.metadata?.source || 'unknown';
      if (!groupedBySource.has(source)) {
        groupedBySource.set(source, []);
      }
      groupedBySource.get(source)!.push(result);
    }

    // Merge chunks from the same source
    const mergedResults: Array<any> = [];
    
    for (const [source, sourceResults] of groupedBySource) {
      // Sort by chunk index if available
      sourceResults.sort((a, b) => {
        const aIndex = a.metadata?.chunkIndex ?? -1;
        const bIndex = b.metadata?.chunkIndex ?? -1;
        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        return b.score - a.score;
      });

      // Extract text chunks
      const textChunks = sourceResults.map(r => r.text);
      
      // Merge overlapping chunks
      const mergedText = this.mergeOverlappingChunks(textChunks);
      
      // Calculate average score
      const avgScore = sourceResults.reduce((sum, r) => sum + r.score, 0) / sourceResults.length;
      
      // Create merged result
      mergedResults.push({
        id: sourceResults[0].id,
        text: mergedText,
        metadata: {
          ...sourceResults[0].metadata,
          mergedChunks: sourceResults.length,
          avgScore
        },
        score: avgScore,
        distance: sourceResults[0].distance
      });
    }

    // Sort by score
    mergedResults.sort((a, b) => b.score - a.score);
    
    return mergedResults;
  }

  /**
   * Merge overlapping text chunks
   */
  private mergeOverlappingChunks(chunks: string[]): string {
    if (chunks.length === 0) return '';
    if (chunks.length === 1) return chunks[0];

    let merged = chunks[0];

    for (let i = 1; i < chunks.length; i++) {
      const currentChunk = chunks[i];
      let bestOverlapLength = 0;
      
      const minOverlap = 50;
      const maxOverlap = Math.floor(Math.min(merged.length, currentChunk.length) * 0.8);
      
      for (let overlapLen = maxOverlap; overlapLen >= minOverlap; overlapLen--) {
        const endOfMerged = merged.slice(-overlapLen);
        const startOfCurrent = currentChunk.slice(0, overlapLen);
        
        if (endOfMerged === startOfCurrent) {
          bestOverlapLength = overlapLen;
          break;
        }
      }

      if (bestOverlapLength > 0) {
        merged += currentChunk.slice(bestOverlapLength);
      } else {
        merged += '\n\n' + currentChunk;
      }
    }

    return merged;
  }

  /**
   * Delete documents from vector database
   */
  private async deleteDocuments(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const collection = (args.collection as string) || 'general';
    const ids = args.ids as string[] | undefined;
    const filter = args.filter as Record<string, any> | undefined;

    // Create event publisher
    const publisher = new McpEventPublisher(this.publishRedis, 'rag_delete', 'RAG Delete', meta);

    await publisher.publishStart({ input: { collection, idsCount: ids?.length } });
    await publisher.publishLog('info', `🗑️ Deleting from collection: ${collection}`);

    if (!ids && !filter) {
      const error = 'Must provide either ids or filter for deletion';
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
      // Health check
      await publisher.publishProgress('Checking vector database connection...', { progress: 10 });
      const isHealthy = await this.vectorStore.healthCheck();
      
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible. Check connection.');
      }

      let deletedCount = 0;

      if (ids && ids.length > 0) {
        await publisher.publishProgress(`Deleting ${ids.length} documents by ID...`, { progress: 50 });
        deletedCount = await this.vectorStore.deleteDocuments(collection, ids);
      } else if (filter) {
        await publisher.publishProgress('Deleting documents by filter...', { progress: 50 });
        deletedCount = await this.vectorStore.deleteByFilter(collection, filter);
      }

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Deletion complete in ${duration}ms`);
      await publisher.publishComplete({ deletedCount, duration });

      const result = `Successfully deleted documents from collection "${collection}".\n\n` +
                    `- Deleted count: ${deletedCount || 'unknown'}\n` +
                    `- Method: ${ids ? 'by ID' : 'by filter'}\n` +
                    `- Duration: ${duration}ms`;

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Deletion failed: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to delete documents: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * List all collections
   */
  private async listCollections(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    // Create event publisher
    const publisher = new McpEventPublisher(this.publishRedis, 'rag_list', 'RAG List Collections', meta);

    await publisher.publishStart({});
    await publisher.publishLog('info', '📋 Listing collections');

    try {
      // Health check
      await publisher.publishProgress('Checking vector database connection...', { progress: 10 });
      const isHealthy = await this.vectorStore.healthCheck();
      
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible. Check connection.');
      }

      await publisher.publishProgress('Fetching collections...', { progress: 50 });
      const collections = await this.vectorStore.listCollections();

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Found ${collections.length} collections in ${duration}ms`);
      await publisher.publishComplete({ collectionsCount: collections.length, duration });

      if (collections.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No collections found in the vector database.'
          }]
        };
      }

      const result = `# Available Collections\n\n` +
                    `Found ${collections.length} collection(s):\n\n` +
                    collections.map((name, i) => `${i + 1}. ${name}`).join('\n');

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to list collections: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to list collections: ${errorMessage}`
        }],
        isError: true
      };
    }
  }

  /**
   * Get collection statistics
   */
  private async getCollectionStats(
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    const collection = (args.collection as string) || 'general';

    // Create event publisher
    const publisher = new McpEventPublisher(this.publishRedis, 'rag_stats', 'RAG Collection Stats', meta);

    await publisher.publishStart({ input: { collection } });
    await publisher.publishLog('info', `📊 Getting stats for collection: ${collection}`);

    try {
      // Health check
      await publisher.publishProgress('Checking vector database connection...', { progress: 10 });
      const isHealthy = await this.vectorStore.healthCheck();
      
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible. Check connection.');
      }

      await publisher.publishProgress('Fetching collection stats...', { progress: 50 });
      const stats = await this.vectorStore.getCollectionStats(collection);

      const duration = publisher.getDuration();

      await publisher.publishLog('success', `✓ Stats retrieved in ${duration}ms`);
      await publisher.publishComplete({ stats, duration });

      const result = `# Collection Statistics: "${collection}"\n\n` +
                    `- Document count: ${stats.count}\n` +
                    `- Metadata: ${JSON.stringify(stats.metadata, null, 2)}`;

      return {
        content: [{
          type: 'text',
          text: result
        }]
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const duration = publisher.getDuration();
      
      await publisher.publishError(errorMessage);
      await publisher.publishLog('error', `✗ Failed to get stats: ${errorMessage}`, { duration });

      return {
        content: [{
          type: 'text',
          text: `Failed to get collection stats: ${errorMessage}`
        }],
        isError: true
      };
    }
  }
}
