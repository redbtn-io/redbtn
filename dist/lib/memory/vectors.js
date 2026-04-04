"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.VectorStoreManager = void 0;
const chromadb_1 = require("chromadb");
const tokenizer_1 = require("../utils/tokenizer");
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
 * Default Ollama base URL for embeddings.
 * TODO: Move embedding endpoint configuration to a dedicated config field or neuron system
 * instead of relying on OLLAMA_URL / OLLAMA_BASE_URL env vars.
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
// --- Vector Store Manager ---
/**
 * Manages vector storage and retrieval using ChromaDB
 */
class VectorStoreManager {
    /**
     * Creates a new VectorStoreManager instance
     * @param chromaUrl ChromaDB server URL (default: http://localhost:8024)
     * @param ollamaUrl Ollama server URL for embeddings (default: http://localhost:11434)
     * @param embeddingModel Model name for embeddings (default: nomic-embed-text)
     */
    constructor(chromaUrl = process.env.CHROMA_URL || 'http://localhost:8024', ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL, embeddingModel = DEFAULT_EMBEDDING_MODEL) {
        this.chromaUrl = chromaUrl;
        this.ollamaUrl = ollamaUrl;
        this.embeddingModel = embeddingModel;
        // Initialize ChromaDB client
        this.client = new chromadb_1.ChromaClient({
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
    generateEmbedding(text) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Check token count before embedding
                const tokens = yield (0, tokenizer_1.countTokens)(text);
                if (tokens > MAX_EMBEDDING_TOKENS) {
                    throw new Error(`Text too long for embedding: ${tokens} tokens (max: ${MAX_EMBEDDING_TOKENS}). ` +
                        `Consider chunking the text first.`);
                }
                // Call Ollama embeddings API
                const response = yield fetch(`${this.ollamaUrl}/api/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: this.embeddingModel,
                        prompt: text
                    })
                });
                if (!response.ok) {
                    const errorText = yield response.text();
                    throw new Error(`Ollama embeddings error: ${response.status} - ${errorText}`);
                }
                const data = yield response.json();
                if (!data.embedding || !Array.isArray(data.embedding)) {
                    throw new Error('Invalid embedding response from Ollama');
                }
                console.log(`[VectorStore] Generated embedding: ${data.embedding.length} dimensions, ` +
                    `${tokens} tokens`);
                return data.embedding;
            }
            catch (error) {
                console.error('[VectorStore] Embedding generation failed:', error);
                throw error;
            }
        });
    }
    /**
     * Generate embeddings for multiple texts in batch
     * @param texts Array of texts to embed
     * @returns Array of embedding vectors
     */
    generateEmbeddings(texts) {
        return __awaiter(this, void 0, void 0, function* () {
            const embeddings = [];
            // Process in batches to avoid overwhelming the server
            const batchSize = 10;
            for (let i = 0; i < texts.length; i += batchSize) {
                const batch = texts.slice(i, i + batchSize);
                const batchEmbeddings = yield Promise.all(batch.map(text => this.generateEmbedding(text)));
                embeddings.push(...batchEmbeddings);
                console.log(`[VectorStore] Generated embeddings for batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(texts.length / batchSize)}`);
            }
            return embeddings;
        });
    }
    /**
     * Split text into chunks with overlap
     * @param text Text to chunk
     * @param config Chunking configuration
     * @returns Array of text chunks
     */
    chunkText(text_1) {
        return __awaiter(this, arguments, void 0, function* (text, config = {}) {
            const { chunkSize = DEFAULT_CHUNK_SIZE, chunkOverlap = DEFAULT_CHUNK_OVERLAP, preserveParagraphs = true } = config;
            const chunks = [];
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
                    }
                    else {
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
            console.log(`[VectorStore] Chunked text: ${text.length} chars -> ${chunks.length} chunks ` +
                `(size: ${chunkSize}, overlap: ${chunkOverlap})`);
            return chunks;
        });
    }
    /**
     * Apply overlap to existing chunks by prepending previous chunk's tail
     * @param chunks Array of chunks
     * @param overlap Number of characters to overlap
     * @returns Chunks with overlap applied
     */
    applyChunkOverlap(chunks, overlap) {
        if (overlap === 0 || chunks.length <= 1) {
            return chunks;
        }
        const overlappedChunks = [chunks[0]];
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
    getOrCreateCollection(collectionName, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collection = yield this.client.getOrCreateCollection({
                    name: collectionName,
                    metadata: Object.assign(Object.assign({}, metadata), { 'hnsw:space': 'cosine' // Use cosine similarity instead of L2
                     })
                });
                console.log(`[VectorStore] Using collection: ${collectionName} (cosine similarity)`);
                return collection;
            }
            catch (error) {
                console.error(`[VectorStore] Failed to get/create collection ${collectionName}:`, error);
                throw error;
            }
        });
    }
    /**
     * Add documents to a collection
     * @param collectionName Name of the collection
     * @param chunks Array of document chunks with metadata
     * @returns Number of documents added
     */
    addDocuments(collectionName, chunks) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collection = yield this.getOrCreateCollection(collectionName);
                // Generate embeddings for all chunks
                const texts = chunks.map(c => c.text);
                const embeddings = yield this.generateEmbeddings(texts);
                // Prepare data for ChromaDB
                const ids = chunks.map(c => c.id);
                const metadatas = chunks.map(c => c.metadata);
                const documents = chunks.map(c => c.text);
                // Add to collection
                yield collection.add({
                    ids,
                    embeddings,
                    metadatas,
                    documents
                });
                console.log(`[VectorStore] Added ${chunks.length} documents to collection: ${collectionName}`);
                return chunks.length;
            }
            catch (error) {
                console.error('[VectorStore] Failed to add documents:', error);
                throw error;
            }
        });
    }
    /**
     * Add a single document (automatically chunks it)
     * @param collectionName Name of the collection
     * @param text Document text
     * @param metadata Document metadata
     * @param chunkingConfig Optional chunking configuration
     * @returns Number of chunks created
     */
    addDocument(collectionName, text, metadata, chunkingConfig) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // Chunk the text
                const textChunks = yield this.chunkText(text, chunkingConfig);
                // Create document chunks with metadata
                const chunks = textChunks.map((chunk, index) => ({
                    id: `${metadata.source || 'doc'}_chunk_${index}_${Date.now()}`,
                    text: chunk,
                    metadata: Object.assign(Object.assign({}, metadata), { chunkIndex: index, totalChunks: textChunks.length, timestamp: Date.now() })
                }));
                // Add to collection
                return yield this.addDocuments(collectionName, chunks);
            }
            catch (error) {
                console.error('[VectorStore] Failed to add document:', error);
                throw error;
            }
        });
    }
    /**
     * Search for similar documents using semantic similarity
     * @param collectionName Name of the collection to search
     * @param query Query text
     * @param config Search configuration
     * @returns Array of search results with scores
     */
    search(collectionName_1, query_1) {
        return __awaiter(this, arguments, void 0, function* (collectionName, query, config = {}) {
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            try {
                const { topK = 5, threshold = DEFAULT_SIMILARITY_THRESHOLD, filter, includeEmbeddings = false } = config;
                const collection = yield this.getOrCreateCollection(collectionName);
                // Generate embedding for query
                const queryEmbedding = yield this.generateEmbedding(query);
                // Perform similarity search
                const results = yield collection.query({
                    queryEmbeddings: [queryEmbedding],
                    nResults: topK,
                    where: filter,
                    include: includeEmbeddings
                        ? ['documents', 'metadatas', 'distances', 'embeddings']
                        : ['documents', 'metadatas', 'distances']
                });
                // Transform results to SearchResult format
                const searchResults = [];
                if (results.ids && results.ids[0]) {
                    for (let i = 0; i < results.ids[0].length; i++) {
                        const distance = (_c = (_b = (_a = results.distances) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b[i]) !== null && _c !== void 0 ? _c : 999;
                        // With cosine similarity, ChromaDB returns distance in range [0, 2]
                        // where 0 = identical, 1 = orthogonal, 2 = opposite
                        // Convert to similarity score: 1 - (distance / 2)
                        // This gives scores from 0 to 1, where 1 is most similar
                        const score = 1 - (distance / 2);
                        // Filter by threshold
                        if (score >= threshold) {
                            searchResults.push({
                                id: results.ids[0][i],
                                text: (_f = (_e = (_d = results.documents) === null || _d === void 0 ? void 0 : _d[0]) === null || _e === void 0 ? void 0 : _e[i]) !== null && _f !== void 0 ? _f : '',
                                metadata: (_j = (_h = (_g = results.metadatas) === null || _g === void 0 ? void 0 : _g[0]) === null || _h === void 0 ? void 0 : _h[i]) !== null && _j !== void 0 ? _j : {},
                                score,
                                distance
                            });
                        }
                    }
                }
                console.log(`[VectorStore] Search in ${collectionName}: found ${searchResults.length}/${topK} results ` +
                    `above threshold ${threshold}`);
                return searchResults;
            }
            catch (error) {
                console.error('[VectorStore] Search failed:', error);
                throw error;
            }
        });
    }
    /**
     * Delete documents from a collection by IDs
     * @param collectionName Name of the collection
     * @param ids Array of document IDs to delete
     * @returns Number of documents deleted
     */
    deleteDocuments(collectionName, ids) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collection = yield this.getOrCreateCollection(collectionName);
                yield collection.delete({
                    ids
                });
                console.log(`[VectorStore] Deleted ${ids.length} documents from ${collectionName}`);
                return ids.length;
            }
            catch (error) {
                console.error('[VectorStore] Failed to delete documents:', error);
                throw error;
            }
        });
    }
    /**
     * Delete documents by metadata filter
     * @param collectionName Name of the collection
     * @param filter Metadata filter (e.g., { source: "url" })
     * @returns Number of documents deleted
     */
    deleteByFilter(collectionName, filter) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collection = yield this.getOrCreateCollection(collectionName);
                yield collection.delete({
                    where: filter
                });
                console.log(`[VectorStore] Deleted documents matching filter from ${collectionName}`);
                return 0; // ChromaDB doesn't return count
            }
            catch (error) {
                console.error('[VectorStore] Failed to delete by filter:', error);
                throw error;
            }
        });
    }
    /**
     * Delete an entire collection
     * @param collectionName Name of the collection to delete
     */
    deleteCollection(collectionName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                yield this.client.deleteCollection({ name: collectionName });
                console.log(`[VectorStore] Deleted collection: ${collectionName}`);
            }
            catch (error) {
                console.error(`[VectorStore] Failed to delete collection ${collectionName}:`, error);
                throw error;
            }
        });
    }
    /**
     * List all collections
     * @returns Array of collection names
     */
    listCollections() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collections = yield this.client.listCollections();
                const names = collections.map(c => c.name);
                console.log(`[VectorStore] Found ${names.length} collections`);
                return names;
            }
            catch (error) {
                console.error('[VectorStore] Failed to list collections:', error);
                throw error;
            }
        });
    }
    /**
     * Get statistics about a collection
     * @param collectionName Name of the collection
     * @returns Collection statistics
     */
    getCollectionStats(collectionName) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const collection = yield this.getOrCreateCollection(collectionName);
                const count = yield collection.count();
                return {
                    name: collectionName,
                    count,
                    metadata: collection.metadata
                };
            }
            catch (error) {
                console.error(`[VectorStore] Failed to get stats for ${collectionName}:`, error);
                throw error;
            }
        });
    }
    /**
     * Check if ChromaDB is accessible
     * @returns True if connected, false otherwise
     */
    healthCheck() {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const heartbeat = yield this.client.heartbeat();
                console.log(`[VectorStore] ChromaDB heartbeat: ${heartbeat}ms`);
                return true;
            }
            catch (error) {
                console.error('[VectorStore] Health check failed:', error);
                return false;
            }
        });
    }
}
exports.VectorStoreManager = VectorStoreManager;
