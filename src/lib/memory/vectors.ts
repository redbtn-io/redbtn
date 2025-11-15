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

import { ChromaClient, Collection } from 'chromadb';
import { countTokens } from '../utils/tokenizer';

// --- Configuration Constants ---

/**
 * Default chunk size in characters (roughly 500-750 tokens depending on text)
 * Ollama's nomic-embed-text supports up to 8192 tokens
 */
const DEFAULT_CHUNK_SIZE = 2000;

/**
 * Default overlap between chunks (helps maintain context across boundaries)
 * 200 characters = ~50-75 tokens of overlap
 */
const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * Default embedding model (Ollama)
 * Options: nomic-embed-text (137M params, 768 dims), mxbai-embed-large (335M params, 1024 dims)
 */
const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

/**
 * Default Ollama base URL for embeddings
 */
const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * Default similarity threshold (0-1 scale, where 1 is most similar)
 * ChromaDB uses cosine similarity by default
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;

/**
 * Maximum tokens for embedding model (nomic-embed-text limit)
 */
const MAX_EMBEDDING_TOKENS = 8192;

// --- Type Definitions ---

/**
 * Represents a document chunk with metadata
 */
export interface DocumentChunk {
  id: string;              // Unique identifier for the chunk
  text: string;            // The chunk's text content
  metadata: {
    source?: string;       // Original source (URL, file path, etc.)
    chunkIndex: number;    // Position in the original document
    totalChunks: number;   // Total number of chunks from source
    timestamp?: number;    // When the chunk was created
    conversationId?: string; // Optional conversation context
    messageId?: string;    // Optional message context
    [key: string]: any;    // Additional custom metadata
  };
  embedding?: number[];    // Optional pre-computed embedding vector
}

/**
 * Search result with similarity score
 */
export interface SearchResult {
  id: string;
  text: string;
  metadata: Record<string, any>;
  score: number;           // Similarity score (0-1, higher is better)
  distance: number;        // Distance metric from ChromaDB
}

/**
 * Configuration for text chunking
 */
export interface ChunkingConfig {
  chunkSize?: number;      // Size in characters
  chunkOverlap?: number;   // Overlap in characters
  preserveParagraphs?: boolean; // Try to keep paragraphs intact
}

/**
 * Configuration for vector search
 */
export interface SearchConfig {
  topK?: number;           // Number of results to return
  threshold?: number;      // Minimum similarity threshold
  filter?: Record<string, any>; // Metadata filters
  includeEmbeddings?: boolean;  // Include embeddings in results
}

/**
 * Statistics about a collection
 */
export interface CollectionStats {
  name: string;
  count: number;           // Number of documents
  metadata?: Record<string, any>;
}

// --- Vector Store Manager ---

/**
 * Manages vector storage and retrieval using ChromaDB
 */
export class VectorStoreManager {
  private client: ChromaClient;
  private readonly chromaUrl: string;
  private readonly ollamaUrl: string;
  private readonly embeddingModel: string;

  /**
   * Creates a new VectorStoreManager instance
   * @param chromaUrl ChromaDB server URL (default: http://localhost:8024)
   * @param ollamaUrl Ollama server URL for embeddings (default: http://localhost:11434)
   * @param embeddingModel Model name for embeddings (default: nomic-embed-text)
   */
  constructor(
    chromaUrl: string = 'http://localhost:8024',
    ollamaUrl: string = DEFAULT_OLLAMA_URL,
    embeddingModel: string = DEFAULT_EMBEDDING_MODEL
  ) {
    this.chromaUrl = chromaUrl;
    this.ollamaUrl = ollamaUrl;
    this.embeddingModel = embeddingModel;
    
    // Initialize ChromaDB client
    this.client = new ChromaClient({
      path: chromaUrl
    });
    
    console.log(`[VectorStore] Initialized with ChromaDB at ${chromaUrl}`);
    console.log(`[VectorStore] Using embedding model: ${embeddingModel} via ${ollamaUrl}`);
  }

