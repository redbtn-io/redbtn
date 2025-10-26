/**
 * @file examples/test-rag.ts
 * @description Comprehensive test of RAG (Retrieval-Augmented Generation) system
 * 
 * This example demonstrates:
 * 1. Adding documents to ChromaDB with automatic chunking
 * 2. Searching for relevant context using semantic similarity
 * 3. Using RAG nodes in a LangGraph workflow
 * 4. Collection management and statistics
 * 
 * Prerequisites:
 * - ChromaDB running on localhost:8024
 * - Ollama running with nomic-embed-text model
 * 
 * Run with: npx tsx examples/test-rag.ts
 */

import 'dotenv/config';
import { Red } from '../src/index';
import { VectorStoreManager } from '../src/lib/memory/vectors';

// Sample documents about AI and machine learning
const sampleDocuments = [
  {
    text: `Retrieval-Augmented Generation (RAG) is a technique that enhances large language models by providing them with relevant context from external knowledge sources. 
    
    The process works in two main steps:
    1. Retrieval: When a query is received, the system searches a vector database for documents semantically similar to the query.
    2. Generation: The retrieved context is injected into the LLM's prompt, allowing it to generate informed responses based on the retrieved information.
    
    RAG is particularly useful for:
    - Reducing hallucinations by grounding responses in factual data
    - Enabling LLMs to access up-to-date information beyond their training cutoff
    - Creating domain-specific AI assistants with specialized knowledge
    - Maintaining a separation between the model and the knowledge base
    
    Key components of a RAG system include:
    - Vector database (e.g., ChromaDB, Pinecone, Weaviate)
    - Embedding model (e.g., OpenAI embeddings, Sentence Transformers)
    - Text chunking strategy with appropriate overlap
    - Similarity search algorithm (usually cosine similarity)
    - Context injection mechanism`,
    metadata: {
      title: 'Introduction to RAG',
      category: 'ai',
      author: 'AI Research Team',
      date: '2025-01-15'
    }
  },
  {
    text: `ChromaDB is an open-source vector database designed for AI applications. It provides a simple, Pythonic API for storing and querying embeddings.
    
    Key features:
    - Built-in embedding generation with multiple model options
    - Automatic persistence to disk
    - Fast similarity search using HNSW (Hierarchical Navigable Small World) algorithm
    - Metadata filtering for scoped searches
    - Collection-based organization
    - Client-server architecture for production deployments
    
    ChromaDB is particularly well-suited for:
    - Semantic search applications
    - RAG implementations
    - Document similarity and clustering
    - Recommendation systems
    
    Installation: pip install chromadb
    Default port: 8000 (HTTP API)
    
    ChromaDB supports multiple distance metrics:
    - Cosine similarity (default)
    - L2 (Euclidean distance)
    - IP (Inner product)`,
    metadata: {
      title: 'ChromaDB Overview',
      category: 'databases',
      author: 'Database Team',
      date: '2025-02-01'
    }
  },
  {
    text: `Text chunking is a critical step in RAG implementations. The goal is to split large documents into smaller pieces that fit within the embedding model's token limit while maintaining semantic coherence.
    
    Chunking strategies:
    
    1. Fixed-size chunking:
       - Split text every N characters or tokens
       - Simple but may break sentences mid-way
       - Recommended: 500-1000 tokens per chunk
    
    2. Sentence-based chunking:
       - Split on sentence boundaries
       - Preserves semantic units
       - May result in variable-sized chunks
    
    3. Paragraph-based chunking:
       - Split on paragraph breaks
       - Best for structured documents
       - Maintains logical sections
    
    4. Recursive chunking:
       - Start with large chunks, recursively split if too big
       - Good balance between context and size
    
    Overlap considerations:
    - Add 10-20% overlap between chunks
    - Helps maintain context across boundaries
    - Example: 1000 token chunks with 200 token overlap
    
    Token limits by model:
    - OpenAI text-embedding-ada-002: 8,191 tokens
    - Sentence Transformers: 256-512 tokens typically
    - nomic-embed-text (Ollama): 8,192 tokens
    
    Best practices:
    - Test different chunk sizes for your use case
    - Monitor retrieval quality and adjust
    - Consider document structure when chunking
    - Use overlap to prevent context loss`,
    metadata: {
      title: 'Text Chunking Strategies',
      category: 'ai',
      author: 'NLP Team',
      date: '2025-02-15'
    }
  },
  {
    text: `Embedding models convert text into dense vector representations that capture semantic meaning. These vectors enable similarity comparisons between pieces of text.
    
    Popular embedding models:
    
    1. OpenAI embeddings (text-embedding-ada-002):
       - 1,536 dimensions
       - Strong performance across tasks
       - Proprietary, requires API key
       - Cost: $0.0001 per 1K tokens
    
    2. Sentence Transformers (open-source):
       - Various sizes: 384, 768, 1024 dimensions
       - Models: all-MiniLM-L6-v2, all-mpnet-base-v2
       - Can run locally
       - Free
    
    3. Nomic Embed (via Ollama):
       - 768 dimensions
       - 137M parameters
       - Optimized for semantic search
       - Runs locally, free
    
    4. Cohere embeddings:
       - 1,024 or 768 dimensions
       - Good for multilingual tasks
       - Proprietary
    
    Choosing an embedding model:
    - Consider dimensionality (higher = more expressive but slower)
    - Evaluate on your specific domain
    - Balance between quality and speed
    - Factor in cost (API vs. local)
    
    Embedding best practices:
    - Use the same model for indexing and querying
    - Normalize vectors for cosine similarity
    - Consider fine-tuning for domain-specific tasks
    - Cache embeddings to avoid recomputation`,
    metadata: {
      title: 'Embedding Models Guide',
      category: 'ai',
      author: 'ML Team',
      date: '2025-03-01'
    }
  }
];

