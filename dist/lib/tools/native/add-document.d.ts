/**
 * Add Document — Native RAG Tool
 *
 * Adds a document to the vector database. Automatically chunks large
 * documents and generates embeddings. Produces identical results to
 * the MCP rag-sse.ts `add_document` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → add_document
 */
import type { NativeToolDefinition } from '../native-registry';
declare const addDocument: NativeToolDefinition;
export default addDocument;
