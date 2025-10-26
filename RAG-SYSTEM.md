# RAG (Retrieval-Augmented Generation) System

## Overview

The RAG system enables your AI to access and use external knowledge stored in a vector database. It combines semantic search with language generation to provide contextually relevant, factually grounded responses.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         RAG Pipeline                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. INDEXING (Offline)                                         │
│     ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│     │Documents │ -> │ Chunking │ -> │Embeddings│ -> ChromaDB  │
│     └──────────┘    └──────────┘    └──────────┘             │
│                                                                 │
│  2. RETRIEVAL (Query Time)                                     │
│     ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│     │  Query   │ -> │Embedding │ -> │Similarity│ -> Results   │
│     └──────────┘    └──────────┘    │  Search  │             │
│                                      └──────────┘             │
│                                                                 │
│  3. GENERATION                                                 │
│     ┌──────────┐    ┌──────────┐    ┌──────────┐             │
│     │Retrieved │ -> │ Inject   │ -> │   LLM    │ -> Response │
│     │ Context  │    │ Context  │    └──────────┘             │
│     └──────────┘    └──────────┘                              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Vector Store Manager (`vectors.ts`)

Main class for managing vector storage and retrieval.

**Key Features:**
- Text chunking with configurable size and overlap
- Embedding generation via Ollama
- Semantic similarity search
- Collection management
- Token counting and validation

### 2. RAG Nodes (`nodes/rag/`)

LangGraph nodes for adding and retrieving documents.

**Nodes:**
- `addToVectorStoreNode` - Add documents to ChromaDB
- `retrieveFromVectorStoreNode` - Semantic search and context retrieval

## Setup

### Prerequisites

1. **ChromaDB** (Vector Database)
```bash
# Using Docker
docker run -p 8024:8000 chromadb/chroma

# Or using Python
pip install chromadb
chroma run --host 0.0.0.0 --port 8024
```

2. **Ollama** (Embedding Model)
```bash
# Pull embedding model
ollama pull nomic-embed-text

# Or use a larger model
ollama pull mxbai-embed-large
```

### Installation

```bash
cd ai
npm install chromadb --legacy-peer-deps
```

### Configuration

Set environment variables:
```bash
CHROMA_URL=http://localhost:8024
OLLAMA_BASE_URL=http://localhost:11434
```

Or configure in code:
```typescript
const red = new Red({
  vectorDbUrl: 'http://localhost:8024',
  chatLlmUrl: 'http://localhost:11434',
  // ... other config
});
```

## Usage

### Basic Usage - Vector Store Manager

```typescript
import { VectorStoreManager } from '@redbtn/ai';

// Initialize
const vectorStore = new VectorStoreManager(
  'http://localhost:8024',  // ChromaDB URL
  'http://localhost:11434'   // Ollama URL
);

// Add a document (automatically chunks it)
await vectorStore.addDocument(
  'my-collection',           // collection name
  longDocumentText,          // text content
  {                          // metadata
    source: 'https://example.com',
    title: 'Example Article',
    author: 'John Doe'
  },
  {                          // chunking config
    chunkSize: 1500,
    chunkOverlap: 150,
    preserveParagraphs: true
  }
);

// Search for relevant context
const results = await vectorStore.search(
  'my-collection',
  'What is RAG?',
  {
    topK: 5,                 // return top 5 results
    threshold: 0.7,          // minimum similarity score
    filter: {                // optional metadata filter
      category: 'ai'
    }
  }
);

// Use results
results.forEach(result => {
  console.log(`Score: ${result.score}`);
  console.log(`Text: ${result.text}`);
  console.log(`Metadata:`, result.metadata);
});
```

### Using RAG Nodes in LangGraph