/**
 * Test 1: Basic vector store operations
 */
async function testBasicOperations() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 1: Basic Vector Store Operations');
  console.log('='.repeat(80) + '\n');

  const vectorStore = new VectorStoreManager(
    'http://localhost:8024',
    'http://localhost:11434'
  );

  // Health check
  console.log('📡 Checking ChromaDB connection...');
  const isHealthy = await vectorStore.healthCheck();
  console.log(`✓ ChromaDB is ${isHealthy ? 'accessible' : 'NOT accessible'}\n`);

  if (!isHealthy) {
    console.error('❌ ChromaDB is not running. Start it with: docker run -p 8024:8000 chromadb/chroma');
    return;
  }

  // List existing collections
  console.log('📚 Listing existing collections...');
  const collections = await vectorStore.listCollections();
  console.log(`Found ${collections.length} collection(s):`, collections, '\n');

  // Create test collection name
  const testCollection = 'test_rag_' + Date.now();
  console.log(`🆕 Creating collection: ${testCollection}\n`);

  // Add documents
  console.log('📝 Adding sample documents...\n');
  for (let i = 0; i < sampleDocuments.length; i++) {
    const doc = sampleDocuments[i];
    console.log(`Adding document ${i + 1}/${sampleDocuments.length}: ${doc.metadata.title}`);
    
    const chunksAdded = await vectorStore.addDocument(
      testCollection,
      doc.text,
      {
        source: `doc_${i + 1}`,
        ...doc.metadata
      },
      {
        chunkSize: 800,  // Smaller chunks for testing
        chunkOverlap: 100,
        preserveParagraphs: true
      }
    );
    
    console.log(`  ✓ Added ${chunksAdded} chunk(s)\n`);
  }

  // Get collection stats
  console.log('📊 Collection statistics:');
  const stats = await vectorStore.getCollectionStats(testCollection);
  console.log(`  Name: ${stats.name}`);
  console.log(`  Total chunks: ${stats.count}\n`);

  // Test search queries
  const queries = [
    'What is RAG and how does it work?',
    'Tell me about ChromaDB features',
    'How should I chunk text for embeddings?',
    'What embedding models are available?'
  ];

  for (const query of queries) {
    console.log('-'.repeat(80));
    console.log(`🔍 Query: "${query}"\n`);

    const results = await vectorStore.search(
      testCollection,
      query,
      {
        topK: 2,
        threshold: 0.5
      }
    );

    console.log(`Found ${results.length} relevant result(s):\n`);
    
    results.forEach((result, index) => {
      console.log(`Result ${index + 1}:`);
      console.log(`  Relevance: ${(result.score * 100).toFixed(1)}%`);
      console.log(`  Source: ${result.metadata.source}`);
      console.log(`  Title: ${result.metadata.title}`);
      console.log(`  Text preview: ${result.text.substring(0, 150)}...`);
      console.log();
    });
  }

  // Cleanup
  console.log('-'.repeat(80));
  console.log(`🗑️  Cleaning up test collection: ${testCollection}`);
  await vectorStore.deleteCollection(testCollection);
  console.log('✓ Collection deleted\n');
}

/**
 * Test 2: RAG nodes in LangGraph
 */
