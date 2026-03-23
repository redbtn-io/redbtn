/**
 * Search Documents — Native RAG Tool
 *
 * Searches the vector database using semantic similarity. Returns the
 * most relevant documents. Produces identical results to the MCP
 * rag-sse.ts `search_documents` handler.
 *
 * Ported from: src/lib/mcp/servers/rag-sse.ts → search_documents
 */

import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';
import { VectorStoreManager, SearchConfig } from '../../memory/vectors';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SearchDocumentsArgs {
  query: string;
  collection?: string;
  topK?: number;
  threshold?: number;
  filter?: Record<string, any>;
  mergeChunks?: boolean;
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

/**
 * Group results by source and merge overlapping chunks.
 * Identical algorithm to rag-sse.ts groupAndMergeResults + mergeOverlappingChunks.
 */
function groupAndMergeResults(results: AnyObject[]): AnyObject[] {
  const groupedBySource = new Map<string, AnyObject[]>();

  for (const result of results) {
    const source = result.metadata?.source || 'unknown';
    if (!groupedBySource.has(source)) {
      groupedBySource.set(source, []);
    }
    groupedBySource.get(source)!.push(result);
  }

  const mergedResults: AnyObject[] = [];

  for (const [, sourceResults] of groupedBySource) {
    sourceResults.sort((a, b) => {
      const aIndex = a.metadata?.chunkIndex ?? -1;
      const bIndex = b.metadata?.chunkIndex ?? -1;
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      return b.score - a.score;
    });

    const textChunks = sourceResults.map((r) => r.text);
    const mergedText = mergeOverlappingChunks(textChunks);
    const avgScore =
      sourceResults.reduce((sum, r) => sum + r.score, 0) / sourceResults.length;

    mergedResults.push({
      id: sourceResults[0].id,
      text: mergedText,
      metadata: {
        ...sourceResults[0].metadata,
        mergedChunks: sourceResults.length,
        avgScore,
      },
      score: avgScore,
      distance: sourceResults[0].distance,
    });
  }

  mergedResults.sort((a, b) => b.score - a.score);
  return mergedResults;
}

function mergeOverlappingChunks(chunks: string[]): string {
  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0];

  let merged = chunks[0];

  for (let i = 1; i < chunks.length; i++) {
    const currentChunk = chunks[i];
    let bestOverlapLength = 0;

    const minOverlap = 50;
    const maxOverlap = Math.floor(
      Math.min(merged.length, currentChunk.length) * 0.8
    );

    for (let overlapLen = maxOverlap; overlapLen >= minOverlap; overlapLen--) {
      const endOfMerged = merged.slice(-overlapLen);
      const startOfCurrent = currentChunk.slice(0, overlapLen);

      if (endOfMerged === startOfCurrent) {
        bestOverlapLength = overlapLen;
        break;
      }
    }

    if (bestOverlapLength > 0) {
      merged += currentChunk.slice(bestOverlapLength);
    } else {
      merged += '\n\n' + currentChunk;
    }
  }

  return merged;
}

const searchDocuments: NativeToolDefinition = {
  description:
    'Search the vector database using semantic similarity. Returns the most relevant documents for a query.',
  server: 'rag',

  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query (natural language question or keywords)',
      },
      collection: {
        type: 'string',
        description: 'Collection name to search in (default: "general")',
        default: 'general',
      },
      topK: {
        type: 'number',
        description: 'Maximum number of results to return (default: 5)',
        default: 5,
      },
      threshold: {
        type: 'number',
        description: 'Minimum similarity threshold 0-1 (default: 0.7)',
        default: 0.7,
      },
      filter: {
        type: 'object',
        description: 'Metadata filter to narrow results (e.g., {"category": "api"})',
        additionalProperties: true,
      },
      mergeChunks: {
        type: 'boolean',
        description: 'Merge overlapping chunks from same source (default: true)',
        default: true,
      },
    },
    required: ['query'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as SearchDocumentsArgs;
    const {
      query,
      collection = 'general',
      topK = 5,
      threshold = 0.7,
      filter,
      mergeChunks = true,
    } = args;

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'search_documents';
    const startTime = Date.now();

    console.log(`[search_documents] query="${query.substring(0, 80)}", collection=${collection}`);

    if (!query || query.trim().length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No query provided' }],
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

      // Perform search
      const searchConfig: SearchConfig = { topK, threshold, filter };
      const results = await vs.search(collection, query, searchConfig);

      // Merge chunks if requested
      let processedResults = results as AnyObject[];
      if (mergeChunks && results.length > 0) {
        processedResults = groupAndMergeResults(results as AnyObject[]);
      }

      const duration = Date.now() - startTime;
      console.log(
        `[search_documents] ${processedResults.length} results in ${duration}ms`
      );

      // Stream progress via RunPublisher
      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[search_documents] ${processedResults.length} results from "${collection}" (${duration}ms)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
      }

      if (processedResults.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No relevant documents found in collection "${collection}" for query: "${query}"`,
            },
          ],
        };
      }

      // Build formatted response (same format as rag-sse.ts)
      let resultText = `# Search Results for: "${query}"\n\n`;
      resultText += `Found ${processedResults.length} relevant document(s) in collection "${collection}":\n\n`;

      for (let i = 0; i < processedResults.length; i++) {
        const result = processedResults[i];
        const relevance = (result.score * 100).toFixed(1);
        const source = result.metadata?.source || 'unknown';
        const mergedCount = result.metadata?.mergedChunks;
        const mergeInfo = mergedCount > 1 ? ` (${mergedCount} chunks merged)` : '';

        resultText += `## Result ${i + 1} - ${relevance}% relevant${mergeInfo}\n`;
        resultText += `**Source:** ${source}\n\n`;
        resultText += `${result.text}\n\n`;
        resultText += `---\n\n`;
      }

      return {
        content: [{ type: 'text', text: resultText }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[search_documents] Error: ${msg}`);

      return {
        content: [{ type: 'text', text: `Search failed: ${msg}` }],
        isError: true,
      };
    }
  },
};

export default searchDocuments;
module.exports = searchDocuments;
