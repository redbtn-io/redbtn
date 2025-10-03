/**
 * OpenAI-compatible API server for Red AI
 * Implements the OpenAI Chat Completions API format
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { Red, RedConfig } from '../src/index';

// Generate a fresh bearer token on each server startup (or use provided one from env)
// IMPORTANT: This MUST be declared before any other code to ensure it's only generated once
const BEARER_TOKEN = process.env.BEARER_TOKEN || (() => {
  const token = `red_ai_sk_${crypto.randomBytes(32).toString('hex')}`;
  console.log(`🔐 Generated bearer token: ${token}`);
  return token;
})();

const app = express();
app.use(cors());
app.use(express.json());

// Authentication middleware
function authenticateToken(req: Request, res: Response, next: any) {
  // Skip auth for health check
  if (req.path === '/health') {
    return next();
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({
      error: {
        message: 'Missing authorization header',
        type: 'invalid_request_error',
        code: 'missing_api_key'
      }
    });
  }

  if (token !== BEARER_TOKEN) {
    return res.status(403).json({
      error: {
        message: 'Invalid API key',
        type: 'invalid_request_error',
        code: 'invalid_api_key'
      }
    });
  }

  next();
}

// Apply authentication to all routes
app.use(authenticateToken);

// Initialize Red instance
const config: RedConfig = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  vectorDbUrl: process.env.VECTOR_DB_URL || "http://localhost:8200",
  databaseUrl: process.env.DATABASE_URL || "http://localhost:5432",
  defaultLlmUrl: process.env.LLM_URL || "http://localhost:11434",
};

let red: Red;

// Initialize Red on startup
async function initRed() {
  red = new Red(config);
  await red.load('api-server');
  console.log('Red AI initialized successfully');
}

// OpenAI Chat Completions API format
interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: 'assistant';
      content?: string;
    };
    finish_reason: 'stop' | 'length' | null;
  }>;
}

// Generate a unique ID for the completion
function generateId(): string {
  return `chatcmpl-${Date.now()}-${Math.random().toString(36).substring(7)}`;
}

// Extract the last user message from the conversation
function extractUserMessage(messages: ChatCompletionRequest['messages']): string {
  // Get the last user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  return lastUserMessage?.content || '';
}

// POST /v1/chat/completions
app.post('/v1/chat/completions', async (req: Request, res: Response) => {
  try {
    const body: ChatCompletionRequest = req.body;
    
    if (!body.messages || body.messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'messages is required and must not be empty',
          type: 'invalid_request_error',
          code: 'invalid_messages'
        }
      });
    }

    const completionId = generateId();
    const created = Math.floor(Date.now() / 1000);
    const modelName = body.model || 'Red';
    const userMessage = extractUserMessage(body.messages);

    // Streaming mode
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const stream = await red.respond(
        { message: userMessage },
        { source: { application: 'redChat' }, stream: true }
      );

      // Send initial chunk with role
      const initialChunk: ChatCompletionChunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelName,
        choices: [{
          index: 0,
          delta: { role: 'assistant' },
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

      // Stream content chunks
      for await (const chunk of stream) {
        if (typeof chunk === 'string') {
          const contentChunk: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [{
              index: 0,
              delta: { content: chunk },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
        } else {
          // Final chunk with metadata (AIMessage)
          const finalChunk: ChatCompletionChunk = {
            id: completionId,
            object: 'chat.completion.chunk',
            created,
            model: modelName,
            choices: [{
              index: 0,
              delta: {},
              finish_reason: 'stop'
            }]
          };
          res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        }
      }

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Non-streaming mode
      const response = await red.respond(
        { message: userMessage },
        { source: { application: 'redChat' } }
      );

      const completion: ChatCompletionResponse = {
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelName,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: response.usage_metadata?.input_tokens || 0,
          completion_tokens: response.usage_metadata?.output_tokens || 0,
          total_tokens: response.usage_metadata?.total_tokens || 0
        }
      };

      res.json(completion);
    }
  } catch (error) {
    console.error('Error in chat completion:', error);
    res.status(500).json({
      error: {
        message: error instanceof Error ? error.message : 'Internal server error',
        type: 'internal_error',
        code: 'internal_error'
      }
    });
  }
});

// GET /v1/models - List available models
app.get('/v1/models', (req: Request, res: Response) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'Red',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'redbtn',
        permission: [],
        root: 'Red',
        parent: null
      }
    ]
  });
});

// GET /health - Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Red AI API' });
});

// Start server
const PORT = process.env.PORT || 3000;

initRed().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 Red AI API Server running on http://localhost:${PORT}`);
    console.log(`📡 OpenAI-compatible endpoint: http://localhost:${PORT}/v1/chat/completions`);
    console.log(`📋 Models endpoint: http://localhost:${PORT}/v1/models`);
    console.log(`💚 Health check: http://localhost:${PORT}/health`);
    console.log('');
    console.log('🔑 Bearer Token for OpenWebUI:');
    console.log(`   ${BEARER_TOKEN}`);
    console.log('');
    console.log('💡 Add this to OpenWebUI:');
    console.log('   Settings → Connections → Add OpenAI API');
    console.log(`   API Base URL: http://localhost:${PORT}/v1`);
    console.log(`   API Key: ${BEARER_TOKEN}`);
  });
}).catch(error => {
  console.error('Failed to initialize Red AI:', error);
  process.exit(1);
});
