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

if (process.env.BEARER_TOKEN) {
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

app.use(express.json());

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
  redisUrl: process.env.REDIS_URL || "http://localhost:6379",
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

// Generate or extract conversation ID
// OpenWebUI doesn't send a conversation ID, so we use the completion ID from their first message
// or check for a custom header
function getConversationId(req: Request, completionId: string): string {
  // Check for custom header first (if OpenWebUI or other clients send it)
  const headerConvId = req.headers['x-conversation-id'] as string;
  if (headerConvId) {
    return headerConvId;
  }
  
  // For OpenWebUI: they send full message history, so hash the first few messages
  // to create a stable conversation ID
  const body: ChatCompletionRequest = req.body;
  if (body.messages && body.messages.length > 0) {
    // Create a stable ID based on the first message(s)
    const firstMessages = body.messages.slice(0, 2).map(m => m.content).join('|');
    const hash = crypto.createHash('sha256').update(firstMessages).digest('hex').substring(0, 16);
    return `conv_${hash}`;
  }
  
  // Fallback: use completion ID (new conversation each time)
  return completionId;
}

// Background summarization function
async function summarizeConversationInBackground(conversationId: string) {
  try {
    const needsSummary = await red.memory.needsSummarization(conversationId);
    
    if (!needsSummary) {
      return;
    }
    
    const messages = await red.memory.getMessages(conversationId);
    const metadata = await red.memory.getMetadata(conversationId);
    const tokenCount = await red.memory.getTokenCount(conversationId);
    
    console.log(`[Summarization] Triggered for ${conversationId}: ${messages.length} messages, ${tokenCount} tokens`);
    
    // Determine which messages to summarize
    const lastSummarizedIndex = metadata?.summaryUpToMessage || 0;
    const messagesToSummarize = messages.slice(lastSummarizedIndex, -10); // All but last 10
    
    if (messagesToSummarize.length < 5) {
      return; // Not enough to summarize
    }
    
    // Create summary prompt
    const conversationText = messagesToSummarize
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\\n');
    
    const summaryPrompt = `Summarize the following conversation in 3-4 concise sentences. Focus on key topics, decisions, and important context:\\n\\n${conversationText}`;
    
    // Generate summary using the LLM
    const summaryResponse = await red.localModel.invoke([
      { role: 'user', content: summaryPrompt }
    ]);
    
    const summary = summaryResponse.content as string;
    
    // Store the summary
    await red.memory.setSummary(conversationId, summary, lastSummarizedIndex + messagesToSummarize.length);
    
    console.log(`[Summarization] Complete for ${conversationId}: ${messagesToSummarize.length} messages summarized`);
    
  } catch (error) {
    console.error('Background summarization error:', error);
  }
}

// Extract the last user message from the conversation
function extractUserMessage(messages: ChatCompletionRequest['messages']): string {
  // Get the last user message
  const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
  return lastUserMessage?.content || '';
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
    
    // Get or create conversation ID
    const conversationId = getConversationId(req, completionId);
    
    // Store user message in memory
    await red.memory.addMessage(conversationId, {
      role: 'user',
      content: userMessage,
      timestamp: Date.now()
    });

    // Streaming mode
    if (body.stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
      res.flushHeaders(); // Flush headers immediately

      const stream = await red.respond(
        { message: userMessage },
        { source: { application: 'redChat' }, stream: true, conversationId }
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
      for await (const chunk of stream) {
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
      
      // Store assistant response in memory (after streaming completes)
      await red.memory.addMessage(conversationId, {
        role: 'assistant',
        content: fullResponse,
        timestamp: Date.now()
      });
      
      // Trigger background summarization (non-blocking)
      summarizeConversationInBackground(conversationId).catch(err => 
        console.error('Summarization failed:', err)
      );
    } else {
      // Non-streaming mode
      const response = await red.respond(
        { message: userMessage },
        { source: { application: 'redChat' }, conversationId }
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
      
      // Store assistant response in memory
      await red.memory.addMessage(conversationId, {
        role: 'assistant',
        content: typeof response.content === 'string' ? response.content : JSON.stringify(response.content),
        timestamp: Date.now()
      });
      
      // Trigger background summarization (non-blocking)
      summarizeConversationInBackground(conversationId).catch(err => 
        console.error('Summarization failed:', err)
      );
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
