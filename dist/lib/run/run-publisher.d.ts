/**
 * RunPublisher
 *
 * Unified publisher for run state and events. Replaces the fragmented
 * MessageQueue + GraphEventPublisher + McpEventPublisher system.
 *
 * Key responsibilities:
 * - Maintain run state in Redis (run:{runId})
 * - Publish events to pub/sub channel (run:stream:{runId})
 * - Handle client ready signaling for streaming
 * - Provide state access and subscription methods
 *
 * @module lib/run/run-publisher
 */
import type { Redis } from 'ioredis';
import { type RunState, type RunEvent, type RunOutput, type TokenMetadata } from './types';
import type { RedLog } from '@redbtn/redlog';
/**
 * Options for RunPublisher constructor
 */
export interface RunPublisherOptions {
    /** Redis client instance */
    redis: Redis;
    /** Unique run identifier */
    runId: string;
    /** User executing the run */
    userId: string;
    /** TTL for run state in seconds (default: 1 hour) */
    stateTtl?: number;
    /** RedLog instance for structured logging */
    log?: RedLog;
}
/**
 * Subscription result
 */
export interface RunSubscription {
    /** Async generator yielding events */
    stream: AsyncGenerator<RunEvent, void, unknown>;
    /** Promise that resolves when subscription is ready */
    ready: Promise<void>;
    /** Cleanup function to unsubscribe */
    unsubscribe: () => Promise<void>;
}
/**
 * RunPublisher - Unified run state and event publisher
 */
export declare class RunPublisher {
    private readonly redis;
    private readonly runId;
    private readonly userId;
    private readonly stateTtl;
    private readonly redlog?;
    private state;
    private initialized;
    /** ConversationPublisher for forwarding events to the chat UI */
    private convPublisher;
    /** Message ID used for conversation stream (stable across run lifetime) */
    private convMessageId;
    constructor(options: RunPublisherOptions);
    get id(): string;
    get user(): string;
    private persistLog;
    init(graphId: string, graphName: string, input: Record<string, unknown>, conversationId?: string): Promise<void>;
    complete(output?: Partial<RunOutput>): Promise<void>;
    fail(error: string): Promise<void>;
    status(action: string, description?: string): Promise<void>;
    graphStart(nodeCount: number, entryNodeId: string): Promise<void>;
    graphComplete(exitNodeId?: string, nodesExecuted?: number): Promise<void>;
    graphError(error: string, failedNodeId?: string): Promise<void>;
    nodeStart(nodeId: string, nodeType: string, nodeName: string): Promise<void>;
    nodeProgress(nodeId: string, step: string, options?: {
        index?: number;
        total?: number;
        data?: Record<string, unknown>;
    }): Promise<void>;
    nodeComplete(nodeId: string, nextNodeId?: string, output?: Record<string, unknown>): Promise<void>;
    nodeError(nodeId: string, error: string): Promise<void>;
    chunk(content: string): Promise<void>;
    thinkingChunk(content: string): Promise<void>;
    thinkingComplete(): Promise<void>;
    publishAudioChunk(audioBase64: string, index: number, isFinal: boolean): Promise<void>;
    toolStart(toolId: string, toolName: string, toolType: string, options?: {
        input?: unknown;
    }): Promise<void>;
    toolProgress(toolId: string, step: string, options?: {
        progress?: number;
        data?: Record<string, unknown>;
    }): Promise<void>;
    toolComplete(toolId: string, result?: unknown, metadata?: Record<string, unknown>): Promise<void>;
    toolError(toolId: string, error: string): Promise<void>;
    setMetadata(metadata: TokenMetadata): Promise<void>;
    getState(): Promise<RunState | null>;
    getCachedState(): RunState | null;
    subscribe(): RunSubscription;
    getInitEvent(): Promise<RunEvent | null>;
    private ensureInitialized;
    private saveState;
    publish(event: RunEvent): Promise<void>;
    getEvents(): Promise<RunEvent[]>;
    getEventsSince(startIndex: number): Promise<RunEvent[]>;
    getEventCount(): Promise<number>;
    private findTool;
}
export declare function createRunPublisher(options: RunPublisherOptions): RunPublisher;
export declare function getActiveRunForConversation(redis: Redis, conversationId: string): Promise<string | null>;
export declare function getRunState(redis: Redis, runId: string): Promise<RunState | null>;
