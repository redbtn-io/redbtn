# MCP over Redis

A complete implementation of the Model Context Protocol (MCP) using JSON-RPC 2.0 over Redis pub/sub as the transport layer.

## Overview

This implementation follows the MCP specification with a custom Redis-based transport layer instead of the standard stdio or HTTP transports. This provides:

- **Decoupled architecture** - Servers run as independent processes
- **Scalability** - Multiple clients can connect to the same servers
- **Reliability** - Redis pub/sub for message delivery
- **Compatibility with existing infrastructure** - Integrates with your Redis setup

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      MCP Client                          │
│  (Your Application using McpClient or McpRegistry)      │
└────────────────┬────────────────────────────────────────┘
                 │ JSON-RPC 2.0 over Redis Pub/Sub
                 │
         ┌───────┴────────┐
         │     Redis      │
         └───────┬────────┘
                 │
      ┌──────────┼──────────┐
      │          │          │
      ▼          ▼          ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│   Web    │ │  System  │ │  Future  │
│  Server  │ │  Server  │ │  Server  │
└──────────┘ └──────────┘ └──────────┘
```

### Protocol Flow

1. **Initialization**
   ```
   Client → Server: initialize (JSON-RPC request)
   Server → Client: capabilities + serverInfo (JSON-RPC response)
   Client → Server: notifications/initialized (JSON-RPC notification)
   ```

2. **Tool Discovery**
   ```
   Client → Server: tools/list (JSON-RPC request)
   Server → Client: { tools: [...] } (JSON-RPC response)
   ```

3. **Tool Execution**
   ```
   Client → Server: tools/call { name, arguments } (JSON-RPC request)
   Server → Client: { content: [...] } (JSON-RPC response)
   ```

4. **Notifications** (optional)
   ```
   Server → Client: notifications/tools/list_changed (JSON-RPC notification)
   ```

## Components

### 1. MCP Server (Base Class)

`src/lib/mcp/server.ts` - Abstract base class for all MCP servers

**Key Features:**
- JSON-RPC 2.0 message handling
- Tool registration and discovery
- Capability negotiation
- Redis pub/sub communication

**Usage:**
```typescript
import { McpServer } from './lib/mcp';

class MyServer extends McpServer {
  constructor(redis: Redis) {
    super(redis, 'my-server', '1.0.0');
  }

  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: {
        type: 'object',
        properties: {
          param: { type: 'string', description: 'A parameter' }
        },
        required: ['param']
      }
    });
  }

  protected async executeTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (name === 'my_tool') {
      return {
        content: [{
          type: 'text',
          text: `Result: ${args.param}`
        }]
      };
    }
    throw new Error(`Unknown tool: ${name}`);
  }
}
```

### 2. MCP Client

`src/lib/mcp/client.ts` - Client for connecting to MCP servers

**Usage:**
```typescript
import Redis from 'ioredis';
import { McpClient } from './lib/mcp';

const redis = new Redis('redis://localhost:6379');
const client = new McpClient(redis, 'web');

// Connect
await client.connect();

// Initialize
await client.initialize({
  name: 'my-app',
  version: '1.0.0'
});

// List tools
const tools = await client.listTools();

// Call a tool
const result = await client.callTool('web_search', {
  query: 'test query'
});

// Disconnect
await client.disconnect();
```

### 3. MCP Registry

`src/lib/mcp/registry.ts` - Manages multiple server connections

**Usage:**
```typescript
import Redis from 'ioredis';
import { McpRegistry } from './lib/mcp';

const redis = new Redis('redis://localhost:6379');
const registry = new McpRegistry(redis);

// Register servers
await registry.registerServer('web');
await registry.registerServer('system');

// List all tools
const tools = registry.getAllTools();

// Call any tool (registry finds the right server)
const result = await registry.callTool('web_search', {
  query: 'test'
});

// Cleanup
await registry.disconnectAll();
```

## Built-in Servers

### Web Server

Combines web search and URL scraping:

**Tools:**
- `web_search` - Search the web using Brave Search API
- `scrape_url` - Extract clean content from URLs using Jina AI

**Configuration:**
```bash
export BRAVE_API_KEY=your_brave_api_key
```

### System Server

Execute system commands safely:

**Tools:**
- `execute_command` - Execute allowed system commands

**Configuration:**
```typescript
const systemServer = new SystemServer(redis, {
  allowedCommands: ['ls', 'cat', 'pwd', 'echo'],
  workingDirectory: '/path/to/work'
});
```

## Running the Servers

### Start All Servers

```bash
npm run mcp:start
```

This starts:
- **Web Server** on channel `mcp:server:web:*`
- **System Server** on channel `mcp:server:system:*`

### Test the Servers

```bash
# Test individual client connections
npm run mcp:test

