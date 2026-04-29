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
// system-sse, rag-sse, context-sse deleted in Phase A of native-tools restructure.
// Their tools (fetch_url, add_document, search_documents, store_message,
// get_context_history) live as native tools in src/lib/tools/native/. The unused
// tools (delete_documents, list_collections, get_collection_stats, get_summary,
// get_messages, get_conversation_metadata) were dropped — see TOOL-HANDOFF.md §2.
// event-publisher (McpEventPublisher / tool:event:* Redis key) removed in v0.0.51-alpha.
// McpEventPublisher was never instantiated; RunPublisher handles all tool events now.

// Legacy exports for backward compatibility
export { WebServerSSE as WebServer } from './servers/web-sse';
export { WebServerSSE as WebSearchServer } from './servers/web-sse';
