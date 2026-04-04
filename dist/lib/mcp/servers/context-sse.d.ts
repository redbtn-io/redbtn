/**
 * Context MCP Server - SSE Transport (Simplified)
 * Manages conversation context, history, and message storage
 * This is a simplified wrapper around the existing MemoryManager
 */
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
export declare class ContextServerSSE extends McpServerSSE {
    private memoryManager;
    constructor(name: string, version: string, port?: number, redisUrl?: string);
    /**
     * Setup tools (simplified - just the essential ones)
     */
    protected setup(): Promise<void>;
    /**
     * Execute tool
     */
    protected executeTool(name: string, args: Record<string, unknown>, meta?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
    }): Promise<CallToolResult>;
}
