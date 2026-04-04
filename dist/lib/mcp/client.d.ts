/**
 * MCP Client
 * Implements JSON-RPC 2.0 client over Redis transport
 */
import { Redis } from 'ioredis';
import { InitializeResult, ToolsListResult, CallToolResult } from './types';
export declare class McpClient {
    private redis;
    private subscriber;
    private serverName;
    private requestChannel;
    private responseChannel;
    private pendingRequests;
    private requestId;
    constructor(redis: Redis, serverName: string);
    /**
     * Connect to MCP server
     */
    connect(): Promise<void>;
    /**
     * Disconnect from MCP server
     */
    disconnect(): Promise<void>;
    /**
     * Initialize connection with server
     */
    initialize(clientInfo: {
        name: string;
        version: string;
    }): Promise<InitializeResult>;
    /**
     * List available tools
     */
    listTools(): Promise<ToolsListResult>;
    /**
     * List available resources
     */
    listResources(): Promise<{
        resources: Array<{
            uri: string;
            name: string;
            description?: string;
            mimeType?: string;
        }>;
    }>;
    /**
     * Read a resource
     */
    readResource(params: {
        uri: string;
    }): Promise<{
        contents: Array<{
            uri: string;
            mimeType?: string;
            text?: string;
            blob?: string;
        }>;
    }>;
    /**
     * Call a tool
     */
    callTool(name: string, args: Record<string, unknown>, meta?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
    }): Promise<CallToolResult>;
    /**
     * Send JSON-RPC request
     */
    private sendRequest;
    /**
     * Send JSON-RPC notification (no response expected)
     */
    private sendNotification;
    /**
     * Handle incoming response
     */
    private handleResponse;
    /**
     * Handle incoming notification
     */
    private handleNotification;
}
