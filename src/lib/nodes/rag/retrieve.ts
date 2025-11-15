/**
 * @file src/lib/nodes/rag/retrieve.ts
 * @description LangGraph node for retrieving relevant context from the vector store
 * 
 * This node handles:
 * - Semantic similarity search using embeddings
 * - Context retrieval with configurable threshold
 * - Metadata filtering for scoped searches
 * - Result ranking by similarity score
 * - Automatic merging of overlapping chunks from the same source
 * - Automatic context formatting for LLM consumption
 * 
 * Input state requirements:
 * - ragQuery: string (the search query)
 * - ragCollection: string (collection name, defaults to 'general')
 * - ragSearchConfig?: { topK?: number, threshold?: number, filter?: object }
 * - ragFormatContext?: boolean (auto-format for LLM, default: true)
 * - ragMergeChunks?: boolean (merge overlapping chunks, default: true)
 * 
 * Output state:
 * - ragResults: Array of search results with scores
 * - ragContext: Formatted context string for LLM (if ragFormatContext=true)
 * - messages: Updated with context injection (if query message exists)
 */

import { VectorStoreManager, SearchConfig, SearchResult } from '../../memory/vectors';
import { InvokeOptions } from '../../../index';

/**
 * State interface for the retrieve node
 */
interface RetrieveFromVectorStoreState {
  // Input: search query
  ragQuery?: string;
  
  // Input: collection name (defaults to 'general')
  ragCollection?: string;
  
  // Input: optional search configuration
  ragSearchConfig?: SearchConfig;
  
  // Input: whether to format context for LLM (default: true)
  ragFormatContext?: boolean;
  
  // Input: whether to merge overlapping chunks (default: true)
  ragMergeChunks?: boolean;
  
  // Output: raw search results
  ragResults?: SearchResult[];
  
  // Output: formatted context string
  ragContext?: string;
  
  // Standard graph state
  query?: { message: string };
  options?: InvokeOptions;
  redInstance?: any;
  messages?: any[];
  systemMessage?: string;
}

/**
 * Detect and merge overlapping text chunks
 * @param chunks Array of text chunks that may have overlaps
 * @returns Merged text with overlaps removed
 */
function mergeOverlappingChunks(chunks: string[]): string {
  if (chunks.length === 0) return '';
  if (chunks.length === 1) return chunks[0];

  let merged = chunks[0];

  for (let i = 1; i < chunks.length; i++) {
    const currentChunk = chunks[i];
    let bestOverlapLength = 0;
    
    // Try to find overlap between end of merged text and start of current chunk
    // Check overlaps from 50 chars up to 80% of the shorter text
    const minOverlap = 50;
    const maxOverlap = Math.floor(Math.min(merged.length, currentChunk.length) * 0.8);
    
    for (let overlapLen = maxOverlap; overlapLen >= minOverlap; overlapLen--) {
      const endOfMerged = merged.slice(-overlapLen);
      const startOfCurrent = currentChunk.slice(0, overlapLen);
      
      // If we find a match, this is the overlap
      if (endOfMerged === startOfCurrent) {
        bestOverlapLength = overlapLen;
        break;
      }
    }

    if (bestOverlapLength > 0) {
      // Merge by appending only the non-overlapping part
      merged += currentChunk.slice(bestOverlapLength);
      console.log(`[RAG Retrieve] Merged chunks with ${bestOverlapLength} char overlap`);
    } else {
      // No overlap found, add separator and append
      merged += '\n\n' + currentChunk;
    }
  }

  return merged;
}

/**
 * Group results by source and merge overlapping chunks from the same document
 * @param results Search results to group and merge
 * @returns Array of merged results grouped by source
 */
function groupAndMergeResults(results: SearchResult[]): SearchResult[] {
  // Group by source
  const groupedBySource = new Map<string, SearchResult[]>();
  
  for (const result of results) {
    const source = result.metadata?.source || 'unknown';
    if (!groupedBySource.has(source)) {
      groupedBySource.set(source, []);
    }
    groupedBySource.get(source)!.push(result);
  }

  // Merge chunks from the same source
  const mergedResults: SearchResult[] = [];
  
  for (const [source, sourceResults] of groupedBySource) {
    // Sort by chunk index if available, otherwise by score
    sourceResults.sort((a, b) => {
      const aIndex = a.metadata?.chunkIndex ?? -1;
      const bIndex = b.metadata?.chunkIndex ?? -1;
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      return b.score - a.score; // Higher score first
    });

    // Extract text chunks
    const textChunks = sourceResults.map(r => r.text);
    
    // Merge overlapping chunks
    const mergedText = mergeOverlappingChunks(textChunks);
    
    // Calculate average score
    const avgScore = sourceResults.reduce((sum, r) => sum + r.score, 0) / sourceResults.length;
    
    // Create merged result
    mergedResults.push({
      id: sourceResults[0].id,
      text: mergedText,
      metadata: {
        ...sourceResults[0].metadata,
        mergedChunks: sourceResults.length,
        avgScore
      },
      score: avgScore,
      distance: sourceResults[0].distance
    });
  }

  // Sort by score
  mergedResults.sort((a, b) => b.score - a.score);
  
  return mergedResults;
}

/**
 * Format search results into LLM-friendly context
 * @param results Search results to format
 * @param query Original query for context
 * @param mergeChunks Whether to merge overlapping chunks (default: true)
 * @returns Formatted context string
 */
