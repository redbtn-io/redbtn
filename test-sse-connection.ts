#!/usr/bin/env tsx
/**
 * Test SSE MCP Server Connection
 * Quick test to verify Red AI can connect to SSE servers
 */

import { Red } from './src/index';

async function test() {
  console.log('Testing SSE MCP connection...\n');
  
  try {
    const red = new Red({
      redisUrl: 'redis://localhost:6379',
      vectorDbUrl: 'http://localhost:8024',
      databaseUrl: 'postgresql://localhost:5432/redbtn',
      chatLlmUrl: 'http://localhost:11434',
      workLlmUrl: 'http://localhost:11434'
    });

    await red.load();
    
    // Try to list tools
    const tools = red.mcpRegistry.getAllTools();
    console.log('\n✓ Successfully connected to MCP servers!');
    console.log(`Found ${tools.length} tools:\n`);
    
    const toolsByServer = new Map<string, string[]>();
    for (const entry of tools) {
      const serverName = entry.server;
      const toolName = entry.tool.name;
      if (!toolsByServer.has(serverName)) {
        toolsByServer.set(serverName, []);
      }
      toolsByServer.get(serverName)!.push(toolName);
    }
    
    for (const [server, toolNames] of toolsByServer) {
      console.log(`\n${server} (${toolNames.length} tools):`);
      for (const name of toolNames) {
        console.log(`  - ${name}`);
      }
    }
    
    // Test a simple tool call
    console.log('\n\nTesting tool execution...');
    const client = red.mcpRegistry.getClient('system');
    if (client) {
      const result = await client.callTool('execute_command', {
        command: 'echo "SSE MCP is working!"'
      });
      console.log('\n✓ Tool execution successful!');
      console.log('Result:', JSON.stringify(result, null, 2));
    }
    
    console.log('\n✓ All tests passed!');
    process.exit(0);
    
  } catch (error) {
    console.error('\n✗ Test failed:', error);
    process.exit(1);
  }
}

test();
