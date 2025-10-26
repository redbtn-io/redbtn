#!/usr/bin/env tsx
/**
 * MCP Registry Test
 * Demonstrates how to use the registry to manage multiple MCP servers
 */

import Redis from 'ioredis';
import { McpRegistry } from '../src/lib/mcp/registry';

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

async function main() {
  console.log('MCP Registry Test');
  console.log('=================');
  console.log('Redis URL:', redisUrl);
  console.log('\nMake sure MCP servers are running: npm run mcp:start\n');
  
  const redis = new Redis(redisUrl);
  const registry = new McpRegistry(redis);
  
  try {
    // Register all servers
    console.log('--- Registering Servers ---\n');
    await registry.registerServer('web');
    await registry.registerServer('system');
    
    // List all servers
    console.log('\n--- Registered Servers ---\n');
    const servers = registry.getAllServers();
    for (const server of servers) {
      console.log(`• ${server.name} v${server.version}`);
      console.log(`  Tools: ${server.tools.map(t => t.name).join(', ')}`);
    }
    
    // List all tools
    console.log('\n--- All Available Tools ---\n');
    const tools = registry.getAllTools();
    for (const { server, tool } of tools) {
      console.log(`• ${tool.name} (from ${server})`);
      console.log(`  ${tool.description}`);
    }
    
    // Test calling tools via registry
    console.log('\n--- Testing Tool Calls via Registry ---\n');
    
    // Call web_search
    console.log('1. Testing web_search...');
    const searchResult = await registry.callTool('web_search', {
      query: 'Model Context Protocol',
      count: 2
    });
    console.log('✓ Result:', searchResult.content[0].text?.substring(0, 150) + '...');
    
    // Call execute_command
    console.log('\n2. Testing execute_command...');
    const cmdResult = await registry.callTool('execute_command', {
      command: 'echo "Registry test successful!"'
    });
    console.log('✓ Result:', cmdResult.content[0].text);
    
    // Find a specific tool
    console.log('\n--- Finding a Specific Tool ---\n');
    const found = registry.findTool('scrape_url');
    if (found) {
      console.log(`Found tool: ${found.tool.name}`);
      console.log(`  Server: ${found.server}`);
      console.log(`  Description: ${found.tool.description}`);
    }
    
    // Disconnect all
    console.log('\n--- Disconnecting ---\n');
    await registry.disconnectAll();
    await redis.quit();
    
    console.log('✓ Registry test completed successfully!\n');
    process.exit(0);
    
  } catch (error) {
    console.error('✗ Test failed:', error);
    await registry.disconnectAll();
    await redis.quit();
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main();
}
