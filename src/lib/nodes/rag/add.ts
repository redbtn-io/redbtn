/**
 * @file src/lib/nodes/rag/add.ts
 * @description LangGraph node for adding documents to the vector store
 * 
 * This node handles:
 * - Adding new documents to ChromaDB collections
 * - Automatic text chunking with configurable size/overlap
 * - Embedding generation using Ollama
 * - Metadata attachment for filtering and tracking
 * - Token validation before embedding
 * 
 * Input state requirements:
 * - ragDocument: { text: string, source?: string, metadata?: object }
 * - ragCollection: string (collection name, defaults to 'general')
 * - ragChunkingConfig?: { chunkSize?: number, chunkOverlap?: number, preserveParagraphs?: boolean }
 * 
 * Output state:
 * - ragResult: { success: boolean, chunksAdded: number, collectionName: string, error?: string }
 */

import { VectorStoreManager, ChunkingConfig } from '../../memory/vectors';
import { InvokeOptions } from '../../../index';

/**
 * State interface for the add node
 */
interface AddToVectorStoreState {
  // Input: document to add
  ragDocument?: {
    text: string;
    source?: string;
    metadata?: Record<string, any>;
  };
  
  // Input: collection name (defaults to 'general')
  ragCollection?: string;
  
  // Input: optional chunking configuration
  ragChunkingConfig?: ChunkingConfig;
  
  // Output: operation result
  ragResult?: {
    success: boolean;
    chunksAdded: number;
    collectionName: string;
    documentIds?: string[];
    error?: string;
  };
  
  // Standard graph state
  options?: InvokeOptions;
  redInstance?: any;
  messages?: any[];
}

/**
 * Node for adding documents to the vector store
 * 
 * Usage in graph:
 * ```typescript
 * .addNode("addToVectorStore", addToVectorStoreNode)
 * ```
 * 
 * Example state:
 * ```typescript
 * {
 *   ragDocument: {
 *     text: "Long document content...",
 *     source: "https://example.com/article",
 *     metadata: {
 *       title: "Example Article",
 *       author: "John Doe",
 *       date: "2025-10-22"
 *     }
 *   },
 *   ragCollection: "articles",
 *   ragChunkingConfig: {
 *     chunkSize: 1500,
 *     chunkOverlap: 150,
 *     preserveParagraphs: true
 *   }
 * }
 * ```
 */
export const addToVectorStoreNode = async (
  state: AddToVectorStoreState
): Promise<Partial<AddToVectorStoreState>> => {
  const redInstance = state.redInstance;
  const options = state.options || {};
  const generationId = options.generationId;
  const conversationId = options.conversationId;

  try {
    // Validate input
    if (!state.ragDocument || !state.ragDocument.text) {
      throw new Error('No document provided in ragDocument.text');
    }

    const { text, source, metadata = {} } = state.ragDocument;
    const collectionName = state.ragCollection || 'general';
    const chunkingConfig = state.ragChunkingConfig || {};

    // Log operation start
    if (redInstance?.logger) {
      await redInstance.logger.log({
        level: 'info',
        category: 'rag',
        message: `<cyan>📚 Adding document to vector store...</cyan>`,
        generationId,
        conversationId,
        metadata: {
          collection: collectionName,
          textLength: text.length,
          source
        }
      });
    }

    // Initialize vector store manager
    const vectorStore = new VectorStoreManager(
      redInstance?.config?.vectorDbUrl || process.env.CHROMA_URL || 'http://localhost:8024',
      redInstance?.config?.chatLlmUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    );

    // Health check
    const isHealthy = await vectorStore.healthCheck();
    if (!isHealthy) {
      throw new Error('ChromaDB is not accessible. Check connection.');
    }

    // Prepare metadata
    const fullMetadata = {
      ...metadata,
      source: source || 'unknown',
      addedAt: Date.now(),
      conversationId,
      generationId
    };

    // Add document (this will automatically chunk it)
    const chunksAdded = await vectorStore.addDocument(
      collectionName,
      text,
      fullMetadata,
      chunkingConfig
    );

    // Log success
    if (redInstance?.logger) {
      await redInstance.logger.log({
        level: 'success',
        category: 'rag',
        message: `<green>✓ Document added to vector store</green> <dim>(${chunksAdded} chunks, collection: ${collectionName})</dim>`,
        generationId,
        conversationId,
        metadata: {
          collection: collectionName,
          chunksAdded,
          textLength: text.length
        }
      });
    }

    return {
      ragResult: {
        success: true,
        chunksAdded,
        collectionName
      }
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Log error
    if (redInstance?.logger) {
      await redInstance.logger.log({
        level: 'error',
        category: 'rag',
        message: `<red>✗ Failed to add document to vector store:</red> ${errorMessage}`,
        generationId,
        conversationId,
        metadata: { error: errorMessage }
      });
    }

    console.error('[RAG Add Node] Error:', errorMessage);

    return {
      ragResult: {
        success: false,
        chunksAdded: 0,
        collectionName: state.ragCollection || 'general',
        error: errorMessage
      }
    };
  }
};
