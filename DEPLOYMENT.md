# Red AI Deployment Guide

This guide covers deploying the Red AI standalone Express server.

## 🚀 Standalone Express Server

**Best for:**
- Local development
- OpenWebUI integration
- Running with `--think` mode
- Self-hosted environments
- When you need full control

**Pros:**
- ✅ Fast cold starts (~500ms)
- ✅ Full tiktoken support
- ✅ OpenWebUI compatible
- ✅ Can run specialized modes (--think)
- ✅ Lower memory footprint

**Cons:**
- ❌ Requires always-on server
- ❌ Manual scaling
- ❌ Need to manage infrastructure

**How to run:**
```bash
# Development (with auto-reload)
npm run dev:server

# Production
npm run start:server

# Think mode (autonomous operation)
npm run think
# or
THINK=true npm run start:server
```

**Environment Variables:**
Create a `.env` file:
```env
REDIS_URL=redis://localhost:6379
LLM_URL=http://localhost:11434
BEARER_TOKEN=your_custom_token_here
PORT=3000
```

---

## 🏗️ Architecture

The Red AI library is a standalone module that can be integrated into various applications:

```
@redbtn/ai/
├── src/                    # Core Red AI library
│   ├── index.ts           # Main exports
│   ├── lib/
│   │   ├── memory.ts
│   │   ├── tokenizer.ts
│   │   ├── models.ts
│   │   ├── graphs/
│   │   │   └── red.ts
│   │   └── nodes/
│   │       ├── chat.ts
│   │       └── router.ts
│
├── examples/
│   └── server.ts          # Standalone Express server example
│
├── index.ts               # Package entry point
└── dist/                  # Compiled output (after build)
```

---

## 📦 Using as a Module

The Red AI library can be packaged and used in other projects:

```bash
# Build and package
npm run build
npm pack

# This creates: redbtn-ai-0.0.1.tgz
```

In your other project:
```bash
npm install /path/to/redbtn-ai-0.0.1.tgz
```

Then import and use:
```typescript
import { Red, RedConfig } from '@redbtn/ai';

const config: RedConfig = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  vectorDbUrl: process.env.VECTOR_DB_URL || "http://localhost:8200",
  databaseUrl: process.env.DATABASE_URL || "http://localhost:5432",
  defaultLlmUrl: process.env.LLM_URL || "http://localhost:11434",
};

const red = new Red(config);
await red.load();
const response = await red.respond({ message: 'Hello!' }, { source: { application: 'redChat' } });
```

---

## 🔧 Configuration

### Standalone Server (.env)
```env
# Required
REDIS_URL=redis://localhost:6379

# Optional
LLM_URL=http://localhost:11434
VECTOR_DB_URL=http://localhost:8200
DATABASE_URL=postgresql://localhost:5432
BEARER_TOKEN=red_ai_sk_custom_token
PORT=3000
```

---

## 🚦 Quick Start

### For Local Development:
```bash
# Install dependencies
npm install

# Start Express server
npm run dev:server

# In another terminal, test with curl:
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "model": "Red",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

### For Production:
```bash
# Clone and setup
git clone <repo>
npm install
npm run build

# Run with PM2 or similar
npm run start:server

# Or use systemd, Docker, etc.
```

---

## 🐳 Docker Deployment

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --production

COPY . .
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:server"]
```

Build and run:
```bash
docker build -t redbtn-ai .
docker run -p 3000:3000 --env-file .env redbtn-ai
```

---

## 📚 Additional Resources

- [Express Server Documentation](./examples/SERVER.md)
- [API Documentation](./examples/API-STATUS.md)
- [Core Library README](./README.md)
- [Examples](./examples/)

---

## 🤝 Integration Examples

### OpenWebUI

Point OpenWebUI to your Red AI server:
```
API Endpoint: http://localhost:3000/v1
API Key: your_bearer_token
```

### Cursor / Continue

Add to your `.cursorrules` or Continue config:
```json
{
  "models": [
    {
      "title": "Red AI",
      "provider": "openai",
      "model": "Red",
      "apiBase": "http://localhost:3000/v1",
      "apiKey": "your_bearer_token"
    }
  ]
}
```

---

Built with ❤️ by the Red Button team