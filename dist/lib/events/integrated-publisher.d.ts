/**
 * Integrated Tool Event Publisher
 *
 * Bridges tools with MessageQueue.publishToolEvent()
 */
import { MessageQueue } from '../memory/queue';
export declare class IntegratedToolPublisher {
    private messageQueue;
    private toolId;
    private toolType;
    private toolName;
    private messageId;
    private conversationId;
    private startTime;
    constructor(messageQueue: MessageQueue, toolType: string, toolName: string, messageId: string, conversationId: string);
    publishStart(options?: {
        input?: any;
        expectedDuration?: number;
    }): Promise<void>;
    publishProgress(message: string, options?: {
        progress?: number;
        data?: any;
    }): Promise<void>;
    publishComplete(result?: any, metadata?: any): Promise<void>;
    publishError(error: string, errorCode?: string): Promise<void>;
}
export declare function createIntegratedPublisher(messageQueue: MessageQueue, toolType: string, toolName: string, messageId: string, conversationId: string): IntegratedToolPublisher;
