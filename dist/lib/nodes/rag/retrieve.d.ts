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
import { SearchConfig, SearchResult } from '../../memory/vectors';
import { InvokeOptions } from '../../../index';
/**
 * State interface for the retrieve node
 */
interface RetrieveFromVectorStoreState {
    ragQuery?: string;
    ragCollection?: string;
    ragSearchConfig?: SearchConfig;
    ragFormatContext?: boolean;
    ragMergeChunks?: boolean;
    ragResults?: SearchResult[];
    ragContext?: string;
    query?: {
        message: string;
    };
    options?: InvokeOptions;
    redInstance?: any;
    messages?: any[];
    systemMessage?: string;
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
export declare const retrieveFromVectorStoreNode: (state: RetrieveFromVectorStoreState) => Promise<Partial<RetrieveFromVectorStoreState>>;
export {};
