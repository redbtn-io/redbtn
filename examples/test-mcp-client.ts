#!/usr/bin/env tsx
/**
 * MCP Client Test
 * Demonstrates how to use the MCP client to interact with MCP servers
 */

import Redis from 'ioredis';
import { McpClient } from '../src/lib/mcp/client';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function testWebServer() {
  console.log('\n=== Testing Web Server ===\n');
  
  const redis = new Redis(redisUrl);
  const client = new McpClient(redis, 'web');
  
  try {
    // Connect to server
    await client.connect();
    
    // Initialize
    const initResult = await client.initialize({
      name: 'test-client',
      version: '1.0.0'
    });
    
    console.log('✓ Connected to server:', initResult.serverInfo);
    console.log('✓ Server capabilities:', initResult.capabilities);
    
    // List tools
    const toolsList = await client.listTools();
    console.log('\n✓ Available tools:', toolsList.tools.map(t => t.name));
    
    // Test web search
    console.log('\n--- Testing web_search ---');
    const searchResult = await client.callTool('web_search', {
      query: 'latest news about AI',
      count: 3
    });
    console.log('Search result:', searchResult.content[0].text?.substring(0, 200) + '...');
    
    // Test URL scraping
    console.log('\n--- Testing scrape_url ---');
    const scrapeResult = await client.callTool('scrape_url', {
      url: 'https://example.com'
    });
    console.log('Scrape result:', scrapeResult.content[0].text?.substring(0, 200) + '...');
    
    // Disconnect
    await client.disconnect();
    await redis.quit();
    
    console.log('\n✓ Web server test completed\n');
    
  } catch (error) {
    console.error('✗ Error:', error);
    await client.disconnect();
    await redis.quit();
  }
}

async function testSystemServer() {
  console.log('\n=== Testing System Server ===\n');
  
  const redis = new Redis(redisUrl);
  const client = new McpClient(redis, 'system');
  
  try {
    // Connect to server
    await client.connect();
    
    // Initialize
    const initResult = await client.initialize({
      name: 'test-client',
      version: '1.0.0'
    });
    
    console.log('✓ Connected to server:', initResult.serverInfo);
    
    // List tools
    const toolsList = await client.listTools();
    console.log('✓ Available tools:', toolsList.tools.map(t => t.name));
    
    // Test command execution
    console.log('\n--- Testing execute_command ---');
    const cmdResult = await client.callTool('execute_command', {
      command: 'echo "Hello from MCP!"'
    });
    console.log('Command result:', cmdResult.content[0].text);
    
    // Test another command
    const pwdResult = await client.callTool('execute_command', {
      command: 'pwd'
    });
    console.log('PWD result:', pwdResult.content[0].text);
    
    // Disconnect
    await client.disconnect();
    await redis.quit();
    
    console.log('\n✓ System server test completed\n');
    
  } catch (error) {
    console.error('✗ Error:', error);
    await client.disconnect();
    await redis.quit();
  }
}

async function main() {
  console.log('MCP Client Test');
  console.log('===============');
  console.log('Redis URL:', redisUrl);
  console.log('\nMake sure MCP servers are running: npm run mcp:start\n');
  
  try {
    await testWebServer();
    await testSystemServer();
    
    console.log('✓ All tests completed successfully!');
    process.exit(0);
    
  } catch (error) {
    console.error('✗ Test failed:', error);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