  /**
   * Generate embeddings for text using Ollama
   * @param text Text to embed
   * @returns Embedding vector (array of floats)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    try {
      // Check token count before embedding
      const tokens = await countTokens(text);
      if (tokens > MAX_EMBEDDING_TOKENS) {
        throw new Error(
          `Text too long for embedding: ${tokens} tokens (max: ${MAX_EMBEDDING_TOKENS}). ` +
          `Consider chunking the text first.`
        );
      }

      // Call Ollama embeddings API
      const response = await fetch(`${this.ollamaUrl}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embeddingModel,
          prompt: text
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Ollama embeddings error: ${response.status} - ${errorText}`);
      }

      const data = await response.json();
      
      if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error('Invalid embedding response from Ollama');
      }

      console.log(
        `[VectorStore] Generated embedding: ${data.embedding.length} dimensions, ` +
        `${tokens} tokens`
      );

      return data.embedding;
    } catch (error) {
      console.error('[VectorStore] Embedding generation failed:', error);
      throw error;
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   * @param texts Array of texts to embed
   * @returns Array of embedding vectors
   */
  async generateEmbeddings(texts: string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    
    // Process in batches to avoid overwhelming the server
    const batchSize = 10;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchEmbeddings = await Promise.all(
        batch.map(text => this.generateEmbedding(text))
      );
      embeddings.push(...batchEmbeddings);
      
      console.log(
        `[VectorStore] Generated embeddings for batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`
      );
    }
    
