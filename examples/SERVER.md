# Red AI OpenAI-Compatible API Server

This example demonstrates how to run Red AI as an OpenAI-compatible API server. This allows you to use Red AI with any tool that supports the OpenAI API format, including OpenWebUI, Cursor, Continue, and more.

## Quick Start

### 1. Start the server

```bash
npm run server
```

The server will start on `http://localhost:3000` (configurable via `PORT` environment variable).

**Important:** The server will display your Bearer token on startup. Copy this token - you'll need it for authentication!

### 2. Configure your LLM endpoint

Set the `LLM_URL` environment variable to point to your Ollama instance:

```bash
export LLM_URL=http://localhost:11434
npm run server
```

Or use the `.env` file approach for all configuration options.

### 3. Get your Bearer token

When the server starts, it will display your Bearer token:

```
🔑 Bearer Token for OpenWebUI:
   red_ai_sk_a7f8e9d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8
```

Copy this token to use in your API requests.

### 4. Test with curl

**Non-streaming request:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer red_ai_sk_a7f8e9d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8" \
  -d '{
    "model": "Red",
    "messages": [
      {"role": "user", "content": "Hello! How are you?"}
    ],
    "stream": false
  }'
```

**Streaming request:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer red_ai_sk_a7f8e9d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8" \
  -d '{
    "model": "Red",
    "messages": [
      {"role": "user", "content": "Tell me a short story"}
    ],
    "stream": true
  }'
```

**List available models:**

```bash
curl http://localhost:3000/v1/models
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `BEARER_TOKEN` | Authentication token | Auto-generated secure token |
| `LLM_URL` | Ollama endpoint URL | `https://llm.redbtn.io` |
| `REDIS_URL` | Redis connection URL | `redis://localhost:6379` |
| `VECTOR_DB_URL` | Vector database URL | `http://localhost:8200` |
| `DATABASE_URL` | Traditional database URL | `http://localhost:5432` |

**Generate your own token:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Using with OpenWebUI

1. Start the Red AI API server:
   ```bash
   npm run server
   ```

2. In OpenWebUI, go to **Settings** → **Connections**

3. Add a new OpenAI API connection:
   - **API Base URL**: `http://localhost:3000/v1`
   - **API Key**: `red_ai_sk_a7f8e9d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8`
   
   (Copy the token from your server startup output)
   
4. The "Red" model should now appear in your model selector!

## Using with Cursor / Continue

Add to your Cursor/Continue settings:

```json
{
  "models": [
    {
      "title": "Red AI",
      "provider": "openai",
      "model": "Red",
      "apiBase": "http://localhost:3000/v1"
    }
  ]
}
```

## API Endpoints

### POST /v1/chat/completions

OpenAI-compatible chat completions endpoint.

**Request body:**

```json
{
  "model": "Red",
  "messages": [
    {"role": "user", "content": "Your message here"}
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1000
}
```

**Response (non-streaming):**

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "Red",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Response text here"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30
  }
}
```

**Response (streaming):**

Server-Sent Events (SSE) format:

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"Red","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"Red","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"Red","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1234567890,"model":"Red","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

### GET /v1/models

List available models.

**Response:**

```json
{
  "object": "list",
  "data": [
    {
      "id": "Red",
      "object": "model",
      "created": 1234567890,
      "owned_by": "redbtn"
    }
  ]
}
```

### GET /health

Health check endpoint.

**Response:**

```json
{
  "status": "ok",
  "service": "Red AI API"
}
```

## Production Deployment

For production use:

1. **Add authentication**: Implement API key validation
2. **Rate limiting**: Add rate limiting middleware
3. **HTTPS**: Use a reverse proxy (nginx, Caddy) with TLS
4. **Monitoring**: Add logging and metrics
5. **Process management**: Use PM2 or similar

Example with PM2:

```bash
npm install -g pm2
pm2 start npm --name "red-ai-api" -- run server
pm2 save
pm2 startup
```

## Development

Start the server with auto-reload on file changes:

```bash
npm run dev
```

## Troubleshooting

### "fetch failed" or "ECONNREFUSED" errors

- Make sure Ollama is running: `ollama serve`
- Check that the LLM_URL environment variable points to the correct Ollama endpoint
- Verify Ollama is accessible: `curl http://localhost:11434/api/tags`

### OpenWebUI doesn't show the Red model

- Verify the server is running and accessible
- Check the API Base URL is set to `http://localhost:3000/v1` (include `/v1`)
- Try refreshing the models list in OpenWebUI settings

### Streaming doesn't work

- Some clients buffer SSE responses - try with curl first to verify
- Check that the `stream` parameter is set to `true` in the request
