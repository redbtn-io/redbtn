/**
 * Native Tool Registry
 *
 * Native tools run in-process with direct access to the RunPublisher
 * for real-time streaming. No MCP protocol overhead, no timeouts.
 *
 * The native path is checked BEFORE the MCP path in toolExecutor.
 * Results are returned in MCP-compatible format so no special handling
 * is required downstream.
 */
type AnyObject = Record<string, any>;
export interface NativeToolContext {
    /** RunPublisher instance for streaming events — null if not in a run context */
    publisher: AnyObject | null;
    /** Current graph state */
    state: AnyObject;
    /** Current run ID */
    runId: string | null;
    /** Graph node ID that invoked the tool */
    nodeId: string | null;
    /** Unique tool execution ID — use with publisher.toolProgress(toolId, ...) */
    toolId: string | null;
    /** AbortSignal for cancellation support */
    abortSignal: AbortSignal | null;
    /** Callback for real-time chunk interception (used by stream parsers) */
    onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    /**
     * Resolved connection credentials from UserConnection.
     * Present when the tool step config specifies connectionId or providerId.
     * Contains auth headers and raw credentials for authenticated API calls.
     */
    credentials?: {
        type: 'api_key' | 'bearer' | 'basic' | 'custom';
        headers: Record<string, string>;
        providerId: string;
        connectionId: string;
        accountInfo?: {
            email?: string;
            name?: string;
            externalId?: string;
        };
    } | null;
}
export interface NativeMcpResult {
    content: Array<{
        type: 'text';
        text: string;
    }>;
    isError?: boolean;
}
export interface NativeToolDefinition {
    /** Human-readable description shown in the UI */
    description: string;
    /** JSON Schema for input validation */
    inputSchema: AnyObject;
    /** Source server name for grouping in UI */
    server?: string;
    /** The actual tool implementation */
    handler: (args: AnyObject, context: NativeToolContext) => Promise<NativeMcpResult>;
}
export interface NativeToolInfo {
    name: string;
    description: string;
    inputSchema: AnyObject;
    server: string;
}
export declare class NativeToolRegistry {
    private tools;
    /**
     * Register a native tool definition.
     * The name must match what graphs use in their toolName step config.
     */
    register(name: string, definition: NativeToolDefinition): void;
    has(name: string): boolean;
    get(name: string): NativeToolDefinition | undefined;
    /**
     * List all registered native tools in MCP-compatible format.
     */
    listTools(): NativeToolInfo[];
    /**
     * Invoke a native tool handler with the given args and context.
     */
    callTool(name: string, args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult>;
}
/**
 * Get the shared NativeToolRegistry singleton.
 * Lazily registers all built-in native tools on first call.
 */
export declare function getNativeRegistry(): NativeToolRegistry;
export {};
