/**
 * MCP Server Registry
 * Tracks available MCP servers and their capabilities
 */
import { McpClientSSE } from './client-sse';
import { Tool } from './types';
import { MessageQueue } from '../memory/queue';
export interface ServerRegistration {
    name: string;
    version: string;
    tools: Tool[];
    capabilities: Record<string, unknown> | {
        tools?: {
            listChanged?: boolean;
        };
    };
    url: string;
}
export interface ServerConfig {
    name: string;
    url: string;
}
/**
 * MCP Registry for discovering and managing server connections
 */
export declare class McpRegistry {
    private clients;
    private servers;
    private messageQueue?;
    constructor(messageQueue?: MessageQueue);
    /**
     * Register a server and connect to it
     */
    registerServer(config: ServerConfig): Promise<void>;
    /**
     * Unregister a server
     */
    unregisterServer(serverName: string): Promise<void>;
    /**
     * Get client for a server
     */
    getClient(serverName: string): McpClientSSE | undefined;
    /**
     * Get server registration info
     */
    getServer(serverName: string): ServerRegistration | undefined;
    /**
     * Get all registered servers
     */
    getAllServers(): ServerRegistration[];
    /**
     * Get all server names
     */
    getAllServerNames(): string[];
    /**
     * Find tool by name across all servers
     */
    findTool(toolName: string): {
        server: string;
        tool: Tool;
    } | undefined;
    /**
     * Get all tools from all servers
     */
    getAllTools(): Array<{
        server: string;
        tool: Tool;
    }>;
    /**
     * Call a tool (automatically finds the right server)
     * Wraps tool execution with event publishing for frontend display
     * (skips event publishing for infrastructure tools like context)
     */
    callTool(toolName: string, args: Record<string, unknown>, meta?: {
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
    }): Promise<any>;
    /**
     * Disconnect all clients
     */
    disconnectAll(): Promise<void>;
}
