/**
 * @file src/lib/memory/vectors.ts
 * @description Vector store management with ChromaDB for RAG (Retrieval-Augmented Generation)
 *
 * Key features:
 * - Text chunking with configurable size and overlap
 * - Embedding generation using Ollama models
 * - Semantic similarity search with score threshold
 * - Collection management (create, delete, list)
 * - Metadata filtering for advanced queries
 * - Automatic token counting and validation
 */
import { Collection } from 'chromadb';
/**
 * Represents a document chunk with metadata
 */
export interface DocumentChunk {
    id: string;
    text: string;
    metadata: {
        source?: string;
        chunkIndex: number;
        totalChunks: number;
        timestamp?: number;
        conversationId?: string;
        messageId?: string;
        [key: string]: any;
    };
    embedding?: number[];
}
/**
 * Search result with similarity score
 */
export interface SearchResult {
    id: string;
    text: string;
    metadata: Record<string, any>;
    score: number;
    distance: number;
}
/**
 * Configuration for text chunking
 */
export interface ChunkingConfig {
    chunkSize?: number;
    chunkOverlap?: number;
    preserveParagraphs?: boolean;
}
/**
 * Configuration for vector search
 */
export interface SearchConfig {
    topK?: number;
    threshold?: number;
    filter?: Record<string, any>;
    includeEmbeddings?: boolean;
}
/**
 * Statistics about a collection
 */
export interface CollectionStats {
    name: string;
    count: number;
    metadata?: Record<string, any>;
}
/**
 * Manages vector storage and retrieval using ChromaDB
 */
export declare class VectorStoreManager {
    private client;
    private readonly chromaUrl;
    private readonly ollamaUrl;
    private readonly embeddingModel;
    /**
     * Creates a new VectorStoreManager instance
     * @param chromaUrl ChromaDB server URL (default: http://localhost:8024)
     * @param ollamaUrl Ollama server URL for embeddings (default: http://localhost:11434)
     * @param embeddingModel Model name for embeddings (default: nomic-embed-text)
     */
    constructor(chromaUrl?: string, ollamaUrl?: string, embeddingModel?: string);
    /**
     * Generate embeddings for text using Ollama
     * @param text Text to embed
     * @returns Embedding vector (array of floats)
     */
    generateEmbedding(text: string): Promise<number[]>;
    /**
     * Generate embeddings for multiple texts in batch
     * @param texts Array of texts to embed
     * @returns Array of embedding vectors
     */
    generateEmbeddings(texts: string[]): Promise<number[][]>;
    /**
     * Split text into chunks with overlap
     * @param text Text to chunk
     * @param config Chunking configuration
     * @returns Array of text chunks
     */
    chunkText(text: string, config?: ChunkingConfig): Promise<string[]>;
    /**
     * Apply overlap to existing chunks by prepending previous chunk's tail
     * @param chunks Array of chunks
     * @param overlap Number of characters to overlap
     * @returns Chunks with overlap applied
     */
    private applyChunkOverlap;
    /**
     * Get or create a collection
     * @param collectionName Name of the collection
     * @param metadata Optional metadata for the collection
     * @returns ChromaDB collection instance
     */
    getOrCreateCollection(collectionName: string, metadata?: Record<string, any>): Promise<Collection>;
    /**
     * Add documents to a collection
     * @param collectionName Name of the collection
     * @param chunks Array of document chunks with metadata
     * @returns Number of documents added
     */
    addDocuments(collectionName: string, chunks: DocumentChunk[]): Promise<number>;
    /**
     * Add a single document (automatically chunks it)
     * @param collectionName Name of the collection
     * @param text Document text
     * @param metadata Document metadata
     * @param chunkingConfig Optional chunking configuration
     * @returns Number of chunks created
     */
    addDocument(collectionName: string, text: string, metadata: Record<string, any>, chunkingConfig?: ChunkingConfig): Promise<number>;
    /**
     * Search for similar documents using semantic similarity
     * @param collectionName Name of the collection to search
     * @param query Query text
     * @param config Search configuration
     * @returns Array of search results with scores
     */
    search(collectionName: string, query: string, config?: SearchConfig): Promise<SearchResult[]>;
    /**
     * Delete documents from a collection by IDs
     * @param collectionName Name of the collection
     * @param ids Array of document IDs to delete
     * @returns Number of documents deleted
     */
    deleteDocuments(collectionName: string, ids: string[]): Promise<number>;
    /**
     * Delete documents by metadata filter
     * @param collectionName Name of the collection
     * @param filter Metadata filter (e.g., { source: "url" })
     * @returns Number of documents deleted
     */
    deleteByFilter(collectionName: string, filter: Record<string, any>): Promise<number>;
    /**
     * Delete an entire collection
     * @param collectionName Name of the collection to delete
     */
    deleteCollection(collectionName: string): Promise<void>;
    /**
     * List all collections
     * @returns Array of collection names
     */
    listCollections(): Promise<string[]>;
    /**
     * Get statistics about a collection
     * @param collectionName Name of the collection
     * @returns Collection statistics
     */
    getCollectionStats(collectionName: string): Promise<CollectionStats>;
    /**
     * Check if ChromaDB is accessible
     * @returns True if connected, false otherwise
     */
    healthCheck(): Promise<boolean>;
}
