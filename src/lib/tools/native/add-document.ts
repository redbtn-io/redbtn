/**
 * Add Document — Native RAG Tool
 *
 * Adds a document to the vector database. Automatically chunks large
 * documents and generates embeddings. Produces identical results to
 * the MCP rag-sse.ts `add_document` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → add_document
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { VectorStoreManager, ChunkingConfig } from '../../memory/vectors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface AddDocumentArgs {
  text: string;
  collection?: string;
  source?: string;
  metadata?: Record<string, any>;
  chunkSize?: number;
  chunkOverlap?: number;
}

let _vectorStore: VectorStoreManager | null = null;

function getVectorStore(): VectorStoreManager {
  if (!_vectorStore) {
    const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8024';
    const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    _vectorStore = new VectorStoreManager(chromaUrl, ollamaUrl);
  }
  return _vectorStore;
}

const addDocument: NativeToolDefinition = {
  description:
    'Add a document to the vector database for semantic search. Automatically chunks large documents and generates embeddings.',
  server: 'rag',

  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The document text to add (will be automatically chunked if large)',
      },
      collection: {
        type: 'string',
        description: 'Collection name to add to (e.g., "documentation", "articles")',
        default: 'general',
      },
      source: {
        type: 'string',
        description: 'Source identifier (URL, file path, or description)',
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata (title, author, date, category, etc.)',
        additionalProperties: true,
      },
      chunkSize: {
        type: 'number',
        description: 'Chunk size in characters (default: 2000)',
        default: 2000,
      },
      chunkOverlap: {
        type: 'number',
        description: 'Overlap between chunks in characters (default: 200)',
        default: 200,
      },
    },
    required: ['text'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as AddDocumentArgs;
    const {
      text,
      collection = 'general',
      source = 'unknown',
      metadata = {},
      chunkSize = 2000,
      chunkOverlap = 200,
    } = args;

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'add_document';
    const startTime = Date.now();

    console.log(
      `[add_document] collection=${collection}, textLength=${text?.length}, source=${source}`
    );

    if (!text || text.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No text provided' }],
        isError: true,
      };
    }

    try {
      const vs = getVectorStore();

      // Health check
      const isHealthy = await vs.healthCheck();
      if (!isHealthy) {
        throw new Error('ChromaDB is not accessible');
      }

      // Prepare metadata
      const fullMetadata = {
        ...metadata,
        source,
        addedAt: Date.now(),
      };

      // Prepare chunking config
      const chunkingConfig: ChunkingConfig = {
        chunkSize,
        chunkOverlap,
        preserveParagraphs: true,
      };

      // Stream progress via RunPublisher
      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[add_document] Chunking and embedding ${text.length} chars into "${collection}"...\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      // Add document (this will automatically chunk and embed)
      const chunksAdded = await vs.addDocument(
        collection,
        text,
        fullMetadata,
        chunkingConfig
      );

      const duration = Date.now() - startTime;
      console.log(
        `[add_document] Added ${chunksAdded} chunks to "${collection}" in ${duration}ms`
      );

      // Stream completion via RunPublisher
      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[add_document] ${chunksAdded} chunks added (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      const result =
        `Successfully added document to collection "${collection}".\n` +
        `- Text length: ${text.length} characters\n` +
        `- Chunks created: ${chunksAdded}\n` +
        `- Source: ${source}\n` +
        `- Duration: ${duration}ms`;

      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[add_document] Error: ${msg}`);

      return {
        content: [{ type: 'text', text: `Failed to add document: ${msg}` }],
        isError: true,
      };
    }
  },
};

export default addDocument;
module.exports = addDocument;
