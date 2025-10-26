# Integrating MCP with Red AI

This guide shows how to integrate the MCP servers with the main Red AI system.

## Quick Start

### 1. Start MCP Servers

In one terminal:
```bash
cd ai
npm run mcp:start
```

This starts:
- **Web Server** - Provides `web_search` and `scrape_url` tools
- **System Server** - Provides `execute_command` tool

### 2. Use MCP Tools in Red AI

There are two ways to use MCP tools:

## Option A: Direct Client Connection

```typescript
import Redis from 'ioredis';
import { McpClient } from '@redbtn/ai';

// In your Red node or tool
const redis = new Redis(process.env.REDIS_URL);
const webClient = new McpClient(redis, 'web');

await webClient.connect();
await webClient.initialize({
  name: 'red-ai',
  version: '1.0.0'
});

// Use in your tool logic
const result = await webClient.callTool('web_search', {
  query: userQuery,
  count: 5
});
```

## Option B: Registry-Based (Recommended)

```typescript
import Redis from 'ioredis';
import { McpRegistry } from '@redbtn/ai';

// Initialize once in Red class
class Red {
  private mcpRegistry: McpRegistry;
  
  constructor(config: RedConfig) {
    // ... existing setup
    this.mcpRegistry = new McpRegistry(this.redis);
  }
  
  async load(nodeId?: string) {
    // ... existing load logic
    
    // Register MCP servers
    await this.mcpRegistry.registerServer('web');
    await this.mcpRegistry.registerServer('system');
  }
  
  // Helper method to call MCP tools
  async callMcpTool(toolName: string, args: Record<string, unknown>) {
    return await this.mcpRegistry.callTool(toolName, args);
  }
}
```

## Updating Tool Nodes

### Before (Direct Implementation)

```typescript
// src/lib/nodes/tool.ts
export const toolNode = async (state: any) => {
  if (state.selectedTool === 'web_search') {
    // Direct Brave API call
    const response = await fetch(
      `https://api.search.brave.com/...`,
      { headers: { 'X-Subscription-Token': braveApiKey } }
    );
  }
};
```

### After (Using MCP)

```typescript
// src/lib/nodes/tool.ts
export const toolNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  
  if (state.selectedTool === 'web_search') {
    // Call via MCP
    const result = await redInstance.callMcpTool('web_search', {
      query: state.searchQuery,
      count: 5
    });
    
    return {
      toolResult: result.content[0].text
    };
  }
};
```

## Benefits of Using MCP

1. **Decoupled** - Tools run in separate processes
2. **Reusable** - Same tools can be used by multiple systems
3. **Reliable** - Process isolation and error handling
4. **Scalable** - Can distribute servers across machines
5. **Standard** - Follows MCP protocol for tool definition

## Tool Mapping

| Current Tool | MCP Server | MCP Tool Name | Notes |
|--------------|------------|---------------|-------|
| Web Search | `web` | `web_search` | Uses Brave Search API |
| URL Scraper | `web` | `scrape_url` | Uses Jina AI Reader |
| System Commands | `system` | `execute_command` | Sandboxed execution |

## Example: Router Node Integration

```typescript
// src/lib/nodes/router.ts
export const routerNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  
  // Analyze query (existing logic)
  const routingDecision = await analyzeQuery(state.query);
  
  if (routingDecision.action === 'WEB_SEARCH') {
    // Use MCP for web search
    const searchResult = await redInstance.callMcpTool('web_search', {
      query: routingDecision.searchQuery,
      count: 5
    });
    
    return {
      selectedTool: 'web_search',
      toolResult: searchResult.content[0].text,
      nextStep: 'chat'
    };
  }
  
  if (routingDecision.action === 'SCRAPE_URL') {
    // Use MCP for URL scraping
    const scrapeResult = await redInstance.callMcpTool('scrape_url', {
      url: routingDecision.url
    });
    
    return {
      selectedTool: 'scrape_url',
      toolResult: scrapeResult.content[0].text,
      nextStep: 'chat'
    };
  }
  
  // ... existing chat logic
};
```

## Testing

```bash
# Test basic client functionality
npm run mcp:test

# Test registry (multiple servers)
npm run mcp:test:registry

# Test with Red AI
npm run test:tools
```

## Monitoring

MCP servers log to console:

```
[MCP Server] Starting web v1.0.0
[MCP Server] web registered 2 tools
[MCP Server] web listening on mcp:server:web:request
[MCP Server] web executing tool: web_search
```

## Environment Variables

```bash
# Required for MCP
REDIS_URL=redis://localhost:6379

# Required for web server
BRAVE_API_KEY=your_brave_api_key

# Optional: for system server
# (defaults are safe commands only)
```

## Error Handling

MCP tools return structured errors:

```typescript
try {
  const result = await redInstance.callMcpTool('web_search', { query });
  
  if (result.isError) {
    console.error('Tool error:', result.content[0].text);
    // Handle error gracefully
  } else {
    // Use result
    const content = result.content[0].text;
  }
} catch (error) {
  // Handle connection/timeout errors
  console.error('MCP call failed:', error);
}
```

## Cleanup

When shutting down Red AI:

```typescript
class Red {
  async shutdown() {
    // Disconnect from MCP servers
    await this.mcpRegistry.disconnectAll();
    
    // ... existing cleanup
  }
}
```

## Future Integration Points

1. **Dynamic Tool Discovery**
   - Query available tools at runtime
   - Update LangChain tool definitions dynamically

2. **Tool Metadata**
   - Use MCP tool schemas for validation
   - Generate LangChain tool wrappers automatically

3. **Progress Tracking**
   - Stream tool execution progress
   - Show real-time updates to users

4. **Distributed Tools**
   - Run expensive tools on separate servers
   - Scale horizontally

## See Also

- [MCP Implementation README](../lib/mcp/README.md)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Test Examples](../examples/test-mcp-*.ts)
