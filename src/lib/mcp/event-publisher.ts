/**
 * MCP Tool Event Publisher
 * 
 * Publishes tool events and logs from MCP servers to Redis
 * so they appear in the UI and logs API
 */

import { Redis } from 'ioredis';

export class McpEventPublisher {
  private redis: Redis;
  private toolId: string;
  private toolType: string;
  private toolName: string;
  private messageId?: string;
  private conversationId?: string;
  private generationId?: string;
  private startTime: number;

  constructor(
    redis: Redis,
    toolType: string,
    toolName: string,
    meta?: { conversationId?: string; generationId?: string; messageId?: string }
  ) {
    this.redis = redis;
    this.toolType = toolType;
    this.toolName = toolName;
    this.messageId = meta?.messageId;
    this.conversationId = meta?.conversationId;
    this.generationId = meta?.generationId;
    this.toolId = `${toolType}_${Date.now()}`;
    this.startTime = Date.now();
  }

  /**
   * Publish tool start event
   */
  async publishStart(options?: { input?: any; expectedDuration?: number }): Promise<void> {
    if (!this.messageId) return; // Skip if no messageId

    const event = {
      type: 'tool_start',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      metadata: options || {},
    };
    
    await this.redis.publish(
      `tool:event:${this.messageId}`,
      JSON.stringify(event)
    );
  }

  /**
   * Publish tool progress event
   */
  async publishProgress(message: string, options?: { progress?: number; data?: any; streamingContent?: string }): Promise<void> {
    if (!this.messageId) return; // Skip if no messageId

    const event = {
      type: 'tool_progress',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      step: message,
      progress: options?.progress || 0,
      data: options?.data,
      streamingContent: options?.streamingContent,
    };
    
    await this.redis.publish(
      `tool:event:${this.messageId}`,
      JSON.stringify(event)
    );
  }

  /**
   * Publish tool complete event
   */
  async publishComplete(result?: any, metadata?: any): Promise<void> {
    if (!this.messageId) return; // Skip if no messageId

    const event = {
      type: 'tool_complete',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      result,
      metadata,
    };
    
    await this.redis.publish(
      `tool:event:${this.messageId}`,
      JSON.stringify(event)
    );
  }

  /**
   * Publish tool error event
   */
  async publishError(error: string | Error | { error: string; errorCode?: string }): Promise<void> {
    if (!this.messageId) return; // Skip if no messageId

    // Convert error to string if it's an Error object or has an error property
    let errorMessage: string;
    let errorCode: string | undefined;
    
    if (typeof error === 'string') {
      errorMessage = error;
    } else if (error instanceof Error) {
      errorMessage = error.message;
      errorCode = error.name;
    } else if (typeof error === 'object' && 'error' in error) {
      errorMessage = error.error;
      errorCode = error.errorCode;
    } else {
      // Fallback for unknown object types
      errorMessage = JSON.stringify(error);
    }

    const event = {
      type: 'tool_error',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      error: errorMessage,
      errorCode,
    };
    
    await this.redis.publish(
      `tool:event:${this.messageId}`,
      JSON.stringify(event)
    );
  }

  /**
   * Publish log entry
   */
  async publishLog(level: 'info' | 'success' | 'warn' | 'error', message: string, metadata?: any): Promise<void> {
    if (!this.conversationId) return; // Skip if no conversationId

    const logEntry = {
      level,
      category: 'mcp',
      message,
      conversationId: this.conversationId,
      generationId: this.generationId,
      timestamp: Date.now(),
      metadata: {
        ...metadata,
        toolName: this.toolName,
        toolType: this.toolType,
        protocol: 'MCP/JSON-RPC 2.0',
      },
    };

    // Publish to log channel for persistent logger to pick up
    await this.redis.publish(
      'log:entry',
      JSON.stringify(logEntry)
    );
  }

  /**
   * Get elapsed time since tool start
   */
  getDuration(): number {
    return Date.now() - this.startTime;
  }
}
