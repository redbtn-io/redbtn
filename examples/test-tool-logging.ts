/**
 * Test Tool Logging
 * Tests that tools are logging to the database correctly
 */

import { Red } from '../src/index';
import dotenv from 'dotenv';

dotenv.config();

async function testToolLogging() {
  console.log('\n🔍 Testing Tool Logging...\n');
  
  const redConfig = {
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
    vectorDbUrl: process.env.QDRANT_URL || 'http://localhost:6333',
    databaseUrl: process.env.DATABASE_URL || 'mongodb://localhost:27017/redbtn',
    chatLlmUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
    workLlmUrl: process.env.OLLAMA_URL || 'http://localhost:11434',
  };
  
  const red = new Red(redConfig);
  
  try {
    const conversationId = 'test-tool-logging-' + Date.now();
    
    // Create a test that will trigger tool usage
    console.log('📝 Creating conversation that will use web search...');
    const response = await red.respond({
      message: 'Search for the latest news about TypeScript'
    }, {
      conversationId,
      stream: false
    });
    
    console.log('\n✅ Response received');
    console.log('Generation ID:', response.generationId);
    
    // Wait a moment for logs to be persisted (batch write is 5 seconds)
    console.log('\n⏳ Waiting 6 seconds for logs to be persisted to MongoDB...');
    await new Promise(resolve => setTimeout(resolve, 6000));
    
    // Retrieve logs
    console.log('\n📋 Retrieving logs from database...');
    const logs = await red.logger.getGenerationLogs(response.generationId);
    
    console.log(`\n📊 Found ${logs.length} logs:`);
    logs.forEach((log, i) => {
      const emoji = log.level === 'error' ? '❌' : 
                   log.level === 'warn' ? '⚠️' : 
                   log.level === 'success' ? '✅' : 
                   log.level === 'info' ? 'ℹ️' : '🔍';
      console.log(`${i + 1}. ${emoji} [${log.category}] ${log.message}`);
      if (log.metadata?.toolName) {
        console.log(`   Tool: ${log.metadata.toolName}`);
      }
      if (log.metadata?.query) {
        console.log(`   Query: ${log.metadata.query}`);
      }
      if (log.metadata?.resultsFound !== undefined) {
        console.log(`   Results: ${log.metadata.resultsFound}`);
      }
      if (log.metadata?.totalDurationMs) {
        console.log(`   Duration: ${log.metadata.totalDurationMs}ms`);
      }
    });
    
    // Check for specific log types
    const toolLogs = logs.filter(l => l.category === 'tool');
    const routerLogs = logs.filter(l => l.category === 'router');
    const chatLogs = logs.filter(l => l.category === 'chat');
    
    console.log('\n📈 Log Category Breakdown:');
    console.log(`   Tool logs: ${toolLogs.length}`);
    console.log(`   Router logs: ${routerLogs.length}`);
    console.log(`   Chat logs: ${chatLogs.length}`);
    console.log(`   Other logs: ${logs.length - toolLogs.length - routerLogs.length - chatLogs.length}`);
    
    if (toolLogs.length === 0) {
      console.log('\n⚠️  WARNING: No tool logs found! Tools may not be logging correctly.');
    } else {
      console.log('\n✅ Tool logging is working!');
      console.log('\n🔧 Tool Logs:');
      toolLogs.forEach(log => {
        console.log(`   - ${log.message} (${log.metadata?.toolName})`);
      });
    }
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
    throw error;
  }
}

testToolLogging().catch(console.error);
