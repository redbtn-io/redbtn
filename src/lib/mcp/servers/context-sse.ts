/**
 * Context MCP Server - SSE Transport (Simplified)
 * Manages conversation context, history, and message storage
 * This is a simplified wrapper around the existing MemoryManager
 */

import { McpServerSSE } from '../server-sse';
import { CallToolResult } from '../types';
import { MemoryManager } from '../../memory/memory';

export class ContextServerSSE extends McpServerSSE {
  private memoryManager: MemoryManager;
  
  constructor(name: string, version: string, port: number = 3004, redisUrl?: string) {
    super(name, version, port, '/mcp');
    this.memoryManager = new MemoryManager(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    console.log('[Context Server] Initialized with Redis memory manager');
  }

  /**
   * Setup tools (simplified - just the essential ones)
   */
  protected async setup(): Promise<void> {
    // Store message tool
    this.defineTool({
      name: 'store_message',
      description: 'Store a message in conversation history',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          role: { type: 'string', enum: ['user', 'assistant', 'system'] },
          content: { type: 'string' },
          messageId: { type: 'string' },
          timestamp: { type: 'number' }
        },
        required: ['conversationId', 'role', 'content']
      }
    });

    // Get context history tool
    this.defineTool({
      name: 'get_context_history',
      description: 'Get formatted conversation context for LLM',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          maxTokens: { type: 'number', default: 30000 }
        },
        required: ['conversationId']
      }
    });

    // Get summary tool
    this.defineTool({
      name: 'get_summary',
      description: 'Get conversation summary if available',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' }
        },
        required: ['conversationId']
      }
    });

    // Get messages tool
    this.defineTool({
      name: 'get_messages',
      description: 'Fetch messages from a conversation',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          limit: { type: 'number', default: 100 }
        },
        required: ['conversationId']
      }
    });

    // Get conversation metadata tool
    this.defineTool({
      name: 'get_conversation_metadata',
      description: 'Get metadata about a conversation',
      inputSchema: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' }
        },
        required: ['conversationId']
      }
    });

    this.capabilities = {
      tools: { listChanged: false }
    };
  }

  /**
   * Execute tool
   */
  protected async executeTool(
    name: string,
    args: Record<string, unknown>,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ): Promise<CallToolResult> {
    try {
      switch (name) {
        case 'store_message':
          await this.memoryManager.addMessage(
            args.conversationId as string,
            {
              id: args.messageId as string || `msg_${Date.now()}`,
              role: args.role as 'user' | 'assistant' | 'system',
              content: args.content as string,
              timestamp: args.timestamp as number || Date.now(),
              toolExecutions: args.toolExecutions as any[] || []
            }
          );
          return {
            content: [{ type: 'text', text: JSON.stringify({ success: true }) }]
          };

        case 'get_context_history':
          const context = await this.memoryManager.getContextForConversation(args.conversationId as string);
          return {
            content: [{ type: 'text', text: JSON.stringify(context) }]
          };

        case 'get_summary':
          const summary = await this.memoryManager.getContextSummary(args.conversationId as string);
          return {
            content: [{ type: 'text', text: JSON.stringify({ summary: summary || null }) }]
          };

        case 'get_messages':
          const messages = await this.memoryManager.getMessages(args.conversationId as string);
          return {
            content: [{ type: 'text', text: JSON.stringify(messages) }]
          };

        case 'get_conversation_metadata':
          const metadata = await this.memoryManager.getMetadata(args.conversationId as string);
          return {
            content: [{ type: 'text', text: JSON.stringify(metadata || {}) }]
          };

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
        }],
        isError: true
      };
    }
  }
}
