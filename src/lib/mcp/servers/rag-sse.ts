/**
 * RAG MCP Server (SSE Transport)
 * Provides vector database operations via HTTP/SSE
 */

import express from 'express';
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
import { VectorStoreManager, ChunkingConfig, SearchConfig } from '../../memory/vectors';

export class RagServerSSE extends McpServerSSE {
  private vectorStore: VectorStoreManager;
  private chromaUrl: string;
  private ollamaUrl: string;

  constructor(name: string, version: string, port: number = 3003, chromaUrl?: string, ollamaUrl?: string) {
    super(name, version, port);
    this.chromaUrl = chromaUrl || process.env.CHROMA_URL || 'http://localhost:8024';
    this.ollamaUrl = ollamaUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    
    // Initialize vector store manager
    this.vectorStore = new VectorStoreManager(this.chromaUrl, this.ollamaUrl);
    
    console.log('[RAG Server SSE] Initialized with ChromaDB at', this.chromaUrl);
  }

  /**
   * Setup tools
   */
  protected async setup(): Promise<void> {
    // Define add_document tool
    this.defineTool({
      name: 'add_document',
      description: 'Add a document to the vector database for semantic search. Automatically chunks large documents and generates embeddings.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The document text to add (will be automatically chunked if large)'
          },
          collection: {
            type: 'string',
            description: 'Collection name to add to (e.g., "documentation", "articles")',
            default: 'general'
          },
          source: {
            type: 'string',
            description: 'Source identifier (URL, file path, or description)'
          },
          metadata: {
            type: 'object',
            description: 'Additional metadata (title, author, date, etc.)',
            additionalProperties: true
          },
          chunkSize: {
            type: 'number',
            description: 'Chunk size in characters (default: 2000)',
            default: 2000
          },
          chunkOverlap: {
            type: 'number',
            description: 'Overlap between chunks (default: 200)',
            default: 200
          }
        },
        required: ['text']
      }
    });

    // Define search_documents tool
    this.defineTool({
      name: 'search_documents',
      description: 'Search the vector database using semantic similarity. Returns the most relevant documents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query (natural language)'
          },
          collection: {
            type: 'string',
            description: 'Collection name to search (default: "general")',
            default: 'general'
          },
          topK: {
            type: 'number',
            description: 'Maximum results to return (default: 5)',
            default: 5
          },
          threshold: {
            type: 'number',
            description: 'Minimum similarity threshold 0-1 (default: 0.7)',
            default: 0.7
          },
          filter: {
            type: 'object',
            description: 'Metadata filter (e.g., {"category": "api"})',
            additionalProperties: true
          },
          mergeChunks: {
            type: 'boolean',
            description: 'Merge overlapping chunks (default: true)',
            default: true
          }
        },
        required: ['query']
      }
    });

    // Define delete_documents tool
    this.defineTool({
      name: 'delete_documents',
      description: 'Delete documents from the vector database by ID or filter.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name',
            default: 'general'
          },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of document IDs to delete'
          },
          filter: {
            type: 'object',
            description: 'Metadata filter for deletion',
            additionalProperties: true
          }
        },
        required: ['collection']
      }
    });

    // Define list_collections tool
    this.defineTool({
      name: 'list_collections',
      description: 'List all available collections in the vector database.',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    });

    // Define get_collection_stats tool
    this.defineTool({
      name: 'get_collection_stats',
      description: 'Get statistics about a collection (document count, metadata).',
      inputSchema: {
        type: 'object',
        properties: {
          collection: {
            type: 'string',
            description: 'Collection name',
            default: 'general'
          }
        },
        required: ['collection']
      }
    });
  }

  /**
   * Execute tool
   */
  protected async executeTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CallToolResult> {
    switch (toolName) {
      case 'add_document':
        return this.addDocument(args);
      case 'search_documents':
        return this.searchDocuments(args);
      case 'delete_documents':
        return this.deleteDocuments(args);
      case 'list_collections':
        return this.listCollections();
      case 'get_collection_stats':
        return this.getCollectionStats(args);
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true
        };
    }
  }

  /**
   * Add document to vector database
   */
  private async addDocument(args: Record<string, unknown>): Promise<CallToolResult> {
    const text = args.text as string;
    const collection = (args.collection as string) || 'general';
    const source = (args.source as string) || 'unknown';
    const metadata = (args.metadata as Record<string, any>) || {};
    const chunkSize = (args.chunkSize as number) || 2000;
    const chunkOverlap = (args.chunkOverlap as number) || 200;

    if (!text || text.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No text provided' }],
        isError: true
      };
    }

    try {
      const isHealthy = await this.vectorStore.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      const fullMetadata = {
        ...metadata,
        source,
        addedAt: Date.now()
      };

      const chunkingConfig: ChunkingConfig = {
        chunkSize,
        chunkOverlap,
        preserveParagraphs: true
      };

      const chunksAdded = await this.vectorStore.addDocument(
        collection,
        text,
        fullMetadata,
        chunkingConfig
      );

      const result = `Successfully added document to collection "${collection}".\n` +
                    `- Text length: ${text.length} characters\n` +
                    `- Chunks created: ${chunksAdded}\n` +
                    `- Source: ${source}`;

      return {
        content: [{ type: 'text', text: result }]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to add document: ${msg}` }],
        isError: true
      };
    }
  }

  /**
   * Search documents
   */
  private async searchDocuments(args: Record<string, unknown>): Promise<CallToolResult> {
    const query = args.query as string;
    const collection = (args.collection as string) || 'general';
    const topK = (args.topK as number) || 5;
    const threshold = (args.threshold as number) || 0.7;
    const filter = args.filter as Record<string, any> | undefined;
    const mergeChunks = args.mergeChunks !== false;

    if (!query || query.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No query provided' }],
        isError: true
      };
    }

    try {
      const isHealthy = await this.vectorStore.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      const searchConfig: SearchConfig = { topK, threshold, filter };
      const results = await this.vectorStore.search(collection, query, searchConfig);

      let processedResults = results;
      if (mergeChunks && results.length > 0) {
        processedResults = this.groupAndMergeResults(results);
      }

      if (processedResults.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No relevant documents found in collection "${collection}" for query: "${query}"`
          }]
        };
      }

      let resultText = `# Search Results for: "${query}"\n\n` +
                      `Found ${processedResults.length} relevant document(s) in collection "${collection}":\n\n`;

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
        content: [{ type: 'text', text: resultText }]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Search failed: ${msg}` }],
        isError: true
      };
    }
  }

  /**
   * Group and merge results by source
   */
  private groupAndMergeResults(results: Array<any>): Array<any> {
    const groupedBySource = new Map<string, Array<any>>();
    
    for (const result of results) {
      const source = result.metadata?.source || 'unknown';
      if (!groupedBySource.has(source)) {
        groupedBySource.set(source, []);
      }
      groupedBySource.get(source)!.push(result);
    }

    const mergedResults: Array<any> = [];
    
    for (const [source, sourceResults] of groupedBySource) {
      sourceResults.sort((a, b) => {
        const aIndex = a.metadata?.chunkIndex ?? -1;
        const bIndex = b.metadata?.chunkIndex ?? -1;
        if (aIndex !== -1 && bIndex !== -1) {
          return aIndex - bIndex;
        }
        return b.score - a.score;
      });

      const textChunks = sourceResults.map(r => r.text);
      const mergedText = this.mergeOverlappingChunks(textChunks);
      const avgScore = sourceResults.reduce((sum, r) => sum + r.score, 0) / sourceResults.length;
      
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
   * Delete documents
   */
  private async deleteDocuments(args: Record<string, unknown>): Promise<CallToolResult> {
    const collection = (args.collection as string) || 'general';
    const ids = args.ids as string[] | undefined;
    const filter = args.filter as Record<string, any> | undefined;

    if (!ids && !filter) {
      return {
        content: [{ type: 'text', text: 'Error: Must provide either ids or filter for deletion' }],
        isError: true
      };
    }

    try {
      const isHealthy = await this.vectorStore.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      let deletedCount = 0;

      if (ids && ids.length > 0) {
        deletedCount = await this.vectorStore.deleteDocuments(collection, ids);
      } else if (filter) {
        deletedCount = await this.vectorStore.deleteByFilter(collection, filter);
      }

      const result = `Successfully deleted documents from collection "${collection}".\n` +
                    `- Deleted count: ${deletedCount || 'unknown'}\n` +
                    `- Method: ${ids ? 'by ID' : 'by filter'}`;

      return {
        content: [{ type: 'text', text: result }]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to delete documents: ${msg}` }],
        isError: true
      };
    }
  }

  /**
   * List collections
   */
  private async listCollections(): Promise<CallToolResult> {
    try {
      const isHealthy = await this.vectorStore.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      const collections = await this.vectorStore.listCollections();

      if (collections.length === 0) {
        return {
          content: [{ type: 'text', text: 'No collections found in the vector database.' }]
        };
      }

      const result = `# Available Collections\n\n` +
                    `Found ${collections.length} collection(s):\n\n` +
                    collections.map((name, i) => `${i + 1}. ${name}`).join('\n');

      return {
        content: [{ type: 'text', text: result }]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to list collections: ${msg}` }],
        isError: true
      };
    }
  }

  /**
   * Get collection stats
   */
  private async getCollectionStats(args: Record<string, unknown>): Promise<CallToolResult> {
    const collection = (args.collection as string) || 'general';

    try {
      const isHealthy = await this.vectorStore.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      const stats = await this.vectorStore.getCollectionStats(collection);

      const result = `# Collection Statistics: "${collection}"\n\n` +
                    `- Document count: ${stats.count}\n` +
                    `- Metadata: ${JSON.stringify(stats.metadata, null, 2)}`;

      return {
        content: [{ type: 'text', text: result }]
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `Failed to get collection stats: ${msg}` }],
        isError: true
      };
    }
  }
}
