"use strict";
/**
 * Add Document — Native RAG Tool
 *
 * Adds a document to the vector database. Automatically chunks large
 * documents and generates embeddings. Produces identical results to
 * the MCP rag-sse.ts `add_document` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → add_document
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
const vectors_1 = require("../../memory/vectors");
let _vectorStore = null;
function getVectorStore() {
    if (!_vectorStore) {
        const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8024';
        const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        _vectorStore = new vectors_1.VectorStoreManager(chromaUrl, ollamaUrl);
    }
    return _vectorStore;
}
const addDocument = {
    description: 'Add a document to the vector database for semantic search. Automatically chunks large documents and generates embeddings.',
    server: 'rag',
    inputSchema: {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'The document text to add (will be automatically chunked if large)',
            },
            collection: {
                type: 'string',
                description: 'Collection name to add to (e.g., "documentation", "articles")',
                default: 'general',
            },
            source: {
                type: 'string',
                description: 'Source identifier (URL, file path, or description)',
            },
            metadata: {
                type: 'object',
                description: 'Additional metadata (title, author, date, category, etc.)',
                additionalProperties: true,
            },
            chunkSize: {
                type: 'number',
                description: 'Chunk size in characters (default: 2000)',
                default: 2000,
            },
            chunkOverlap: {
                type: 'number',
                description: 'Overlap between chunks in characters (default: 200)',
                default: 200,
            },
        },
        required: ['text'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { text, collection = 'general', source = 'unknown', metadata = {}, chunkSize = 2000, chunkOverlap = 200, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'add_document';
        const startTime = Date.now();
        console.log(`[add_document] collection=${collection}, textLength=${text === null || text === void 0 ? void 0 : text.length}, source=${source}`);
        if (!text || text.trim().length === 0) {
            return {
                content: [{ type: 'text', text: 'Error: No text provided' }],
                isError: true,
            };
        }
        try {
            const vs = getVectorStore();
            // Health check
            const isHealthy = yield vs.healthCheck();
            if (!isHealthy) {
                throw new Error('ChromaDB is not accessible');
            }
            // Prepare metadata
            const fullMetadata = Object.assign(Object.assign({}, metadata), { source, addedAt: Date.now() });
            // Prepare chunking config
            const chunkingConfig = {
                chunkSize,
                chunkOverlap,
                preserveParagraphs: true,
            };
            // Stream progress via RunPublisher
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[add_document] Chunking and embedding ${text.length} chars into "${collection}"...\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            // Add document (this will automatically chunk and embed)
            const chunksAdded = yield vs.addDocument(collection, text, fullMetadata, chunkingConfig);
            const duration = Date.now() - startTime;
            console.log(`[add_document] Added ${chunksAdded} chunks to "${collection}" in ${duration}ms`);
            // Stream completion via RunPublisher
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[add_document] ${chunksAdded} chunks added (${duration}ms)\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            const result = `Successfully added document to collection "${collection}".\n` +
                `- Text length: ${text.length} characters\n` +
                `- Chunks created: ${chunksAdded}\n` +
                `- Source: ${source}\n` +
                `- Duration: ${duration}ms`;
            return {
                content: [{ type: 'text', text: result }],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const duration = Date.now() - startTime;
            console.error(`[add_document] Error: ${msg}`);
            return {
                content: [{ type: 'text', text: `Failed to add document: ${msg}` }],
                isError: true,
            };
        }
    }),
};
exports.default = addDocument;
module.exports = addDocument;
