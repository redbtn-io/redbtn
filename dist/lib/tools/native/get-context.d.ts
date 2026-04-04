/**
 * Get Context — Native Context Tool
 *
 * Builds formatted conversation context for LLM consumption.
 * Automatically manages token limits, includes summaries, and formats
 * messages. Produces identical results to the MCP context-sse.ts
 * `get_context_history` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → get_context_history
 */
import type { NativeToolDefinition } from '../native-registry';
declare const getContext: NativeToolDefinition;
export default getContext;
