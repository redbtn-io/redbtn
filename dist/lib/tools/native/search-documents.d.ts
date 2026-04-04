/**
 * Search Documents — Native RAG Tool
 *
 * Searches the vector database using semantic similarity. Returns the
 * most relevant documents. Produces identical results to the MCP
 * rag-sse.ts `search_documents` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → search_documents
 */
import type { NativeToolDefinition } from '../native-registry';
declare const searchDocuments: NativeToolDefinition;
export default searchDocuments;