# Test registry usage
npm run mcp:test:registry
```

## Redis Channels

Each server uses two channels:

- **Request Channel**: `mcp:server:{name}:request`
  - Clients publish JSON-RPC requests here
  
- **Response Channel**: `mcp:server:{name}:response`
  - Server publishes JSON-RPC responses here

Example:
- Web Server: `mcp:server:web:request` / `mcp:server:web:response`
- System Server: `mcp:server:system:request` / `mcp:server:system:response`

## JSON-RPC 2.0 Message Format

### Request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "web_search",
    "arguments": { "query": "test" }
  }
}
```

### Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "Search results..."
    }]
  }
}
```

### Error Response
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Tool not found: unknown_tool"
  }
}
```

### Notification (no response expected)
```json
{
  "jsonrpc": "2.0",
  "method": "notifications/initialized"
}
```

## Creating Custom Servers

1. **Extend McpServer**:
```typescript
import { McpServer, CallToolResult } from './lib/mcp';

export class CustomServer extends McpServer {
  constructor(redis: Redis) {
    super(redis, 'custom', '1.0.0');
  }

  protected async setup(): Promise<void> {
    this.defineTool({
      name: 'my_tool',
      description: 'My custom tool',
      inputSchema: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      }
    });

    this.capabilities = {
      tools: { listChanged: false }
    };
  }

  protected async executeTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    // Implement your tool logic
    return {
      content: [{ type: 'text', text: 'Result' }]
    };
  }
}
```

2. **Register in launcher** (`src/mcp-servers.ts`):
```typescript
const customRedis = new Redis(redisUrl);
const customServer = new CustomServer(customRedis);
await customServer.start();
servers.push(customServer);
```

## Differences from Standard MCP

| Feature | Standard MCP | This Implementation |
|---------|-------------|---------------------|
| Transport | stdio or HTTP+SSE | Redis pub/sub |
| Protocol | JSON-RPC 2.0 | JSON-RPC 2.0 ✓ |
| Process Model | Separate processes | Separate processes ✓ |
| Tool Discovery | `tools/list` | `tools/list` ✓ |
| Tool Execution | `tools/call` | `tools/call` ✓ |
| Capabilities | Standard negotiation | Standard negotiation ✓ |
| Notifications | Supported | Supported ✓ |

**Why Redis instead of stdio/HTTP?**
- Already using Redis for streaming and state management
- Enables multiple clients to share the same servers
- Better suited for distributed/cloud architectures
- Integrates with existing reconnection infrastructure

## Compatibility

This implementation follows the MCP specification for:
- ✅ JSON-RPC 2.0 message format
- ✅ Initialization and capability negotiation
- ✅ Tool discovery and execution
- ✅ Error handling
- ✅ Notifications

**Not compatible with:**
- ❌ Standard MCP clients (Claude Desktop, etc.) - they use stdio/HTTP
- ❌ Standard MCP servers - they use stdio/HTTP

To use standard MCP tools, you would need a bridge/adapter between transports.

## Environment Variables

```bash
# Redis connection
REDIS_URL=redis://localhost:6379

# Web Server (Brave Search)
BRAVE_API_KEY=your_api_key
```

## Development

```bash
# Start servers in development
npm run mcp:start

# Test client
npm run mcp:test

# Test registry
npm run mcp:test:registry

# Build
npm run build
```

## Future Enhancements

- [ ] Resource primitives (files, databases)
- [ ] Prompt primitives (templates)
- [ ] Sampling (request LLM completions from client)
- [ ] Elicitation (request user input from client)
- [ ] Progress tracking for long operations
- [ ] Dynamic tool list changes with notifications
- [ ] Server discovery (register in Redis)
- [ ] Authentication and authorization
- [ ] Rate limiting per client
- [ ] Metrics and monitoring

## References

- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [JSON-RPC 2.0 Specification](https://www.jsonrpc.org/)
- [MCP Architecture](https://modelcontextprotocol.io/docs/learn/architecture)
