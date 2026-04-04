/**
 * System MCP Server - SSE Transport
 * Provides HTTP fetch capabilities. Command execution removed for security
 * — use the native ssh_shell tool for remote command execution instead.
 */
import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
export declare class SystemServerSSE extends McpServerSSE {
    constructor(name: string, version: string, port?: number);
    /**
     * Setup tools
     */
    protected setup(): Promise<void>;
    /**
     * Execute tool
     */
    protected executeTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
    /**
     * Fetch a URL via HTTP
     */
    private fetchUrl;
}
