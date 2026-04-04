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
import { ChunkingConfig } from '../../memory/vectors';
import { InvokeOptions } from '../../../index';
/**
 * State interface for the add node
 */
interface AddToVectorStoreState {
    ragDocument?: {
        text: string;
        source?: string;
        metadata?: Record<string, any>;
    };
    ragCollection?: string;
    ragChunkingConfig?: ChunkingConfig;
    ragResult?: {
        success: boolean;
        chunksAdded: number;
        collectionName: string;
        documentIds?: string[];
        error?: string;
    };
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
export declare const addToVectorStoreNode: (state: AddToVectorStoreState) => Promise<Partial<AddToVectorStoreState>>;
export {};
