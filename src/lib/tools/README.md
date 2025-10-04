# Red AI Tools

This directory contains tool implementations that extend Red AI's capabilities through function calling.

## Available Tools

### 1. Web Search (`web_search`)

Searches Google using the Custom Search API to find current information on the web.

**Usage:**
```typescript
// The AI will automatically use this tool when asked to search the web
await red.respond({
  message: 'Search the web for the latest AI news'
});
```

**Parameters:**
- `query` (string): The search query

**Requirements:**
- `GOOGLE_API_KEY` environment variable
- `GOOGLE_SEARCH_ENGINE_ID` or `GOOGLE_CSE_ID` environment variable

**Setup:**
1. Get a Google API key: https://console.cloud.google.com/apis/credentials
2. Create a Custom Search Engine: https://programmablesearchengine.google.com/
3. Enable Custom Search API in Google Cloud Console
4. Add credentials to `.env`:
```bash
GOOGLE_API_KEY=your_api_key_here
GOOGLE_SEARCH_ENGINE_ID=your_cse_id_here
```

### 2. Send Command (`send_command`)

Executes CLI commands on the system and returns the output.

**Usage:**
```typescript
// The AI will automatically use this tool when asked to run commands
await red.respond({
  message: 'List all files in the current directory'
});
```

**Parameters:**
- `command` (string): The CLI command to execute
- `timeout` (number, optional): Timeout in milliseconds (default: 30000)

**Security:**
- Dangerous commands like `rm -rf /` are blocked
- Commands have a 30-second timeout by default
- Output is truncated to 4KB to prevent memory issues
- Runs in `/bin/bash` shell

**Blocked Patterns:**
- `rm -rf /` and similar destructive commands
- Fork bombs
- Filesystem formatting commands
- Direct disk access commands

### 3. Scrape URL (`scrape_url`)

Fetches and extracts text content from a webpage, returning only the main body text.

**Usage:**
```typescript
// The AI will automatically use this tool when asked to read a webpage
await red.respond({
  message: 'Read the content from https://example.com/article'
});
```

**Parameters:**
- `url` (string): The URL to scrape (must be http or https)

**Features:**
- Extracts only text content (removes HTML, scripts, styles)
- Automatically decodes HTML entities
- Limited to 1000 tokens to keep responses manageable
- 10-second timeout for page fetching
- Only allows HTTP/HTTPS protocols

**Limitations:**
- JavaScript-rendered content is not supported (no headless browser)
- Complex HTML structures may not parse perfectly
- Content is truncated at 1000 tokens

## How Tools Work

Tools are automatically called by the LLM when appropriate:

1. User sends a query
2. LLM analyzes if tools are needed
3. LLM calls one or more tools with parameters
4. Tools execute and return results
5. LLM uses tool results to generate final response
6. Process repeats if more tool calls are needed (max 10 iterations)

## Adding New Tools

To add a new tool:

1. Create a new file in `src/lib/tools/` (e.g., `my_tool.ts`)
2. Define your tool using `DynamicStructuredTool`:

```typescript
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export const myTool = new DynamicStructuredTool({
  name: "my_tool",
  description: "Clear description of what the tool does and when to use it",
  schema: z.object({
    param1: z.string().describe("Description of param1"),
    param2: z.number().optional().describe("Optional param2"),
  }),
  func: async ({ param1, param2 }) => {
    // Tool implementation
    return "Result of the tool execution";
  },
});
```

3. Export it in `src/lib/tools/index.ts`:

```typescript
import { myTool } from './my_tool';

export const allTools = [
  webSearchTool,
  sendCommandTool,
  myTool, // Add your tool here
];

export { myTool }; // Export individually too
```

4. The tool will automatically be available to the LLM!

## Testing Tools

Run the test suite:

```bash
npm run test:tools
# or
npx tsx examples/test-tools.ts
```

## Best Practices

1. **Clear Descriptions**: Write detailed descriptions so the LLM knows when to use each tool
2. **Parameter Descriptions**: Document each parameter clearly
3. **Error Handling**: Always handle errors gracefully and return user-friendly messages
4. **Security**: Validate inputs and sanitize outputs, especially for system-level tools
5. **Timeouts**: Set appropriate timeouts for long-running operations
6. **Output Size**: Truncate large outputs to prevent memory issues
7. **Logging**: Log tool execution for debugging and monitoring

## Architecture

Tools are integrated into the chat node (`src/lib/nodes/chat.ts`):

1. Tools are bound to the model using `model.bindTools(allTools)`
2. When the model returns tool calls, they're executed automatically
3. Tool results are added back to the conversation
4. The model generates a final response using the tool results
5. This creates a ReAct-style (Reasoning + Acting) agent loop

## Environment Variables

Required for tools to work:

```bash
# Web Search Tool
GOOGLE_API_KEY=your_google_api_key
GOOGLE_SEARCH_ENGINE_ID=your_cse_id

# Optional - for other tools in the future
# DATABASE_URL=postgresql://localhost/red
# REDIS_URL=redis://localhost:6379
```
