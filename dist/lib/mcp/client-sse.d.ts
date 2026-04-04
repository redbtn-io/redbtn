/**
 * MCP Client - SSE Transport
 * Connects to MCP servers over HTTP/SSE
 */
import { InitializeResult, ToolsListResult, CallToolResult, Resource, ResourceContents } from './types';
export declare class McpClientSSE {
    private serverUrl;
    private serverName;
    private sessionId;
    private requestId;
    constructor(serverUrl: string, serverName: string);
    /**
     * Connect to MCP server (just validates connection)
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
     * Call a tool
     */
    callTool(name: string, args: Record<string, unknown>, meta?: {
        conversationId?: string;
        generationId?: string;
        messageId?: string;
        credentials?: {
            type: string;
            headers: Record<string, string>;
            providerId: string;
            connectionId: string;
            accountInfo?: {
                email?: string;
                name?: string;
                externalId?: string;
            };
        };
    }): Promise<CallToolResult>;
    /**
     * List available resources
     */
    listResources(): Promise<{
        resources: Resource[];
    }>;
    /**
     * Read a resource
     */
    readResource(params: {
        uri: string;
    }): Promise<{
        contents: ResourceContents[];
    }>;
    /**
     * Send JSON-RPC request
     */
    private sendRequest;
    /**
     * Send JSON-RPC notification (no response expected)
     */
    private sendNotification;
}