```typescript
import { StateGraph, Annotation } from '@langchain/langgraph';
import { addToVectorStoreNode, retrieveFromVectorStoreNode } from '@redbtn/ai';

// Define state
const GraphState = Annotation.Root({
  query: Annotation<object>,
  ragQuery: Annotation<string>,
  ragCollection: Annotation<string>,
  ragResults: Annotation<any[]>,
  ragContext: Annotation<string>,
  redInstance: Annotation<any>,
  // ... other state fields
});

// Build graph
const graph = new StateGraph(GraphState)
  .addNode('retrieve', retrieveFromVectorStoreNode)
  .addNode('chat', chatNode)
  .addEdge('__start__', 'retrieve')
  .addEdge('retrieve', 'chat')
  .addEdge('chat', '__end__')
  .compile();

// Use graph
const result = await graph.invoke({
  ragQuery: 'What is RAG?',
  ragCollection: 'knowledge-base',
  ragSearchConfig: {
    topK: 3,
    threshold: 0.7
  },
  redInstance: red
});
```

### Integrating RAG with Respond Function

```typescript
// Add documents to knowledge base
const vectorStore = new VectorStoreManager();
await vectorStore.addDocument(
  'company-docs',
  documentText,
  { source: 'internal-wiki' }
);

// In your graph, retrieve before generating response
const retrieveState = {
  ragQuery: userQuery,
  ragCollection: 'company-docs',
  ragFormatContext: true,  // Auto-format for LLM
  redInstance: red
};

const retrieved = await retrieveFromVectorStoreNode(retrieveState);

// The retrieved context is automatically injected into systemMessage
// which gets used by the chat node
```

## Text Chunking Strategies

### Fixed Size Chunking

```typescript
await vectorStore.addDocument(
  'collection',
  text,
  metadata,
  {
    chunkSize: 2000,        // characters
    chunkOverlap: 200,      // characters
    preserveParagraphs: false
  }
);
```

**Best for:** Consistent chunk sizes, simple documents

### Paragraph-Preserving Chunking

```typescript
await vectorStore.addDocument(
  'collection',
  text,
  metadata,
  {
    chunkSize: 2000,
    chunkOverlap: 200,
    preserveParagraphs: true  // Keep paragraphs intact
  }
);
```

**Best for:** Structured documents, maintaining context

### Manual Chunking

```typescript
const chunks: DocumentChunk[] = customChunkingLogic(text).map((chunk, i) => ({
  id: `doc_${i}`,
  text: chunk,
  metadata: { chunkIndex: i, totalChunks: chunks.length }
}));

await vectorStore.addDocuments('collection', chunks);
```

**Best for:** Custom requirements, pre-processed content

## Embedding Models

### Recommended Models

| Model | Dimensions | Size | Use Case |
|-------|-----------|------|----------|
| `nomic-embed-text` | 768 | 137M | General purpose, fast |
| `mxbai-embed-large` | 1024 | 335M | Higher quality, slower |
| `all-MiniLM-L6-v2` | 384 | 22M | Very fast, lower quality |

### Model Selection

```typescript
const vectorStore = new VectorStoreManager(
  'http://localhost:8024',
  'http://localhost:11434',
  'mxbai-embed-large'  // specify model
);
```

## Search Configuration

### Similarity Threshold

```typescript
const results = await vectorStore.search('collection', query, {
  threshold: 0.7  // 0.0 to 1.0, higher = more similar
});
```

**Guidelines:**
- `0.9+` - Very similar (paraphrases)
- `0.7-0.9` - Semantically related
- `0.5-0.7` - Loosely related
- `<0.5` - Probably not relevant

### Metadata Filtering

```typescript
const results = await vectorStore.search('collection', query, {
  filter: {
    category: 'ai',
    author: 'John Doe',
    date: { $gte: '2025-01-01' }  // ChromaDB query operators
  }
});
```

### Top-K Results

```typescript
const results = await vectorStore.search('collection', query, {
  topK: 10  // Return top 10 results
});
```

## Collection Management

### Create/Get Collection

```typescript
const collection = await vectorStore.getOrCreateCollection(
  'my-collection',
  { description: 'Company knowledge base' }
);
```

### List Collections

```typescript
const collections = await vectorStore.listCollections();
console.log('Available collections:', collections);
```

### Get Statistics

```typescript
const stats = await vectorStore.getCollectionStats('my-collection');
console.log(`Documents: ${stats.count}`);
```

### Delete Collection

```typescript
await vectorStore.deleteCollection('old-collection');
```

