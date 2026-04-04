/**
 * Web MCP Server - SSE Transport
 * Combines web search and URL scraping capabilities
 */
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
export declare class WebServerSSE extends McpServerSSE {
    private googleApiKey;
    private googleSearchEngineId;
    constructor(name: string, version: string, port?: number, googleApiKey?: string, googleSearchEngineId?: string);
    /**
     * Setup tools
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
    /**
     * Execute web_search tool
     */
    private executeWebSearch;
    /**
     * Execute scrape_url tool
     */
    private executeScrapeUrl;
}
