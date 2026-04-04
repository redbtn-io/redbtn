"use strict";
/**
 * Search Documents — Native RAG Tool
 *
 * Searches the vector database using semantic similarity. Returns the
 * most relevant documents. Produces identical results to the MCP
 * rag-sse.ts `search_documents` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → search_documents
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
/**
 * Group results by source and merge overlapping chunks.
 * Identical algorithm to rag-sse.ts groupAndMergeResults + mergeOverlappingChunks.
 */
function groupAndMergeResults(results) {
    var _a;
    const groupedBySource = new Map();
    for (const result of results) {
        const source = ((_a = result.metadata) === null || _a === void 0 ? void 0 : _a.source) || 'unknown';
        if (!groupedBySource.has(source)) {
            groupedBySource.set(source, []);
        }
        groupedBySource.get(source).push(result);
    }
    const mergedResults = [];
    for (const [, sourceResults] of groupedBySource) {
        sourceResults.sort((a, b) => {
            var _a, _b, _c, _d;
            const aIndex = (_b = (_a = a.metadata) === null || _a === void 0 ? void 0 : _a.chunkIndex) !== null && _b !== void 0 ? _b : -1;
            const bIndex = (_d = (_c = b.metadata) === null || _c === void 0 ? void 0 : _c.chunkIndex) !== null && _d !== void 0 ? _d : -1;
            if (aIndex !== -1 && bIndex !== -1) {
                return aIndex - bIndex;
            }
            return b.score - a.score;
        });
        const textChunks = sourceResults.map((r) => r.text);
        const mergedText = mergeOverlappingChunks(textChunks);
        const avgScore = sourceResults.reduce((sum, r) => sum + r.score, 0) / sourceResults.length;
        mergedResults.push({
            id: sourceResults[0].id,
            text: mergedText,
            metadata: Object.assign(Object.assign({}, sourceResults[0].metadata), { mergedChunks: sourceResults.length, avgScore }),
            score: avgScore,
            distance: sourceResults[0].distance,
        });
    }
    mergedResults.sort((a, b) => b.score - a.score);
    return mergedResults;
}
function mergeOverlappingChunks(chunks) {
    if (chunks.length === 0)
        return '';
    if (chunks.length === 1)
        return chunks[0];
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
        }
        else {
            merged += '\n\n' + currentChunk;
        }
    }
    return merged;
}
const searchDocuments = {
    description: 'Search the vector database using semantic similarity. Returns the most relevant documents for a query.',
    server: 'rag',
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query (natural language question or keywords)',
            },
            collection: {
                type: 'string',
                description: 'Collection name to search in (default: "general")',
                default: 'general',
            },
            topK: {
                type: 'number',
                description: 'Maximum number of results to return (default: 5)',
                default: 5,
            },
            threshold: {
                type: 'number',
                description: 'Minimum similarity threshold 0-1 (default: 0.7)',
                default: 0.7,
            },
            filter: {
                type: 'object',
                description: 'Metadata filter to narrow results (e.g., {"category": "api"})',
                additionalProperties: true,
            },
            mergeChunks: {
                type: 'boolean',
                description: 'Merge overlapping chunks from same source (default: true)',
                default: true,
            },
        },
        required: ['query'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        var _a, _b;
        const args = rawArgs;
        const { query, collection = 'general', topK = 5, threshold = 0.7, filter, mergeChunks = true, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'search_documents';
        const startTime = Date.now();
        console.log(`[search_documents] query="${query.substring(0, 80)}", collection=${collection}`);
        if (!query || query.trim().length === 0) {
            return {
                content: [{ type: 'text', text: 'Error: No query provided' }],
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
            // Perform search
            const searchConfig = { topK, threshold, filter };
            const results = yield vs.search(collection, query, searchConfig);
            // Merge chunks if requested
            let processedResults = results;
            if (mergeChunks && results.length > 0) {
                processedResults = groupAndMergeResults(results);
            }
            const duration = Date.now() - startTime;
            console.log(`[search_documents] ${processedResults.length} results in ${duration}ms`);
            // Stream progress via RunPublisher
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[search_documents] ${processedResults.length} results from "${collection}" (${duration}ms)\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            if (processedResults.length === 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `No relevant documents found in collection "${collection}" for query: "${query}"`,
                        },
                    ],
                };
            }
            // Build formatted response (same format as rag-sse.ts)
            let resultText = `# Search Results for: "${query}"\n\n`;
            resultText += `Found ${processedResults.length} relevant document(s) in collection "${collection}":\n\n`;
            for (let i = 0; i < processedResults.length; i++) {
                const result = processedResults[i];
                const relevance = (result.score * 100).toFixed(1);
                const source = ((_a = result.metadata) === null || _a === void 0 ? void 0 : _a.source) || 'unknown';
                const mergedCount = (_b = result.metadata) === null || _b === void 0 ? void 0 : _b.mergedChunks;
                const mergeInfo = mergedCount > 1 ? ` (${mergedCount} chunks merged)` : '';
                resultText += `## Result ${i + 1} - ${relevance}% relevant${mergeInfo}\n`;
                resultText += `**Source:** ${source}\n\n`;
                resultText += `${result.text}\n\n`;
                resultText += `---\n\n`;
            }
            return {
                content: [{ type: 'text', text: resultText }],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const duration = Date.now() - startTime;
            console.error(`[search_documents] Error: ${msg}`);
            return {
                content: [{ type: 'text', text: `Search failed: ${msg}` }],
                isError: true,
            };
        }
    }),
};
exports.default = searchDocuments;
module.exports = searchDocuments;