async function testRAGNodes() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 2: RAG Nodes in LangGraph');
  console.log('='.repeat(80) + '\n');

  // Initialize Red instance
  const red = new Red({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    vectorDbUrl: process.env.CHROMA_URL || 'http://localhost:8024',
    databaseUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/red',
    chatLlmUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    workLlmUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
  });

  await red.load('test-rag-node');

  console.log('📚 Testing addToVectorStoreNode...\n');

  // Import RAG nodes
  const { addToVectorStoreNode, retrieveFromVectorStoreNode } = await import('../src/lib/nodes/rag');

  const testCollection = 'test_rag_nodes_' + Date.now();

  // Test add node
  const addState = {
    ragDocument: {
      text: sampleDocuments[0].text,
      source: 'test-document',
      metadata: sampleDocuments[0].metadata
    },
    ragCollection: testCollection,
    ragChunkingConfig: {
      chunkSize: 1000,
      chunkOverlap: 150
    },
    redInstance: red,
    options: {
      conversationId: 'test-conv',
      generationId: 'test-gen'
    }
  };

  console.log('Adding document via node...');
  const addResult = await addToVectorStoreNode(addState);
  console.log('Add result:', addResult.ragResult);
  console.log();

  // Test retrieve node
  console.log('🔍 Testing retrieveFromVectorStoreNode...\n');

  const retrieveState = {
    ragQuery: 'Explain how RAG works',
    ragCollection: testCollection,
    ragSearchConfig: {
      topK: 2,
      threshold: 0.6
    },
    ragFormatContext: true,
    redInstance: red,
    options: {
      conversationId: 'test-conv',
      generationId: 'test-gen'
    }
  };

  console.log('Retrieving context via node...');
  const retrieveResult = await retrieveFromVectorStoreNode(retrieveState);
  console.log(`Found ${retrieveResult.ragResults?.length || 0} result(s)`);
  console.log();
  
  if (retrieveResult.ragContext) {
    console.log('Formatted context for LLM:');
    console.log('-'.repeat(80));
    console.log(retrieveResult.ragContext);
    console.log('-'.repeat(80));
  }

  // Cleanup
  console.log('\n🗑️  Cleaning up...');
  const vectorStore = new VectorStoreManager('http://localhost:8024');
  await vectorStore.deleteCollection(testCollection);
  console.log('✓ Collection deleted');

  await red.shutdown();
  console.log('✓ Red instance shut down\n');
}

/**
 * Test 3: RAG with conversation context
 */
async function testRAGWithConversation() {
  console.log('\n' + '='.repeat(80));
  console.log('TEST 3: RAG with Conversation Context');
  console.log('='.repeat(80) + '\n');

  const vectorStore = new VectorStoreManager('http://localhost:8024');
  const testCollection = 'conversation_knowledge_' + Date.now();

  console.log('💬 Simulating conversation with knowledge retrieval...\n');

  // Add all documents to the knowledge base
  console.log('📚 Building knowledge base...');
  for (const doc of sampleDocuments) {
    await vectorStore.addDocument(
      testCollection,
      doc.text,
      { source: doc.metadata.title, ...doc.metadata }
    );
  }
  console.log('✓ Knowledge base ready\n');

  // Simulate a conversation
  const conversationQueries = [
    'What is RAG?',
    'Which database should I use for storing embeddings?',
    'How do I split my documents into chunks?',
    'What embedding model would you recommend for a local setup?'
  ];

  for (const query of conversationQueries) {
    console.log('-'.repeat(80));
    console.log(`👤 User: ${query}\n`);

    // Retrieve relevant context
    const results = await vectorStore.search(testCollection, query, {
      topK: 2,
      threshold: 0.65
    });

    if (results.length > 0) {
      console.log(`🤖 Retrieved ${results.length} relevant document(s):`);
      results.forEach((r, i) => {
        console.log(`  ${i + 1}. ${r.metadata.title} (${(r.score * 100).toFixed(1)}% relevant)`);
      });
      console.log();
      console.log('📄 Context that would be sent to LLM:');
      console.log(`  "${results[0].text.substring(0, 200)}..."`);
      console.log();
    } else {
      console.log('🤖 No relevant context found in knowledge base\n');
    }
  }

  // Cleanup
  console.log('-'.repeat(80));
  console.log('🗑️  Cleaning up...');
  await vectorStore.deleteCollection(testCollection);
  console.log('✓ Done\n');
}

/**
 * Main test runner
 */
async function main() {
  console.log('\n🧪 RAG System Comprehensive Test Suite\n');
  console.log('This will test:');
  console.log('  1. Basic vector store operations (add, search, delete)');
  console.log('  2. RAG nodes in LangGraph workflow');
  console.log('  3. RAG with conversation context');
  console.log();

  try {
    await testBasicOperations();
    await testRAGNodes();
    await testRAGWithConversation();

    console.log('\n' + '='.repeat(80));
    console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY');
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

// Run tests
main().catch(console.error);
