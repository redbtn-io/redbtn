# RAG Quick Start Guide

Get your RAG (Retrieval-Augmented Generation) system running in 5 minutes.

## Step 1: Start ChromaDB

```bash
# Using Docker (recommended)
docker run -d -p 8024:8000 chromadb/chroma

# Or using Python
pip install chromadb
chroma run --host 0.0.0.0 --port 8024
```

Verify it's running:
```bash
curl http://localhost:8024/api/v1/heartbeat
```

## Step 2: Pull Embedding Model

```bash
# Pull the default embedding model
ollama pull nomic-embed-text

# Verify it's available
ollama list | grep nomic
```

## Step 3: Set Environment Variables

```bash
export CHROMA_URL=http://localhost:8024
export OLLAMA_BASE_URL=http://localhost:11434
```

Or create a `.env` file:
```bash
CHROMA_URL=http://localhost:8024
OLLAMA_BASE_URL=http://localhost:11434
REDIS_URL=redis://localhost:6379
MONGO_URL=mongodb://localhost:27017/red
```

## Step 4: Test the System

```bash
cd ai
npm run test:rag
```

You should see:
```
✓ ChromaDB is accessible
✓ Documents added
✓ Search results found
✅ ALL TESTS COMPLETED SUCCESSFULLY
```

## Step 5: Use in Your Code

### Simple Example

```typescript
import { VectorStoreManager } from '@redbtn/ai';

// Initialize
const vectorStore = new VectorStoreManager();

// Add documents
await vectorStore.addDocument(
  'my-knowledge',
  'Your document text here...',
  { source: 'my-source' }
);

// Search
const results = await vectorStore.search(
  'my-knowledge',
  'your query here',
  { topK: 3, threshold: 0.7 }
);

// Use results
console.log('Found:', results.length, 'relevant documents');
```

### With LangGraph Nodes

```typescript
import { retrieveFromVectorStoreNode } from '@redbtn/ai';

// In your graph
const state = {
  ragQuery: userQuery,
  ragCollection: 'knowledge-base',
  ragFormatContext: true,  // Auto-format for LLM
  redInstance: red
};

const result = await retrieveFromVectorStoreNode(state);
// result.ragContext is ready to use in your LLM prompt
```

## Troubleshooting

### ChromaDB not starting
```bash
# Check if port is in use
lsof -i :8024

# Try a different port
docker run -d -p 8025:8000 chromadb/chroma
# Then set CHROMA_URL=http://localhost:8025
```

### Embedding model missing
```bash
# Check what's installed
ollama list

# Pull if missing
ollama pull nomic-embed-text
```

### No search results
- Lower the threshold: `{ threshold: 0.5 }` instead of `0.7`
- Increase topK: `{ topK: 10 }` instead of `3`
- Check documents were added: `await vectorStore.getCollectionStats('my-collection')`

## Next Steps

- Read the full documentation: `RAG-SYSTEM.md`
- Check out examples: `examples/test-rag.ts`
- Integrate with your chat system
- Tune chunk sizes and overlap for your use case

## Docker Compose (Optional)

Create `docker-compose.yml`:
```yaml
version: '3.8'
services:
  chromadb:
    image: chromadb/chroma
    ports:
      - "8024:8000"
    volumes:
      - chroma_data:/chroma/chroma
    environment:
      - IS_PERSISTENT=TRUE

volumes:
  chroma_data:
```

Run with:
```bash
docker-compose up -d
```

## Performance Tips

- Reuse `VectorStoreManager` instances (don't create new ones for each operation)
- Use batch operations when adding multiple documents
- Keep chunk sizes reasonable (1500-2000 chars)
- Use metadata filters to narrow searches
- Monitor ChromaDB disk usage and clean up old collections

## Production Checklist

- [ ] ChromaDB running in persistent mode
- [ ] ChromaDB data backed up regularly
- [ ] Embedding model pulled and cached
- [ ] Environment variables configured
- [ ] Connection pooling configured
- [ ] Error handling implemented
- [ ] Logging and monitoring enabled
- [ ] Collection naming strategy defined
- [ ] Document update/deletion strategy planned

Ready to build something awesome! 🚀
