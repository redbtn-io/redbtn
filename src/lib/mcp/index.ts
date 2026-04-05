/**
 * MCP (Model Context Protocol) over Redis
 *
 * A Redis-based implementation of the Model Context Protocol that allows
 * tools to run as independent processes and communicate via Redis pub/sub
 * using JSON-RPC 2.0.
 */

export * from './types';
export * from './server';
export * from './client';
export * from './registry';
export * from './servers/web-sse';
export * from './servers/system-sse';
export * from './servers/rag-sse';
export * from './servers/context-sse';
// event-publisher (McpEventPublisher / tool:event:* Redis key) removed in v0.0.51-alpha.
// McpEventPublisher was never instantiated; RunPublisher handles all tool events now.

// Legacy exports for backward compatibility
export { WebServerSSE as WebServer } from './servers/web-sse';
export { WebServerSSE as WebSearchServer } from './servers/web-sse';
export { SystemServerSSE as SystemServer } from './servers/system-sse';
export { SystemServerSSE as SystemCommandServer } from './servers/system-sse';