### Delete Documents

```typescript
// By IDs
await vectorStore.deleteDocuments('collection', ['doc1', 'doc2']);

// By filter
await vectorStore.deleteByFilter('collection', { source: 'outdated' });
```

## Best Practices

### 1. Chunk Size

- **Short chunks (500-1000 chars):** More precise retrieval, less context
- **Medium chunks (1000-2000 chars):** Balanced approach (recommended)
- **Long chunks (2000-4000 chars):** More context, less precise

### 2. Chunk Overlap

- Use 10-20% overlap (e.g., 200 chars for 1500 char chunks)
- Prevents context loss at chunk boundaries
- Helps with queries that span multiple concepts

### 3. Metadata

Store useful metadata for filtering:
```typescript
{
  source: 'url or filepath',
  title: 'Document title',
  author: 'Author name',
  date: '2025-10-22',
  category: 'topic',
  conversationId: 'optional context'
}
```

### 4. Collection Organization

- Separate collections by domain (e.g., 'legal-docs', 'technical-docs')
- Use metadata filters instead of too many collections
- Regular cleanup of outdated documents

### 5. Search Tuning

```typescript
// Start with higher threshold, lower if not enough results
const results = await vectorStore.search('collection', query, {
  topK: 5,           // Start small, increase if needed
  threshold: 0.75    // Adjust based on quality
});

// If no results, try again with lower threshold
if (results.length === 0) {
  results = await vectorStore.search('collection', query, {
    topK: 10,
    threshold: 0.5
  });
}
```

### 6. Token Management

```typescript
// Check token count before embedding
import { countTokens } from '@redbtn/ai';

const tokens = await countTokens(text);
if (tokens > 8000) {
  // Chunk it first
  const chunks = await vectorStore.chunkText(text);
}
```

## Examples

See `examples/test-rag.ts` for comprehensive examples:

```bash
# Run the test suite
npx tsx examples/test-rag.ts
```

The test file demonstrates:
1. Basic vector store operations
2. RAG nodes in LangGraph
3. RAG with conversation context
4. Collection management
5. Search configuration

## Troubleshooting

### ChromaDB not accessible

```typescript
const isHealthy = await vectorStore.healthCheck();
if (!isHealthy) {
  console.error('ChromaDB is not running');
  // Check: docker ps | grep chroma
}
```

### Embedding model not found

```bash
# List available models
ollama list

# Pull the model
ollama pull nomic-embed-text
```

### No search results

- Lower the similarity threshold
- Check that documents were actually added
- Verify embedding model is the same for indexing and querying
- Check collection name matches

### Token limit exceeded

```typescript
// Error: Text too long for embedding
// Solution: Use smaller chunks
await vectorStore.addDocument('collection', text, metadata, {
  chunkSize: 1000,  // Smaller chunks
  chunkOverlap: 100
});
```

## Performance Tips

1. **Batch Operations:** Add multiple documents together
2. **Connection Pooling:** Reuse VectorStoreManager instances
3. **Caching:** Cache embeddings for frequently searched queries
4. **Async Processing:** Use background jobs for large indexing operations
5. **Index Maintenance:** Regularly clean up old/unused collections

## API Reference

See code documentation in:
- `src/lib/memory/vectors.ts` - VectorStoreManager class
- `src/lib/nodes/rag/add.ts` - Add node
- `src/lib/nodes/rag/retrieve.ts` - Retrieve node

## Next Steps

1. ✅ **Setup Complete** - ChromaDB + Ollama running
2. ✅ **Add Documents** - Index your knowledge base
3. ✅ **Test Search** - Verify retrieval quality
4. 🔲 **Integrate with Chat** - Add RAG to your conversation flow
5. 🔲 **Production Deploy** - Scale ChromaDB for production
6. 🔲 **Monitor & Tune** - Track search quality metrics

## Support

For issues or questions:
- Check the examples in `examples/test-rag.ts`
- Review this documentation
- Check ChromaDB docs: https://docs.trychroma.com/
- Check Ollama docs: https://ollama.ai/library/nomic-embed-text
