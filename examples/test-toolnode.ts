/**
 * Test script for ToolNode integration
 * This tests the full graph flow: chat → tools → chat
 */

import { Red, RedConfig } from '../src';

async function testToolNode() {
  console.log('🧪 Testing ToolNode Integration\n');

  // Initialize Red with config
  const config: RedConfig = {
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    vectorDbUrl: process.env.VECTOR_DB_URL || '',
    databaseUrl: process.env.DATABASE_URL || '',
    defaultLlmUrl: process.env.LLM_URL || 'http://localhost:11434'
  };

  const red = new Red(config);

  try {
    // Test 1: Web search tool
    console.log('Test 1: Web Search Tool');
    console.log('Query: "What is the weather in San Francisco today?"');
    
    const response1 = await red.respond({
      message: 'What is the weather in San Francisco today? Use web search to find out.'
    }, {
      conversationId: 'test-toolnode-1'
    });

    console.log('Response:', response1.content);
    console.log('---\n');

    // Test 2: Command execution tool
    console.log('Test 2: Send Command Tool');
    console.log('Query: "What files are in the current directory?"');
    
    const response2 = await red.respond({
      message: 'List the files in the current directory using the ls command.'
    }, {
      conversationId: 'test-toolnode-2'
    });

    console.log('Response:', response2.content);
    console.log('---\n');

    // Test 3: URL scraping tool
    console.log('Test 3: Scrape URL Tool');
    console.log('Query: "What is on the OpenAI homepage?"');
    
    const response3 = await red.respond({
      message: 'Scrape the OpenAI homepage at https://openai.com and tell me what you find.'
    }, {
      conversationId: 'test-toolnode-3'
    });

    console.log('Response:', response3.content);
    console.log('---\n');

    console.log('✅ All tests completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Close memory connection
    await red.memory.close();
  }
}

// Run the test
testToolNode();
