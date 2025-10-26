# RAG Nodes: Input/Output Reference

## Overview

Both RAG nodes follow the LangGraph pattern: they receive **state** as input and return a **partial state update** as output.

---

## 📥 Node 1: `addToVectorStoreNode`

### Purpose
Adds documents to ChromaDB with automatic chunking and embedding.

### Input (from state)

```typescript
{
  // ✅ REQUIRED
  ragDocument: {
    text: string,              // The document content to add
    source?: string,           // Where it came from (URL, filename, etc.)
    metadata?: {               // Any additional info
      title?: string,
      author?: string,
      date?: string,
      [key: string]: any
    }
  },
  
  // ⚙️ OPTIONAL
  ragCollection?: string,      // Collection name (default: 'general')
  
  ragChunkingConfig?: {        // How to chunk the text
    chunkSize?: number,        // Size in chars (default: 2000)
    chunkOverlap?: number,     // Overlap in chars (default: 200)
    preserveParagraphs?: boolean  // Keep paragraphs intact (default: true)
  },
  
  // 🔧 STANDARD (automatically provided by graph)
  redInstance?: Red,           // Your Red AI instance
  options?: {
    conversationId?: string,
    generationId?: string
  }
}
```

### Output (returns to state)

```typescript
{
  ragResult: {
    success: boolean,          // true if successful
    chunksAdded: number,       // How many chunks were created
    collectionName: string,    // Which collection they were added to
    error?: string            // Error message if failed
  }
}
```

### Example Usage

```typescript
// Input state
const state = {
  ragDocument: {
    text: "Long article about RAG systems...",
    source: "https://example.com/rag-article",
    metadata: {
      title: "Understanding RAG",
      author: "Jane Doe"
    }
  },
  ragCollection: "ai-articles",
  ragChunkingConfig: {
    chunkSize: 1500,
    chunkOverlap: 150
  },
  redInstance: red
};

// Call node
const result = await addToVectorStoreNode(state);

// Output
console.log(result.ragResult);
// {
//   success: true,
//   chunksAdded: 8,
//   collectionName: "ai-articles"
// }
```

---

## 🔍 Node 2: `retrieveFromVectorStoreNode`

### Purpose
Searches ChromaDB for relevant documents and formats them for LLM consumption.

### Input (from state)

```typescript
{
  // ✅ REQUIRED (one of these)
  ragQuery?: string,           // Explicit search query
  query?: {                    // OR use the user's message
    message: string
  },
  
  // ⚙️ OPTIONAL
  ragCollection?: string,      // Collection to search (default: 'general')
  
  ragSearchConfig?: {          // Search parameters
    topK?: number,             // How many results (default: 5)
    threshold?: number,        // Min similarity score (default: 0.7)
    filter?: {                 // Metadata filters
      category?: string,
      author?: string,
      [key: string]: any
    }
  },
  
  ragFormatContext?: boolean,  // Format for LLM? (default: true)
  ragMergeChunks?: boolean,    // Merge overlapping chunks? (default: true)
  
  // 🔧 STANDARD (automatically provided by graph)
  redInstance?: Red,
  options?: {
    conversationId?: string,
    generationId?: string
  },
  systemMessage?: string       // Existing system prompt (context will be appended)
}
```

### Output (returns to state)

```typescript
{
  // 📊 RAW RESULTS
  ragResults: [                // Array of search results
    {
      id: string,              // Chunk ID
      text: string,            // Chunk text
      metadata: {              // Chunk metadata
        source: string,
        chunkIndex: number,
        title?: string,
        mergedChunks?: number, // If merged
        [key: string]: any
      },
      score: number,           // Similarity score (0-1)
      distance: number         // Raw distance from ChromaDB
    },
    // ... more results
  ],
  
  // 📝 FORMATTED CONTEXT
  ragContext: string,          // Markdown-formatted context for LLM
  
  // 💬 UPDATED SYSTEM MESSAGE
  systemMessage?: string       // Original + injected context
}
```

### Example Usage

```typescript
// Input state
const state = {
  ragQuery: "What is RAG?",
  ragCollection: "ai-articles",
  ragSearchConfig: {
    topK: 3,
    threshold: 0.7,
    filter: { category: "ai" }
  },
  ragFormatContext: true,
  ragMergeChunks: true,
  redInstance: red
};

// Call node
const result = await retrieveFromVectorStoreNode(state);

// Output
console.log(result.ragResults.length);  // 3
console.log(result.ragResults[0].score); // 0.84 (84% similar)
console.log(result.ragContext);
// # Relevant Context for Query: "What is RAG?"
// 
// The following 2 document(s) were retrieved from the knowledge base:
// 
// ### Retrieved Context 1 (84.5% relevant) (2 chunks merged)
// Source: https://example.com/rag-article
// 
// RAG (Retrieval-Augmented Generation) is a technique...
```

---

## 🔄 How They Work Together in a Graph

### Example: Add then Retrieve

