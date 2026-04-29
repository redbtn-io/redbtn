#!/usr/bin/env tsx
/**
 * MCP Servers Launcher - SSE Transport
 *
 * After Phase A + Phase B-1 of the native-tools restructure (TOOL-HANDOFF.md §2 / §4.1),
 * all bundled MCP servers (system, rag, context, web) have been deleted. Their tools
 * — fetch_url, add_document, search_documents, store_message, get_context_history,
 * web_search, scrape_url — now live as native (in-process) tools in
 * src/lib/tools/native/ and are registered by NativeToolRegistry on Red.load().
 *
 * This launcher no longer has anything to start. The `npm run mcp:start` script is
 * preserved as a no-op for backward compatibility with tooling that may still call
 * it (e.g. dev scripts, docs); it can be removed entirely once those references
 * are cleaned up.
 *
 * User-supplied MCP connections (the ones registered at runtime via
 * mcp-connections in MongoDB) are unaffected — they connect to remote MCP servers
 * the user controls.
 */

async function main() {
  console.log('[MCP Launcher] No bundled MCP servers to start — all built-in');
  console.log('[MCP Launcher] tools were ported to native (in-process) execution.');
  console.log('[MCP Launcher] See TOOL-HANDOFF.md §2 / §4.1 for details.');
  process.exit(0);
}

main();
