/**
 * MCP Server Base Class - SSE Transport
 * Implements MCP protocol over HTTP with Server-Sent Events
 */
import express from 'express';
import { Server as HttpServer } from 'http';
import { ServerInfo, ServerCapabilities, Tool, CallToolResult, Resource, ResourceContents } from './types';
export declare abstract class McpServerSSE {
    protected app: express.Application;
    protected server: HttpServer | null;
    protected serverInfo: ServerInfo;
    protected capabilities: ServerCapabilities;
    protected tools: Map<string, Tool>;
    protected resources: Map<string, Resource>;
    private port;
    private endpoint;
    private running;
    private sseConnections;
    constructor(name: string, version: string, port: number, endpoint?: string);
    /**
     * Setup HTTP routes for MCP protocol
     */
    private setupRoutes;
    /**
     * Start the MCP server
     */
    start(): Promise<void>;
    /**
     * Stop the MCP server
     */
    stop(): Promise<void>;
    /**
     * Setup method - subclasses override to define tools and resources
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
     * Read resource - subclasses override to implement resource reading
     */
    protected readResource(uri: string): Promise<ResourceContents[]>;
    /**
     * Define a tool
     */
    protected defineTool(tool: Tool): void;
    /**
     * Define a resource
     */
    protected defineResource(resource: Resource): void;
    /**
     * Handle incoming JSON-RPC request
     */
    private handleRequest;
    /**
     * Handle initialize request
     */
    private handleInitialize;
    /**
     * Handle tools/list request
     */
    private handleListTools;
    /**
     * Handle tools/call request
     */
    private handleCallTool;
    /**
     * Handle resources/list request
     */
    private handleListResources;
    /**
     * Handle resources/read request
     */
    private handleReadResource;
    /**
     * Send event to all connected clients (for future notifications)
     */
    protected sendEventToAll(event: string, data: any): void;
}