function formatContextForLLM(results: SearchResult[], query: string, mergeChunks: boolean = true): string {
  if (results.length === 0) {
    return '';
  }

  // Group and merge overlapping chunks from the same source if enabled
  const processedResults = mergeChunks ? groupAndMergeResults(results) : results;

  const sections = processedResults.map((result, index) => {
    const source = result.metadata?.source || 'unknown';
    const relevance = (result.score * 100).toFixed(1);
    const mergedCount = result.metadata?.mergedChunks || 1;
    const mergeInfo = mergedCount > 1 ? ` (${mergedCount} chunks merged)` : '';
    
    return `### Retrieved Context ${index + 1} (${relevance}% relevant)${mergeInfo}\n` +
           `Source: ${source}\n\n` +
           `${result.text}\n`;
  });

  const header = `# Relevant Context for Query: "${query}"\n\n` +
                 `The following ${processedResults.length} document(s) were retrieved from the knowledge base:\n\n`;

  return header + sections.join('\n---\n\n');
}

/**
 * Node for retrieving relevant context from the vector store
 * 
 * Usage in graph:
 * ```typescript
 * .addNode("retrieveFromVectorStore", retrieveFromVectorStoreNode)
 * ```
 * 
 * Example state:
 * ```typescript
 * {
 *   ragQuery: "What are the benefits of RAG?",
 *   ragCollection: "articles",
 *   ragSearchConfig: {
 *     topK: 5,
 *     threshold: 0.7,
 *     filter: { category: "ai" }
 *   },
 *   ragFormatContext: true
 * }
 * ```
 * 
 * The node will:
 * 1. Search the vector store for similar documents
 * 2. Filter by similarity threshold
 * 3. Format results into LLM-friendly context
 * 4. Optionally inject context into system message
 */
export const retrieveFromVectorStoreNode = async (
  state: RetrieveFromVectorStoreState
): Promise<Partial<RetrieveFromVectorStoreState>> => {
  const redInstance = state.redInstance;
  const options = state.options || {};
  const generationId = options.generationId;
  const conversationId = options.conversationId;

  try {
    // Determine query: use ragQuery if provided, otherwise extract from state.query
    const queryText = state.ragQuery || state.query?.message;
    
    if (!queryText) {
      throw new Error('No query provided in ragQuery or query.message');
    }

    const collectionName = state.ragCollection || 'general';
    const searchConfig = state.ragSearchConfig || {};
    const shouldFormatContext = state.ragFormatContext !== false; // Default: true
    const shouldMergeChunks = state.ragMergeChunks !== false; // Default: true

    // Log operation start
    if (redInstance?.logger) {
      await redInstance.logger.log({
        level: 'info',
        category: 'rag',
        message: `<cyan>🔍 Retrieving context from vector store...</cyan>`,
        generationId,
        conversationId,
        metadata: {
          collection: collectionName,
          query: queryText.substring(0, 100)
        }
      });
    }

    // Initialize vector store manager
    const vectorStore = new VectorStoreManager(
      redInstance?.config?.vectorDbUrl || process.env.CHROMA_URL || 'http://localhost:8024',
      redInstance?.config?.chatLlmUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
    );

    // Health check
    const isHealthy = await vectorStore.healthCheck();
    if (!isHealthy) {
      throw new Error('ChromaDB is not accessible. Check connection.');
    }

    // Perform search
    const results = await vectorStore.search(
      collectionName,
      queryText,
      searchConfig
    );

    // Format context if requested
    let formattedContext = '';
    let mergedCount = results.length;
    
    if (shouldFormatContext && results.length > 0) {
      formattedContext = formatContextForLLM(results, queryText, shouldMergeChunks);
      // Count merged results (groupAndMergeResults reduces the count)
      if (shouldMergeChunks) {
        const mergedResults = groupAndMergeResults(results);
        mergedCount = mergedResults.length;
      }
    }

    // Log results
    if (redInstance?.logger) {
      const avgScore = results.length > 0
        ? (results.reduce((sum, r) => sum + r.score, 0) / results.length * 100).toFixed(1)
        : 0;

      const mergeInfo = mergedCount < results.length 
        ? ` <dim>(${results.length} chunks → ${mergedCount} merged documents)</dim>`
        : '';

      await redInstance.logger.log({
        level: 'success',
        category: 'rag',
        message: `<green>✓ Retrieved ${results.length} relevant chunk(s)</green>${mergeInfo} <dim>(avg relevance: ${avgScore}%)</dim>`,
        generationId,
        conversationId,
        metadata: {
          collection: collectionName,
          chunksRetrieved: results.length,
          documentsMerged: mergedCount,
          averageScore: avgScore
        }
      });
    }

    // Prepare output state
    const outputState: Partial<RetrieveFromVectorStoreState> = {
      ragResults: results,
      ragContext: formattedContext
    };

    // Optionally inject context into system message
    if (shouldFormatContext && formattedContext && results.length > 0) {
      // If there's an existing system message, append the context
      const existingSystemMessage = state.systemMessage || '';
      const contextInstruction = '\n\n# IMPORTANT: Retrieved Context\n\n' +
        'The following context has been retrieved from the knowledge base and is highly relevant to the user\'s query. ' +
        'Use this information to provide accurate, well-informed responses.\n\n' +
        formattedContext;
      
      outputState.systemMessage = existingSystemMessage + contextInstruction;

      console.log('[RAG Retrieve] Injected context into system message');
    }

    return outputState;

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Log error
    if (redInstance?.logger) {
      await redInstance.logger.log({
        level: 'error',
        category: 'rag',
        message: `<red>✗ Failed to retrieve from vector store:</red> ${errorMessage}`,
        generationId,
        conversationId,
        metadata: { error: errorMessage }
      });
    }

    console.error('[RAG Retrieve Node] Error:', errorMessage);

    return {
      ragResults: [],
      ragContext: ''
    };
  }
};
