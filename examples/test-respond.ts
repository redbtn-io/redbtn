import { Red } from '../src/index';

const redConfig = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  vectorDbUrl: process.env.VECTOR_DB_URL || '',
  databaseUrl: process.env.DATABASE_URL || '',
  defaultLlmUrl: process.env.LLM_URL || 'http://localhost:11434'
};

async function testRespond() {
  console.log('🧪 Testing respond tool pattern...\n');
  
  const red = new Red(redConfig);
  await red.load('test-respond');
  
  // Test 1: Simple conversational query (should use respond tool)
  console.log('Test 1: Simple conversation');
  console.log('Query: "Hello, how are you?"');
  const result1 = await red.respond(
    { message: 'Hello, how are you?' },
    { conversationId: 'test_respond_1' }
  );
  console.log('Response:', result1.content);
  console.log('Tool calls:', result1.tool_calls);
  console.log('---\n');
  
  // Test 2: Another conversational query
  console.log('Test 2: What is your name?');
  console.log('Query: "What is your name?"');
  const result2 = await red.respond(
    { message: 'What is your name?' },
    { conversationId: 'test_respond_2' }
  );
  console.log('Response:', result2.content);
  console.log('Tool calls:', result2.tool_calls);
  console.log('---\n');
  
  // Test 3: Query that should trigger web search
  console.log('Test 3: Current information query');
  console.log('Query: "What are the latest news about AI?"');
  const result3 = await red.respond(
    { message: 'What are the latest news about AI?' },
    { conversationId: 'test_respond_3' }
  );
  console.log('Response:', result3.content);
  console.log('Tool calls:', result3.tool_calls);
  console.log('---\n');
  
  // Close Redis connection
  await red.memory['redis'].quit();
  
  console.log('✅ Test complete');
}

testRespond().catch(console.error);
