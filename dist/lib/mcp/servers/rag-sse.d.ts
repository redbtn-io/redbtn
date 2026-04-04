/**
 * RAG MCP Server (SSE Transport)
 * Provides vector database operations via HTTP/SSE
 */
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
export declare class RagServerSSE extends McpServerSSE {
    private vectorStore;
    private chromaUrl;
    private ollamaUrl;
    constructor(name: string, version: string, port?: number, chromaUrl?: string, ollamaUrl?: string);
    /**
     * Setup tools
     */
    protected setup(): Promise<void>;
    /**
     * Execute tool
     */
    protected executeTool(toolName: string, args: Record<string, unknown>): Promise<CallToolResult>;
    /**
     * Add document to vector database
     */
    private addDocument;
    /**
     * Search documents
     */
    private searchDocuments;
    /**
     * Group and merge results by source
     */
    private groupAndMergeResults;
    /**
     * Merge overlapping text chunks
     */
    private mergeOverlappingChunks;
    /**
     * Delete documents
     */
    private deleteDocuments;
    /**
     * List collections
     */
    private listCollections;
    /**
     * Get collection stats
     */
    private getCollectionStats;
}
