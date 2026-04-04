/**
 * MCP Server Base Class
 * Implements JSON-RPC 2.0 over Redis transport
 */
import { Redis } from 'ioredis';
import { ServerInfo, ServerCapabilities, Tool, CallToolResult } from './types';
export declare abstract class McpServer {
    protected redis: Redis;
    protected publishRedis: Redis;
    protected serverInfo: ServerInfo;
    protected capabilities: ServerCapabilities;
    protected tools: Map<string, Tool>;
    private requestChannel;
    private responseChannel;
    private running;
    constructor(redis: Redis, name: string, version: string);
    /**
     * Start the MCP server
     */
    start(): Promise<void>;
    /**
     * Stop the MCP server
     */
    stop(): Promise<void>;
    /**
     * Setup method - subclasses override to define tools
     */
    protected abstract setup(): Promise<void>;
    /**
     * Execute tool - subclasses override to implement tool logic
     */
    protected abstract executeTool(name: string, args: Record<string, unknown>, meta?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
    }): Promise<CallToolResult>;
    /**
     * Define a tool
     */
    protected defineTool(tool: Tool): void;
    /**
     * Handle incoming JSON-RPC message
     */
    private handleMessage;
    /**
     * Handle JSON-RPC request
     */
    private handleRequest;
    /**
     * Handle notification (no response)
     */
    private handleNotification;
    /**
     * Handle initialize request
     */
    private handleInitialize;
    /**
     * Handle tools/list request
     */
    private handleToolsList;
    /**
     * Handle tools/call request
     */
    private handleToolCall;
    /**
     * Send JSON-RPC response
     */
    private sendResponse;
    /**
     * Send JSON-RPC notification
     */
    protected sendNotification(method: string, params?: Record<string, unknown>): Promise<void>;
}