```typescript
import { StateGraph, Annotation } from '@langchain/langgraph';
import { addToVectorStoreNode, retrieveFromVectorStoreNode } from '@redbtn/ai';

// Define state
const GraphState = Annotation.Root({
  // Add node inputs
  ragDocument: Annotation<any>(),
  ragCollection: Annotation<string>(),
  
  // Retrieve node inputs
  ragQuery: Annotation<string>(),
  ragSearchConfig: Annotation<any>(),
  
  // Shared outputs
  ragResult: Annotation<any>(),
  ragResults: Annotation<any[]>(),
  ragContext: Annotation<string>(),
  
  // Standard
  redInstance: Annotation<any>(),
  options: Annotation<any>()
});

// Build graph
const graph = new StateGraph(GraphState)
  .addNode('add', addToVectorStoreNode)
  .addNode('retrieve', retrieveFromVectorStoreNode)
  .addEdge('__start__', 'add')
  .addEdge('add', 'retrieve')
  .addEdge('retrieve', '__end__')
  .compile();

// Use graph
const result = await graph.invoke({
  // For add node
  ragDocument: {
    text: "Document content...",
    source: "doc.txt"
  },
  ragCollection: "docs",
  
  // For retrieve node
  ragQuery: "search query",
  
  // Shared
  redInstance: red,
  options: { conversationId: 'conv123' }
});

// Access outputs
console.log(result.ragResult);    // Add results
console.log(result.ragResults);   // Search results
console.log(result.ragContext);   // Formatted context
```

---

## 🎯 Common Patterns

### Pattern 1: Retrieve Before Chat

```typescript
const graph = new StateGraph(State)
  .addNode('retrieve', retrieveFromVectorStoreNode)
  .addNode('chat', chatNode)
  .addEdge('__start__', 'retrieve')
  .addEdge('retrieve', 'chat')  // Context flows to chat
  .compile();
```

**Flow:**
1. User query → `ragQuery`
2. Retrieve node searches and formats context
3. Context injected into `systemMessage`
4. Chat node receives enhanced prompt with context
5. LLM generates response with retrieved knowledge

### Pattern 2: Conditional Add

```typescript
const graph = new StateGraph(State)
  .addNode('router', routerNode)
  .addNode('add', addToVectorStoreNode)
  .addNode('chat', chatNode)
  .addConditionalEdges('router', (state) => {
    if (state.shouldAddToKnowledge) return 'add';
    return 'chat';
  })
  .compile();
```

**Flow:**
1. Router determines if content should be stored
2. If yes → add to vector store
3. Continue to chat

### Pattern 3: Retrieve + Re-rank

```typescript
const graph = new StateGraph(State)
  .addNode('retrieve', retrieveFromVectorStoreNode)
  .addNode('rerank', rerankNode)  // Custom node
  .addNode('chat', chatNode)
  .addEdge('retrieve', 'rerank')
  .addEdge('rerank', 'chat')
  .compile();
```

**Flow:**
1. Retrieve gets top 10 results
2. Rerank node uses cross-encoder for better scoring
3. Top 3 best results sent to chat

---

## 📋 Quick Reference

### Add Node
| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ragDocument.text` | string | ✅ Yes | - |
| `ragDocument.source` | string | ⚪ No | 'unknown' |
| `ragDocument.metadata` | object | ⚪ No | `{}` |
| `ragCollection` | string | ⚪ No | 'general' |
| `ragChunkingConfig` | object | ⚪ No | See defaults |
| `redInstance` | Red | ✅ Yes | - |

**Output:** `ragResult` object

---

### Retrieve Node
| Input | Type | Required | Default |
|-------|------|----------|---------|
| `ragQuery` or `query.message` | string | ✅ Yes | - |
| `ragCollection` | string | ⚪ No | 'general' |
| `ragSearchConfig.topK` | number | ⚪ No | 5 |
| `ragSearchConfig.threshold` | number | ⚪ No | 0.7 |
| `ragSearchConfig.filter` | object | ⚪ No | `{}` |
| `ragFormatContext` | boolean | ⚪ No | true |
| `ragMergeChunks` | boolean | ⚪ No | true |
| `redInstance` | Red | ✅ Yes | - |

**Output:** `ragResults` array, `ragContext` string, `systemMessage` string (if formatting enabled)

---

## 💡 Key Points

1. **State is Immutable** - Nodes return partial updates, they don't modify input state
2. **Optional vs Required** - Only `ragDocument.text` (add) and query (retrieve) are required
3. **Defaults Work Well** - You can often just provide the minimum required fields
4. **Context Injection** - Retrieve node automatically enhances `systemMessage` with context
5. **Red Instance** - Both nodes need access to your configured Red instance for URLs and logging
6. **Async** - Both nodes are async, they return Promises

---

## 🔍 Debugging

### Check what's in state:
```typescript
const result = await addToVectorStoreNode(state);
console.log('State keys:', Object.keys(state));
console.log('Result keys:', Object.keys(result));
```

### Log intermediate results:
```typescript
const retrieved = await retrieveFromVectorStoreNode(state);
console.log('Found chunks:', retrieved.ragResults?.length);
console.log('Avg score:', retrieved.ragResults?.reduce((sum, r) => sum + r.score, 0) / retrieved.ragResults.length);
console.log('Context length:', retrieved.ragContext?.length);
```

### Inspect formatted output:
```typescript
console.log('=== CONTEXT FOR LLM ===');
console.log(result.ragContext);
console.log('=== END CONTEXT ===');
```
