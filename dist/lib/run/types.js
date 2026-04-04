"use strict";
/**
 * Run System Types
 *
 * Unified types for the run execution system. These types define the state schema
 * stored in Redis and the event protocol for pub/sub streaming.
 *
 * @module lib/run/types
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RunConfig = exports.RunKeys = void 0;
exports.createInitialRunState = createInitialRunState;
exports.createNodeProgress = createNodeProgress;
exports.createToolExecution = createToolExecution;
// =============================================================================
// Redis Key Patterns
// =============================================================================
/**
 * Redis key patterns for the run system
 */
exports.RunKeys = {
    /** Run state: `run:{runId}` */
    state: (runId) => `run:${runId}`,
    /** Pub/sub channel: `run:stream:{runId}` */
    stream: (runId) => `run:stream:${runId}`,
    /** Event log list: `run:events:{runId}` - stores all events for replay */
    events: (runId) => `run:events:${runId}`,
    /**
     * Execution lock: `run:lock:{conversationId}`
     * Prevents multiple runs in the same conversation.
     * Same graph can run in different conversations simultaneously.
     */
    lock: (conversationId) => `run:lock:${conversationId}`,
    /** Active runs for user: `run:user:{userId}` */
    userRuns: (userId) => `run:user:${userId}`,
    /** Active run for conversation: `run:conversation:{conversationId}` */
    conversationRun: (conversationId) => `run:conversation:${conversationId}`,
};
// =============================================================================
// Configuration
// =============================================================================
/**
 * Default configuration values
 */
exports.RunConfig = {
    /** Default TTL for run state in Redis (1 hour) */
    STATE_TTL_SECONDS: 60 * 60,
    /** Default timeout waiting for client ready signal (30 seconds) */
    READY_TIMEOUT_MS: 30000,
    /** Default lock TTL (5 minutes) - prevents zombie locks */
    LOCK_TTL_SECONDS: 60 * 5,
    /** Lock renewal interval (every 30 seconds while running) */
    LOCK_RENEWAL_INTERVAL_MS: 30000,
};
// =============================================================================
// Factory Functions
// =============================================================================
/**
 * Create an initial RunState
 */
function createInitialRunState(params) {
    return {
        runId: params.runId,
        userId: params.userId,
        graphId: params.graphId,
        graphName: params.graphName,
        conversationId: params.conversationId,
        status: 'pending',
        startedAt: Date.now(),
        input: params.input,
        output: {
            content: '',
            thinking: '',
            data: {},
        },
        graph: {
            executionPath: [],
            nodesExecuted: 0,
            nodeProgress: {},
        },
        tools: [],
    };
}
/**
 * Create an initial NodeProgress entry
 */
function createNodeProgress(params) {
    return {
        status: 'pending',
        nodeName: params.nodeName,
        nodeType: params.nodeType,
        steps: [],
    };
}
/**
 * Create an initial ToolExecution entry
 */
function createToolExecution(params) {
    return {
        toolId: params.toolId,
        toolName: params.toolName,
        toolType: params.toolType,
        status: 'running',
        startedAt: Date.now(),
        steps: [],
    };
}
