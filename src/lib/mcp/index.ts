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
// system-sse, rag-sse, context-sse deleted in Phase A of native-tools restructure.
// web-sse deleted in Phase B-1 (web pack) — see TOOL-HANDOFF.md §2 / §4.1.
// Their tools (fetch_url, add_document, search_documents, store_message,
// get_context_history, web_search, scrape_url) live as native tools in
// src/lib/tools/native/. The unused tools (delete_documents, list_collections,
// get_collection_stats, get_summary, get_messages, get_conversation_metadata)
// were dropped.
// event-publisher (McpEventPublisher / tool:event:* Redis key) removed in v0.0.51-alpha.
// McpEventPublisher was never instantiated; RunPublisher handles all tool events now.
