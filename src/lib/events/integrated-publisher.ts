/**
 * Integrated Tool Event Publisher
 * 
 * Bridges tools with MessageQueue.publishToolEvent() 
 */

import { MessageQueue } from '../memory/queue';

export class IntegratedToolPublisher {
  private messageQueue: MessageQueue;
  private toolId: string;
  private toolType: string;
  private toolName: string;
  private messageId: string;
  private conversationId: string;
  private startTime: number;

  constructor(
    messageQueue: MessageQueue,
    toolType: string,
    toolName: string,
    messageId: string,
    conversationId: string
  ) {
    this.messageQueue = messageQueue;
    this.toolType = toolType;
    this.toolName = toolName;
    this.messageId = messageId;
    this.conversationId = conversationId;
    this.toolId = `${toolType}_${Date.now()}`;
    this.startTime = Date.now();
  }

  async publishStart(options?: { input?: any; expectedDuration?: number }): Promise<void> {
    const event = {
      type: 'tool_start',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      metadata: options || {},
    };
    await this.messageQueue.publishToolEvent(this.messageId, event);
  }

  async publishProgress(message: string, options?: { progress?: number; data?: any }): Promise<void> {
    const event = {
      type: 'tool_progress',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      step: message,
      progress: options?.progress || 0,
      data: options?.data,
    };
    await this.messageQueue.publishToolEvent(this.messageId, event);
  }

  async publishComplete(result?: any, metadata?: any): Promise<void> {
    const event = {
      type: 'tool_complete',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      result,
      metadata,
    };
    await this.messageQueue.publishToolEvent(this.messageId, event);
  }

  async publishError(error: string, errorCode?: string): Promise<void> {
    const event = {
      type: 'tool_error',
      toolId: this.toolId,
      toolType: this.toolType,
      toolName: this.toolName,
      timestamp: Date.now(),
      error,
      errorCode,
    };
    await this.messageQueue.publishToolEvent(this.messageId, event);
  }
}

export function createIntegratedPublisher(
  messageQueue: MessageQueue,
  toolType: string,
  toolName: string,
  messageId: string,
  conversationId: string
): IntegratedToolPublisher {
  return new IntegratedToolPublisher(messageQueue, toolType, toolName, messageId, conversationId);
}
