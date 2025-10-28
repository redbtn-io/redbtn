/**
 * OpenAI-compatible API server for Red AI
 * Implements the OpenAI Chat Completions API format
 */

// Load environment variables from .env if present
import 'dotenv/config';

import express, { Request, Response } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { Red, RedConfig } from '@redbtn/ai';

// Check if running in think mode (no HTTP server, just autonomous thinking)
const THINK_MODE = process.env.THINK === 'true' || process.env.THINK === '1';

// Generate a fresh bearer token on each server startup (or use provided one from env)
// IMPORTANT: This MUST be declared before any other code to ensure it's only generated once
const BEARER_TOKEN = process.env.BEARER_TOKEN || (() => {
  const token = `red_ai_sk_${crypto.randomBytes(32).toString('hex')}`;
  if (!THINK_MODE) {
    console.log(`🔐 Generated bearer token: ${token}`);
  }
  return token;
})();

if (process.env.BEARER_TOKEN && !THINK_MODE) {
  console.log(`🔑 Using provided bearer token: ${BEARER_TOKEN}`);
}

const app = express();

// Configure CORS to allow OpenWebUI requests
app.use(cors({
  origin: '*', // Allow all origins (restrict in production)
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Type'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Increase JSON payload limit to 100MB (default is 100kb)
app.use(express.json({ limit: '100mb' }));

// Authentication middleware
function authenticateToken(req: Request, res: Response, next: any) {
  // Skip auth for health check and OPTIONS requests (CORS preflight)
  if (req.path === '/health' || req.method === 'OPTIONS') {
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
  // Use the Redis URI scheme so ioredis connects correctly
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  vectorDbUrl: process.env.VECTOR_DB_URL || "http://localhost:8200",
  databaseUrl: process.env.DATABASE_URL || "mongodb://localhost:27017/red-webapp",
  chatLlmUrl: process.env.CHAT_LLM_URL || "http://localhost:11434",
  workLlmUrl: process.env.WORK_LLM_URL || "http://localhost:11434",
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
  // OpenWebUI and other clients may send conversation IDs under various field names
  chat_id?: string;
  conversation_id?: string;
  conversationId?: string;
  session_id?: string;
  sessionId?: string;
  [key: string]: any; // Allow other fields
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

// Extract conversation ID from request header (if client provides one)
function getConversationIdFromHeader(req: Request): string | undefined {
  return req.headers['x-conversation-id'] as string | undefined;
}

// Extract conversation ID from request body, checking multiple possible field names
function getConversationIdFromBody(body: ChatCompletionRequest): string | undefined {
  // Check common field names that clients might use
  const possibleFields = [
    'chat_id',
    'chatId', 
    'conversation_id',
    'conversationId',
    'session_id',
    'sessionId',
    'thread_id',
    'threadId'
  ];
  
  for (const field of possibleFields) {
    if (body[field]) {
      console.log(`📝 Found conversation ID in body.${field}: ${body[field]}`);
      return body[field] as string;
    }
  }
  
  return undefined;
}

// Generate a stable conversation ID from the message history
// Uses the first user message to create a consistent ID for the same conversation
function generateStableConversationId(messages: ChatCompletionRequest['messages']): string {
  // Find the first user message in the conversation
  const firstUserMessage = messages.find(m => m.role === 'user');
  
  if (!firstUserMessage) {
    // Fallback: generate random ID if no user message found
    return `conv_${crypto.randomBytes(8).toString('hex')}`;
  }
  
  // Create a stable hash from the first user message
  const hash = crypto.createHash('sha256')
    .update(firstUserMessage.content)
    .digest('hex')
    .substring(0, 16);
  
  return `conv_${hash}`;
}

// Chat completions handler (used by both /chat/completions and /v1/chat/completions)
async function handleChatCompletion(req: Request, res: Response) {
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
    
    // Debug: Log comprehensive request info to understand what OpenWebUI sends
    console.log(`\n📨 === Request Details ===`);
    console.log(`📋 Body keys: ${Object.keys(body).join(', ')}`);
    console.log(`🔑 Headers: ${JSON.stringify(req.headers, null, 2)}`);
    console.log(`🔍 Query params: ${JSON.stringify(req.query, null, 2)}`);
    console.log(`🛣️  URL: ${req.url}`);
    console.log(`📦 Full body (first 500 chars): ${JSON.stringify(body).substring(0, 500)}`);
    console.log(`========================\n`);
    
    // Get conversation ID from:
    // 1. Request body (chat_id, conversation_id, etc.) - for custom clients
    // 2. Request header (X-Conversation-ID) - for custom clients
    // 3. Generate stable ID from first user message - for OpenWebUI and stateless clients
    const conversationId = getConversationIdFromBody(body) || 
                          getConversationIdFromHeader(req) || 
                          generateStableConversationId(body.messages);
    
    console.log(`🔗 Using conversation ID: ${conversationId}`);


    // Streaming mode
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders(); // Flush headers immediately

      // Red handles: storing user message, getting context, generating response,
      // storing assistant message, and triggering summarization
      const stream = await red.respond(
        { message: userMessage },
        { 
          source: { application: 'redChat' }, 
          stream: true, 
          conversationId 
        }
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
      
      // Flush immediately after writing
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }

      // Stream content chunks - character by character
      let fullResponse = '';
      let firstTokenTime: number | null = null;
      let actualConversationId: string | undefined = conversationId;
      const streamStartTime = Date.now();

      for await (const chunk of stream) {
        // First chunk is metadata containing the actual conversationId
        if (typeof chunk === 'object' && chunk._metadata && chunk.conversationId) {
          actualConversationId = chunk.conversationId;
          continue; // Skip processing metadata, move to next chunk
        }
        
        // Log time to first token (include conversationId if present)
        if (firstTokenTime === null && typeof chunk === 'string') {
          firstTokenTime = Date.now() - streamStartTime;
          if (actualConversationId) {
            console.log(`⏱️  Time to first token for ${actualConversationId}: ${firstTokenTime}ms`);
          } else {
            console.log(`⏱️  Time to first token: ${firstTokenTime}ms`);
          }
        }
        if (typeof chunk === 'string') {
          fullResponse += chunk; // Accumulate for storage
          
          // Split chunk into individual characters and stream them
          const characters = chunk.split('');
          
          for (const char of characters) {
            const contentChunk: ChatCompletionChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model: modelName,
              choices: [{
                index: 0,
                delta: { content: char },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(contentChunk)}\n\n`);
            
            // Flush after each character to ensure immediate delivery
            if (typeof (res as any).flush === 'function') {
              (res as any).flush();
            }
          }
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
      // Red handles: storing user message, getting context, generating response,
      // storing assistant message, and triggering summarization
      const response = await red.respond(
        { message: userMessage },
        { 
          source: { application: 'redChat' }, 
          conversationId 
        }
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
}

// POST /chat/completions (OpenWebUI calls this without /v1)
app.post('/chat/completions', handleChatCompletion);

// POST /v1/chat/completions
app.post('/v1/chat/completions', handleChatCompletion);

// Helper function to return models list
const getModelsList = () => ({
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

// Helper function to return single model
const getModelDetails = (modelId: string) => {
  if (modelId === 'Red' || modelId === 'red') {
    return {
      id: 'Red',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'redbtn',
      permission: [],
      root: 'Red',
      parent: null
    };
  }
  return null;
};

// GET /models - List available models (OpenWebUI calls this without /v1)
app.get('/models', (req: Request, res: Response) => {
  res.json(getModelsList());
});

// GET /models/{model_id} - Get specific model details (OpenWebUI calls this without /v1)
app.get('/models/:model_id', (req: Request, res: Response) => {
  const modelId = req.params.model_id;
  const model = getModelDetails(modelId);
  
  if (model) {
    res.json(model);
  } else {
    res.status(404).json({
      error: {
        message: `Model '${modelId}' not found`,
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    });
  }
});

// GET /v1/models - List available models
app.get('/v1/models', (req: Request, res: Response) => {
  res.json(getModelsList());
});

// GET /v1/models/{model_id} - Get specific model details (required by OpenWebUI)
app.get('/v1/models/:model_id', (req: Request, res: Response) => {
  const modelId = req.params.model_id;
  const model = getModelDetails(modelId);
  
  if (model) {
    res.json(model);
  } else {
    res.status(404).json({
      error: {
        message: `Model '${modelId}' not found`,
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    });
  }
});

// GET /health - Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Red AI API' });
});

// GET / - Root endpoint
app.get('/', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'Red AI API',
    version: '1.0.0',
    endpoints: {
      chat: '/v1/chat/completions',
      models: '/v1/models',
      health: '/health'
    }
  });
});

// GET /v1 - API root
app.get('/v1', (req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'Red AI API',
    version: '1.0.0'
  });
});

// Start server
const PORT = process.env.PORT || 3000;

initRed().then(async () => {
  if (THINK_MODE) {
    // Think mode: Run autonomous thinking loop without HTTP server
    console.log('🧠 Red AI starting in THINK mode...');
    console.log('🔄 Running autonomous thinking loop');
    console.log('   Press Ctrl+C to stop\n');
    
    // Run the think loop
    await red.think();
    
  } else {
    // Normal API server mode
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
  }
}).catch(error => {
  console.error('Failed to initialize Red AI:', error);
  process.exit(1);
});
