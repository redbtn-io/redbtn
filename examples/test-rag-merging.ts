/**
 * @file examples/test-rag-merging.ts
 * @description Test chunk merging functionality in RAG retrieval
 * 
 * This demonstrates how overlapping chunks from the same document
 * are automatically merged when retrieved together.
 */

import 'dotenv/config';
import { VectorStoreManager } from '../src/lib/memory/vectors';
import { retrieveFromVectorStoreNode } from '../src/lib/nodes/rag';
import { Red } from '../src/index';

async function testChunkMerging() {
  console.log('\n🧪 Testing RAG Chunk Merging\n');
  console.log('='.repeat(80));

  const vectorStore = new VectorStoreManager();
  const testCollection = 'test_merging_' + Date.now();

  // Create a long document that will be chunked with overlap
  const longDocument = `
RAG (Retrieval-Augmented Generation) is a powerful technique in AI that combines the benefits of large language models with external knowledge retrieval systems. This approach allows AI systems to access and utilize information beyond their training data.

The key innovation of RAG is its ability to dynamically retrieve relevant context from a knowledge base before generating responses. When a user asks a question, the system first searches through stored documents to find the most relevant information. These retrieved passages are then provided to the language model as context.

This context injection happens through the prompt, where the retrieved documents are formatted and included alongside the user's query. The language model then generates a response based on both its pre-trained knowledge and the retrieved context. This combination results in more accurate, up-to-date, and factually grounded responses.

RAG systems typically consist of three main components: a vector database for storing embeddings, an embedding model for converting text to vectors, and a retrieval mechanism that finds semantically similar content. The vector database allows for efficient similarity search at scale.

Implementation considerations include choosing the right chunk size (typically 500-2000 characters), determining the overlap between chunks (usually 10-20%), and selecting an appropriate embedding model. Popular choices include OpenAI's embeddings, sentence transformers, and Ollama's embedding models.

The retrieval quality is crucial for RAG performance. Factors affecting retrieval include the similarity threshold, the number of results to retrieve (top-K), and any metadata filters applied. Too strict a threshold may miss relevant content, while too loose a threshold may include noise.

Another important aspect is how retrieved chunks are presented to the language model. Formatting the context clearly, including source attribution, and maintaining relevance scores helps the model understand and utilize the information effectively.
  `.trim();

  console.log('\n1️⃣ Adding document with overlap...\n');
  
  // Add document with explicit overlap
  const chunksAdded = await vectorStore.addDocument(
    testCollection,
    longDocument,
    { source: 'rag-guide', title: 'RAG Implementation Guide' },
    {
      chunkSize: 400,      // Small chunks to create multiple pieces
      chunkOverlap: 80,    // 20% overlap
      preserveParagraphs: false
    }
  );

  console.log(`✓ Document split into ${chunksAdded} chunks with 80 char overlap\n`);

  // Get collection stats
  const stats = await vectorStore.getCollectionStats(testCollection);
  console.log(`📊 Collection contains ${stats.count} total chunks\n`);

  console.log('='.repeat(80));
  console.log('\n2️⃣ Searching and retrieving (without merging)...\n');

  // Search with higher topK to get multiple overlapping chunks
  const rawResults = await vectorStore.search(
    testCollection,
    'How does RAG work?',
    { topK: 5, threshold: 0.6 }
  );

  console.log(`Found ${rawResults.length} chunks:\n`);
  rawResults.forEach((result, i) => {
    console.log(`Chunk ${i + 1}:`);
    console.log(`  Score: ${(result.score * 100).toFixed(1)}%`);
    console.log(`  Chunk Index: ${result.metadata.chunkIndex}`);
    console.log(`  Length: ${result.text.length} chars`);
    console.log(`  Preview: "${result.text.substring(0, 80)}..."`);
    console.log();
  });

  console.log('='.repeat(80));
  console.log('\n3️⃣ Retrieving with automatic merging (via node)...\n');

  // Initialize Red instance for the node
  const red = new Red({
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    vectorDbUrl: process.env.CHROMA_URL || 'http://localhost:8024',
    databaseUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/red',
    chatLlmUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    workLlmUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434'
  });

  await red.load('test-merging');

  const retrieveState = {
    ragQuery: 'How does RAG work?',
    ragCollection: testCollection,
    ragSearchConfig: { topK: 5, threshold: 0.6 },
    ragFormatContext: true,
    redInstance: red,
    options: { conversationId: 'test', generationId: 'test' }
  };

  const result = await retrieveFromVectorStoreNode(retrieveState);

  console.log('Formatted context with merged chunks:\n');
  console.log('─'.repeat(80));
  console.log(result.ragContext);
  console.log('─'.repeat(80));

  // Cleanup
  console.log('\n🗑️  Cleaning up...');
  await vectorStore.deleteCollection(testCollection);
  await red.shutdown();
  console.log('✓ Done\n');
}

testChunkMerging().catch(console.error);