    return embeddings;
  }

  /**
   * Split text into chunks with overlap
   * @param text Text to chunk
   * @param config Chunking configuration
   * @returns Array of text chunks
   */
  async chunkText(text: string, config: ChunkingConfig = {}): Promise<string[]> {
    const {
      chunkSize = DEFAULT_CHUNK_SIZE,
      chunkOverlap = DEFAULT_CHUNK_OVERLAP,
      preserveParagraphs = true
    } = config;

    const chunks: string[] = [];

    // If text is shorter than chunk size, return as-is
    if (text.length <= chunkSize) {
      return [text];
    }

    // Try to split by paragraphs if requested
    if (preserveParagraphs) {
      const paragraphs = text.split(/\n\n+/);
      let currentChunk = '';

      for (const para of paragraphs) {
        // If paragraph alone is too big, it will be split in the fallback logic
        if ((currentChunk + para).length <= chunkSize) {
          currentChunk += (currentChunk ? '\n\n' : '') + para;
        } else {
          // Save current chunk if it exists
          if (currentChunk) {
            chunks.push(currentChunk);
          }
          // Start new chunk with current paragraph
          currentChunk = para;
        }
      }

      // Add final chunk
      if (currentChunk) {
        chunks.push(currentChunk);
      }

      // If we got reasonable chunks, apply overlap and return
      if (chunks.length > 1 && chunks.every(c => c.length <= chunkSize * 1.5)) {
        return this.applyChunkOverlap(chunks, chunkOverlap);
      }
    }

    // Fallback: split by fixed size with overlap
    let startIndex = 0;
    while (startIndex < text.length) {
      const endIndex = Math.min(startIndex + chunkSize, text.length);
      const chunk = text.slice(startIndex, endIndex);
      chunks.push(chunk);
      
      // Move forward by (chunkSize - overlap) to create overlap
      startIndex += chunkSize - chunkOverlap;
      
      // Break if we've reached the end
      if (endIndex >= text.length) {
        break;
      }
    }

    console.log(
      `[VectorStore] Chunked text: ${text.length} chars -> ${chunks.length} chunks ` +
      `(size: ${chunkSize}, overlap: ${chunkOverlap})`
    );

    return chunks;
  }

  /**
   * Apply overlap to existing chunks by prepending previous chunk's tail
   * @param chunks Array of chunks
   * @param overlap Number of characters to overlap
   * @returns Chunks with overlap applied
   */
  private applyChunkOverlap(chunks: string[], overlap: number): string[] {
    if (overlap === 0 || chunks.length <= 1) {
      return chunks;
    }

    const overlappedChunks: string[] = [chunks[0]];

    for (let i = 1; i < chunks.length; i++) {
      const prevChunk = chunks[i - 1];
      const currentChunk = chunks[i];
      
      // Get the last 'overlap' characters from previous chunk
      const overlapText = prevChunk.slice(-overlap);
      
      // Prepend to current chunk
      overlappedChunks.push(overlapText + currentChunk);
    }

    return overlappedChunks;
  }

  /**
   * Get or create a collection
   * @param collectionName Name of the collection
   * @param metadata Optional metadata for the collection
   * @returns ChromaDB collection instance
   */
  async getOrCreateCollection(
    collectionName: string,
    metadata?: Record<string, any>
  ): Promise<Collection> {
    try {
      const collection = await this.client.getOrCreateCollection({
        name: collectionName,
        metadata: {
          ...metadata,
          'hnsw:space': 'cosine'  // Use cosine similarity instead of L2
        }
      });
      
      console.log(`[VectorStore] Using collection: ${collectionName} (cosine similarity)`);
      return collection;
    } catch (error) {
      console.error(`[VectorStore] Failed to get/create collection ${collectionName}:`, error);
      throw error;
    }
  }

  /**
   * Add documents to a collection
   * @param collectionName Name of the collection
   * @param chunks Array of document chunks with metadata
   * @returns Number of documents added
   */
  async addDocuments(
    collectionName: string,
    chunks: DocumentChunk[]
  ): Promise<number> {
    try {
      const collection = await this.getOrCreateCollection(collectionName);

      // Generate embeddings for all chunks
      const texts = chunks.map(c => c.text);
      const embeddings = await this.generateEmbeddings(texts);

      // Prepare data for ChromaDB
      const ids = chunks.map(c => c.id);
      const metadatas = chunks.map(c => c.metadata);
      const documents = chunks.map(c => c.text);

      // Add to collection
      await collection.add({
        ids,
        embeddings,
        metadatas,
        documents
      });

      console.log(
        `[VectorStore] Added ${chunks.length} documents to collection: ${collectionName}`
      );

      return chunks.length;
    } catch (error) {
      console.error('[VectorStore] Failed to add documents:', error);
      throw error;
    }
  }

  /**
   * Add a single document (automatically chunks it)
   * @param collectionName Name of the collection
   * @param text Document text
   * @param metadata Document metadata
   * @param chunkingConfig Optional chunking configuration
   * @returns Number of chunks created
   */
  async addDocument(
    collectionName: string,
    text: string,
    metadata: Record<string, any>,
    chunkingConfig?: ChunkingConfig
  ): Promise<number> {
    try {
      // Chunk the text
      const textChunks = await this.chunkText(text, chunkingConfig);

      // Create document chunks with metadata
      const chunks: DocumentChunk[] = textChunks.map((chunk, index) => ({
        id: `${metadata.source || 'doc'}_chunk_${index}_${Date.now()}`,
        text: chunk,
        metadata: {
          ...metadata,
          chunkIndex: index,
          totalChunks: textChunks.length,
          timestamp: Date.now()
        }
      }));

      // Add to collection
      return await this.addDocuments(collectionName, chunks);
    } catch (error) {
      console.error('[VectorStore] Failed to add document:', error);
      throw error;
    }
  }

  /**
   * Search for similar documents using semantic similarity
   * @param collectionName Name of the collection to search
   * @param query Query text
   * @param config Search configuration
   * @returns Array of search results with scores
   */
  async search(
    collectionName: string,
    query: string,
    config: SearchConfig = {}
  ): Promise<SearchResult[]> {
    try {
      const {
        topK = 5,
        threshold = DEFAULT_SIMILARITY_THRESHOLD,
        filter,
        includeEmbeddings = false
      } = config;

      const collection = await this.getOrCreateCollection(collectionName);

      // Generate embedding for query
      const queryEmbedding = await this.generateEmbedding(query);

      // Perform similarity search
      const results = await collection.query({
        queryEmbeddings: [queryEmbedding],
        nResults: topK,
        where: filter,
        include: includeEmbeddings 
          ? ['documents', 'metadatas', 'distances', 'embeddings']
          : ['documents', 'metadatas', 'distances']
      });

      // Transform results to SearchResult format
      const searchResults: SearchResult[] = [];

      if (results.ids && results.ids[0]) {
        for (let i = 0; i < results.ids[0].length; i++) {
          const distance = results.distances?.[0]?.[i] ?? 999;
          
          // With cosine similarity, ChromaDB returns distance in range [0, 2]
          // where 0 = identical, 1 = orthogonal, 2 = opposite
          // Convert to similarity score: 1 - (distance / 2)
          // This gives scores from 0 to 1, where 1 is most similar
          const score = 1 - (distance / 2);

          // Filter by threshold
          if (score >= threshold) {
            searchResults.push({
              id: results.ids[0][i],
              text: results.documents?.[0]?.[i] ?? '',
              metadata: results.metadatas?.[0]?.[i] ?? {},
              score,
              distance
            });
          }
        }
      }

      console.log(
        `[VectorStore] Search in ${collectionName}: found ${searchResults.length}/${topK} results ` +
        `above threshold ${threshold}`
      );

      return searchResults;
    } catch (error) {
      console.error('[VectorStore] Search failed:', error);
      throw error;
    }
  }

  /**
   * Delete documents from a collection by IDs
   * @param collectionName Name of the collection
   * @param ids Array of document IDs to delete
   * @returns Number of documents deleted
   */
  async deleteDocuments(
    collectionName: string,
    ids: string[]
  ): Promise<number> {
    try {
      const collection = await this.getOrCreateCollection(collectionName);
      
      await collection.delete({
        ids
      });

      console.log(`[VectorStore] Deleted ${ids.length} documents from ${collectionName}`);
      return ids.length;
    } catch (error) {
      console.error('[VectorStore] Failed to delete documents:', error);
      throw error;
    }
  }

  /**
   * Delete documents by metadata filter
   * @param collectionName Name of the collection
   * @param filter Metadata filter (e.g., { source: "url" })
   * @returns Number of documents deleted
   */
  async deleteByFilter(
    collectionName: string,
    filter: Record<string, any>
  ): Promise<number> {
    try {
      const collection = await this.getOrCreateCollection(collectionName);
      
      await collection.delete({
        where: filter
      });

      console.log(`[VectorStore] Deleted documents matching filter from ${collectionName}`);
      return 0; // ChromaDB doesn't return count
    } catch (error) {
      console.error('[VectorStore] Failed to delete by filter:', error);
      throw error;
    }
  }

  /**
   * Delete an entire collection
   * @param collectionName Name of the collection to delete
   */
  async deleteCollection(collectionName: string): Promise<void> {
    try {
      await this.client.deleteCollection({ name: collectionName });
      console.log(`[VectorStore] Deleted collection: ${collectionName}`);
    } catch (error) {
      console.error(`[VectorStore] Failed to delete collection ${collectionName}:`, error);
      throw error;
    }
  }

  /**
   * List all collections
   * @returns Array of collection names
   */
  async listCollections(): Promise<string[]> {
    try {
      const collections = await this.client.listCollections();
      const names = collections.map(c => c.name);
      console.log(`[VectorStore] Found ${names.length} collections`);
      return names;
    } catch (error) {
      console.error('[VectorStore] Failed to list collections:', error);
      throw error;
    }
  }

  /**
   * Get statistics about a collection
   * @param collectionName Name of the collection
   * @returns Collection statistics
   */
  async getCollectionStats(collectionName: string): Promise<CollectionStats> {
    try {
      const collection = await this.getOrCreateCollection(collectionName);
      const count = await collection.count();
      
      return {
        name: collectionName,
        count,
        metadata: collection.metadata
      };
    } catch (error) {
      console.error(`[VectorStore] Failed to get stats for ${collectionName}:`, error);
      throw error;
    }
  }

  /**
   * Check if ChromaDB is accessible
   * @returns True if connected, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      const heartbeat = await this.client.heartbeat();
      console.log(`[VectorStore] ChromaDB heartbeat: ${heartbeat}ms`);
      return true;
    } catch (error) {
      console.error('[VectorStore] Health check failed:', error);
      return false;
    }
  }
}
