/**
 * MCP Types - JSON-RPC 2.0 over Redis
 * Based on Model Context Protocol specification
 */

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 Response
 */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Notification (no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 Error
 */
export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

/**
 * MCP Server Info
 */
export interface ServerInfo {
  name: string;
  version: string;
}

/**
 * MCP Capabilities
 */
export interface ServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
}

/**
 * MCP Tool Definition
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool Call Result Content
 */
export interface ToolContent {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * Tool Call Result
 */
export interface CallToolResult {
  content: ToolContent[];
  isError?: boolean;
}

/**
 * Initialize Request Params
 */
export interface InitializeParams {
  protocolVersion: string;
  capabilities: {
    elicitation?: Record<string, unknown>;
    sampling?: Record<string, unknown>;
  };
  clientInfo: {
    name: string;
    version: string;
  };
}

/**
 * Initialize Response Result
 */
export interface InitializeResult {
  protocolVersion: string;
  capabilities: ServerCapabilities;
  serverInfo: ServerInfo;
}

/**
 * Tools List Result
 */
export interface ToolsListResult {
  tools: Tool[];
}

/**
 * Tool Call Params
 */
export interface ToolCallParams {
  name: string;
  arguments: Record<string, unknown>;
  _meta?: {
    conversationId?: string;
    generationId?: string;
    messageId?: string;
  };
}
