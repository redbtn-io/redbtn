/**
 * Graph Execution
 *
 * Clean execution engine focused purely on graph execution.
 * No message storage, no conversation management - those are caller responsibilities.
 *
 * Features:
 * - Uses RunPublisher for unified event publishing
 * - Acquires distributed lock per user+graph
 * - Returns RunResult with clean separation of content/thinking/data
 * - Callers (Chat API, Automation API) handle their own storage
 *
 * @module functions/run
 */
import type { Red } from '../index';
import { RunPublisher, type RunState } from '../lib/run';
import { type UserConnection, type ConnectionProvider } from '../lib/connections';
export { RunPublisher, type RunState };
/**
 * Connection fetcher callbacks for runtime credential access
 */
export interface ConnectionFetcher {
    fetchConnection: (connectionId: string) => Promise<{
        connection: UserConnection;
        provider: ConnectionProvider;
    } | null>;
    fetchDefaultConnection: (providerId: string) => Promise<{
        connection: UserConnection;
        provider: ConnectionProvider;
    } | null>;
    refreshConnection?: (connectionId: string) => Promise<UserConnection | null>;
}
export interface RunOptions {
    userId: string;
    graphId?: string;
    conversationId?: string;
    runId?: string;
    stream?: boolean;
    source?: {
        device?: 'phone' | 'speaker' | 'web';
        application?: string;
    };
    connectionFetcher?: ConnectionFetcher;
}
export interface RunResult {
    runId: string;
    graphId: string;
    graphName: string;
    status: 'completed' | 'error';
    content: string;
    thinking: string;
    data: Record<string, unknown>;
    error?: string;
    metadata: {
        startedAt: number;
        completedAt: number;
        duration: number;
        nodesExecuted: number;
        executionPath: string[];
        model?: string;
        tokens?: {
            input?: number;
            output?: number;
            total?: number;
        };
    };
    graphTrace: {
        executionPath: string[];
        nodeProgress: Record<string, {
            status: string;
            nodeName: string;
            nodeType: string;
            startedAt?: number;
            completedAt?: number;
            error?: string;
        }>;
        startTime?: number;
        endTime?: number;
    };
    tools: unknown[];
}
export interface StreamingRunResult {
    runId: string;
    publisher: RunPublisher;
    completion: Promise<RunResult>;
}
export declare function run(red: Red, input: Record<string, unknown>, options: RunOptions): Promise<RunResult | StreamingRunResult>;
export declare function isStreamingResult(result: RunResult | StreamingRunResult): result is StreamingRunResult;
