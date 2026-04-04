/**
 * Store Message — Native Context Tool
 *
 * Stores a message in conversation history via MemoryManager.
 * Persists to both Redis cache and MongoDB. Produces identical results
 * to the MCP context-sse.ts `store_message` handler.
 *
 * Ported from: src/lib/mcp/servers/context-sse.ts → store_message
 */
import type { NativeToolDefinition } from '../native-registry';
declare const storeMessage: NativeToolDefinition;
export default storeMessage;
