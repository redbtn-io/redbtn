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
import { RunPublisher, RunLock, createRunPublisher, publishRunError, type RunState } from '../lib/run';
import { ConnectionManager, type UserConnection, type ConnectionProvider } from '../lib/connections';
import { createMongoCheckpointer } from '../lib/graphs/MongoCheckpointer';
import { SYSTEM_TEMPLATES } from '../lib/types/graph';

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
  threadId?: string;
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

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_GRAPH_ID = SYSTEM_TEMPLATES.DEFAULT;

function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

async function loadUserSettings(userId: string) {
  const defaults = {
    accountTier: 4,
    defaultNeuronId: 'red-neuron',
    defaultWorkerNeuronId: 'red-neuron',
    defaultGraphId: DEFAULT_GRAPH_ID,
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    let User: any;
    if (mongoose.models['User']) {
      User = mongoose.models['User'];
    } else {
      const userSchema = new mongoose.Schema({}, { collection: 'users', strict: false });
      User = mongoose.model('User', userSchema);
    }
    const user = await User.findById(userId).lean();
    if (user) {
      return {
        accountTier: user.accountLevel ?? defaults.accountTier,
        defaultNeuronId: user.defaultNeuronId || defaults.defaultNeuronId,
        defaultWorkerNeuronId: user.defaultWorkerNeuronId || defaults.defaultWorkerNeuronId,
        defaultGraphId: user.defaultGraphId || defaults.defaultGraphId,
      };
    }
    console.warn(`[run] User ${userId} not found, using defaults`);
    return defaults;
  } catch (error) {
    console.error('[run] Error loading user settings:', error);
    return defaults;
  }
}

async function loadGraph(red: Red, graphId: string, userId: string): Promise<{
  compiledGraph: any;
  graphId: string;
  graphName: string;
}> {
  try {
    const compiledGraph = await red.graphRegistry.getGraph(graphId, userId);
    return {
      compiledGraph,
      graphId,
      graphName: compiledGraph.config?.name || graphId,
    };
  } catch (error: any) {
    const isRecoverable =
      error.name === 'GraphAccessDeniedError' ||
      error.name === 'GraphNotFoundError' ||
      error.message?.includes('requires tier') ||
      error.message?.includes('not found');
    if (isRecoverable && graphId !== DEFAULT_GRAPH_ID) {
      console.warn(`[run] Graph ${graphId} not accessible, falling back to ${DEFAULT_GRAPH_ID}`);
      return loadGraph(red, DEFAULT_GRAPH_ID, userId);
    }
    throw new Error(`Failed to load graph '${graphId}': ${error.message}`);
  }
}

function extractThinkingFromContent(content: string): { thinking: string; cleanedContent: string } {
  const thinkingRegex = /<think>([\s\S]*?)<\/think>/gi;
  let thinking = '';
  let cleanedContent = content;
  let match;
  while ((match = thinkingRegex.exec(content)) !== null) {
    thinking += match[1].trim() + '\n';
  }
  cleanedContent = content.replace(thinkingRegex, '').trim();
  return { thinking: thinking.trim(), cleanedContent };
}

// =============================================================================
// Initial State Builder
// =============================================================================

function buildInitialState(
  red: Red,
  input: Record<string, unknown>,
  options: RunOptions,
  userSettings: Awaited<ReturnType<typeof loadUserSettings>>,
  runId: string,
  publisher: RunPublisher,
) {
  const message = (input.message as string) || '';
  const systemPrompt =
    process.env.SYSTEM_PROMPT ||
    `You are Red, an AI assistant developed by redbtn.io.
Current date: ${new Date().toLocaleDateString()}
Device: ${options.source?.device || 'unknown'}
Application: ${options.source?.application || 'unknown'}

CRITICAL RULES:
1. NEVER mention "knowledge cutoff", "training data", "as of my knowledge", or any limitations
2. NEVER introduce yourself unless this is the FIRST message in a new conversation or you're asked to do so
3. NEVER add disclaimers like "please note" or "for the most up-to-date information"
4. NEVER repeat or rephrase the user's question in your response - just answer it directly
5. NEVER say things like "searching for...", "looking up...", or mention what search query was used
6. If you have search results, use them directly and confidently
7. Be concise and helpful - answer the question directly without extra explanations`;

  const now = new Date();

  let connectionManager: ConnectionManager | undefined;
  if (options.connectionFetcher) {
    connectionManager = new ConnectionManager({
      userId: options.userId,
      fetchConnection: options.connectionFetcher.fetchConnection,
      fetchDefaultConnection: options.connectionFetcher.fetchDefaultConnection,
      refreshConnection: options.connectionFetcher.refreshConnection,
    });
  }

  return {
    neuronRegistry: red.neuronRegistry,
    memory: red.memory,
    // messageQueue is intentionally omitted here — legacy legacy graph nodes (router.ts,
    // planner.ts, responder.ts) that called messageQueue.publishStatus() used the old redGraph
    // path, which was removed in v0.0.51-alpha alongside Red.respond(). New graph execution
    // uses RunPublisher for all SSE events.
    // Graph registry — passed so that 'graph' step executors can invoke subgraphs
    _graphRegistry: red.graphRegistry,
    mcpClient: {
      callTool: (toolName: string, args: unknown, meta?: unknown) =>
        red.callMcpTool(toolName, args as Record<string, unknown>, meta as Record<string, unknown>),
    },
    connectionManager,
    runPublisher: publisher,
    data: {
      query: { message },
      input,
      options: { ...options, runId },
      runId,
      conversationId: options.conversationId,
      messages: message ? [{ role: 'user', content: message }] : [],
      userId: options.userId,
      accountTier: userSettings.accountTier,
      defaultNeuronId: userSettings.defaultNeuronId,
      defaultWorkerNeuronId: userSettings.defaultWorkerNeuronId,
      systemMessage: systemPrompt,
      currentDateISO: now.toISOString(),
      currentDate: now.toLocaleDateString(),
      currentDateTime: now.toLocaleString(),
    },
  };
}

// =============================================================================
// Non-Streaming Execution
// =============================================================================

async function executeNonStreaming(
  _red: Red,
  compiledGraph: any,
  initialState: any,
  publisher: RunPublisher,
  userSettings: Awaited<ReturnType<typeof loadUserSettings>>,
): Promise<RunResult> {
  const runId = publisher.id;
  try {
    const conversationId = initialState.data.conversationId;
    const threadId = initialState.data.options.threadId || runId;
    const invokeConfig = { 
      configurable: { 
        conversation_id: conversationId,
        thread_id: threadId 
      } 
    };
    const result = await compiledGraph.graph.invoke(initialState, invokeConfig);
    const rawResponse = result.data?.response || result.response;
    const responseContent =
      rawResponse === undefined
        ? ''
        : typeof rawResponse === 'string'
        ? rawResponse
        : rawResponse?.content || '';
    const { thinking, cleanedContent } = extractThinkingFromContent(responseContent);
    // Pass the FULL final graph state as the second arg so the run_complete
    // event's `output` carries every state-root field (not just the
    // content/thinking/data quadrant). Canonical aliases are still layered
    // on top by RunPublisher for backwards compatibility.
    await publisher.complete(
      { content: cleanedContent, thinking, data: result.data || {} },
      result as Record<string, unknown>,
    );
    const state = await publisher.getState();
    return {
      runId,
      graphId: state?.graphId || '',
      graphName: state?.graphName || '',
      status: 'completed',
      content: cleanedContent,
      thinking,
      data: result.data || {},
      metadata: {
        startedAt: state?.startedAt || Date.now(),
        completedAt: state?.completedAt || Date.now(),
        duration: state?.completedAt ? state.completedAt - state.startedAt : 0,
        nodesExecuted: state?.graph.nodesExecuted || 0,
        executionPath: state?.graph.executionPath || [],
        model: userSettings.defaultNeuronId,
        tokens: state?.metadata?.tokens,
      },
      graphTrace: {
        executionPath: state?.graph.executionPath || [],
        nodeProgress: Object.fromEntries(
          Object.entries(state?.graph.nodeProgress || {}).map(([nodeId, progress]: [string, any]) => [
            nodeId,
            { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
          ])
        ),
        startTime: state?.startedAt,
        endTime: state?.completedAt,
      },
      tools: state?.tools || [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    try {
      await publisher.fail(errorMessage, errorStack);
    } catch (publishErr) {
      // If even publisher.fail() fails (e.g., Redis disconnected mid-run),
      // fall back to the raw helper so subscribers still see a terminal
      // event and don't hang on the 60s timeout.
      console.error('[run:executeNonStreaming] publisher.fail() failed, falling back:', publishErr);
      try {
        await publishRunError(
          (publisher as any).redis,
          publisher.id,
          errorMessage,
          { errorStack, userId: publisher.user },
        );
      } catch { /* give up — we tried */ }
    }
    const state = await publisher.getState();
    return {
      runId,
      graphId: state?.graphId || '',
      graphName: state?.graphName || '',
      status: 'error',
      content: '',
      thinking: '',
      data: {},
      error: errorMessage,
      metadata: {
        startedAt: state?.startedAt || Date.now(),
        completedAt: Date.now(),
        duration: state?.startedAt ? Date.now() - state.startedAt : 0,
        nodesExecuted: state?.graph.nodesExecuted || 0,
        executionPath: state?.graph.executionPath || [],
      },
      graphTrace: {
        executionPath: state?.graph.executionPath || [],
        nodeProgress: Object.fromEntries(
          Object.entries(state?.graph.nodeProgress || {}).map(([nodeId, progress]: [string, any]) => [
            nodeId,
            { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
          ])
        ),
        startTime: state?.startedAt,
        endTime: Date.now(),
      },
      tools: state?.tools || [],
    };
  }
}

// =============================================================================
// Streaming Execution
// =============================================================================

async function executeStreaming(
  _red: Red,
  compiledGraph: any,
  initialState: any,
  publisher: RunPublisher,
  userSettings: Awaited<ReturnType<typeof loadUserSettings>>,
): Promise<RunResult> {
  const runId = publisher.id;
  let fullContent = '';
  let thinkingBuffer = '';
  let inThinkingTag = false;
  let pendingBuffer = '';
  let graphOutputData: Record<string, unknown> | null = null;
  // Full final graph state (state-root object, not just .data). Captured at
  // LangGraph on_chain_end so we can pass it to publisher.complete() and thus
  // into the run_complete event's `output` field. This is what enables graphs
  // to return arbitrary state-root fields (e.g. `systemPrompt`, `setupOutput`).
  let graphFinalState: Record<string, unknown> | null = null;
  try {
    const conversationId = initialState.data.conversationId;
    const threadId = initialState.data.options.threadId || runId;
    const streamConfig = { 
      version: 'v1' as const, 
      configurable: { 
        conversation_id: conversationId,
        thread_id: threadId 
      } 
    };
    const stream = compiledGraph.graph.streamEvents(initialState, streamConfig);
    for await (const event of stream) {
      const runName = event.metadata?.langgraph_node || '';
      const isRespondNode = runName === 'respond' || runName === 'responder';
      if (event.event === 'on_llm_stream' && event.data?.chunk?.content && isRespondNode) {
        const content = event.data.chunk.content;
        pendingBuffer += content;
        while (pendingBuffer.length > 8) {
          if (!inThinkingTag && pendingBuffer.startsWith('<think>')) {
            inThinkingTag = true;
            pendingBuffer = pendingBuffer.slice(7);
            continue;
          }
          if (inThinkingTag && pendingBuffer.startsWith('</think>')) {
            inThinkingTag = false;
            pendingBuffer = pendingBuffer.slice(8);
            await publisher.thinkingComplete();
            continue;
          }
          const char = pendingBuffer[0];
          pendingBuffer = pendingBuffer.slice(1);
          if (inThinkingTag) {
            thinkingBuffer += char;
            await publisher.thinkingChunk(char);
          } else {
            fullContent += char;
            await publisher.chunk(char);
          }
        }
      }
      if (event.event === 'on_chain_end' && event.name === 'LangGraph') {
        const graphOutput = event.data?.output;
        // Capture graph output data for the final result
        if (graphOutput?.data) {
          graphOutputData = graphOutput.data;
        }
        // Capture the FULL final state object so publisher.complete() can emit
        // every state-root field in the run_complete event. Non-serialisable
        // service objects are stripped by RunPublisher before publish.
        if (graphOutput && typeof graphOutput === 'object') {
          graphFinalState = graphOutput as Record<string, unknown>;
        }

        // Try multiple response content locations used by different graph types:
        // - data.response (standard graphs with responder node)
        // - data.response.content (wrapped response object)
        // - data.finding.naturalResponse (claude-assistant workflow graphs)
        const responseContent =
          graphOutput?.data?.response?.content ||
          graphOutput?.data?.response ||
          graphOutput?.data?.finding?.naturalResponse;

        // Also check if content was already streamed by the tool parser (via runPublisher.chunk)
        const alreadyStreamed = publisher.getCachedState()?.output?.content;
        if (responseContent && typeof responseContent === 'string' && !fullContent && !alreadyStreamed) {
          const { thinking, cleanedContent } = extractThinkingFromContent(responseContent);
          if (thinking) {
            thinkingBuffer = thinking;
            for (const char of thinking) await publisher.thinkingChunk(char);
            await publisher.thinkingComplete();
          }
          fullContent = cleanedContent;
          for (const char of cleanedContent) await publisher.chunk(char);
        }
      }
    }
    while (pendingBuffer.length > 0) {
      const char = pendingBuffer[0];
      pendingBuffer = pendingBuffer.slice(1);
      if (inThinkingTag) {
        thinkingBuffer += char;
        await publisher.thinkingChunk(char);
      } else {
        fullContent += char;
        await publisher.chunk(char);
      }
    }
    // Use tool-parser-streamed content/thinking if local buffers are empty
    const cachedState = publisher.getCachedState();
    const finalContent = fullContent || cachedState?.output?.content || '';
    const finalThinking = thinkingBuffer || cachedState?.output?.thinking || '';
    // Use graph output data if available, fall back to initial state data
    const finalData = graphOutputData || initialState.data || {};
    // Pass the full captured graph state (when available) so the run_complete
    // event's `output` carries every state-root field — not just the legacy
    // content/thinking/data quadrant. Falls back to just the convenience
    // fields when on_chain_end never fired (defensive).
    await publisher.complete(
      { content: finalContent, thinking: finalThinking, data: finalData },
      graphFinalState ?? undefined,
    );
    const state = await publisher.getState();
    return {
      runId,
      graphId: state?.graphId || '',
      graphName: state?.graphName || '',
      status: 'completed',
      content: finalContent,
      thinking: finalThinking,
      data: finalData,
      metadata: {
        startedAt: state?.startedAt || Date.now(),
        completedAt: state?.completedAt || Date.now(),
        duration: state?.completedAt ? state.completedAt - state.startedAt : 0,
        nodesExecuted: state?.graph.nodesExecuted || 0,
        executionPath: state?.graph.executionPath || [],
        model: userSettings.defaultNeuronId,
        tokens: state?.metadata?.tokens,
      },
      graphTrace: {
        executionPath: state?.graph.executionPath || [],
        nodeProgress: Object.fromEntries(
          Object.entries(state?.graph.nodeProgress || {}).map(([nodeId, progress]: [string, any]) => [
            nodeId,
            { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
          ])
        ),
        startTime: state?.startedAt,
        endTime: state?.completedAt,
      },
      tools: state?.tools || [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    try {
      await publisher.fail(errorMessage, errorStack);
    } catch (publishErr) {
      // If publisher.fail() itself fails (Redis hiccup mid-run), fall back
      // to the raw helper so subscribers still see a terminal event.
      console.error('[run:executeStreaming] publisher.fail() failed, falling back:', publishErr);
      try {
        await publishRunError(
          (publisher as any).redis,
          publisher.id,
          errorMessage,
          { errorStack, userId: publisher.user },
        );
      } catch { /* give up — we tried */ }
    }
    const state = await publisher.getState();
    return {
      runId,
      graphId: state?.graphId || '',
      graphName: state?.graphName || '',
      status: 'error',
      content: fullContent,
      thinking: thinkingBuffer,
      data: {},
      error: errorMessage,
      metadata: {
        startedAt: state?.startedAt || Date.now(),
        completedAt: Date.now(),
        duration: state?.startedAt ? Date.now() - state.startedAt : 0,
        nodesExecuted: state?.graph.nodesExecuted || 0,
        executionPath: state?.graph.executionPath || [],
      },
      graphTrace: {
        executionPath: state?.graph.executionPath || [],
        nodeProgress: Object.fromEntries(
          Object.entries(state?.graph.nodeProgress || {}).map(([nodeId, progress]: [string, any]) => [
            nodeId,
            { status: progress.status, nodeName: progress.nodeName, nodeType: progress.nodeType, startedAt: progress.startedAt, completedAt: progress.completedAt, error: progress.error },
          ])
        ),
        startTime: state?.startedAt,
        endTime: Date.now(),
      },
      tools: state?.tools || [],
    };
  }
}

// =============================================================================
// Main Entry Point
// =============================================================================

export async function run(
  red: Red,
  input: Record<string, unknown>,
  options: RunOptions,
): Promise<RunResult | StreamingRunResult> {
  const { userId } = options;
  if (!userId) throw new Error('[run] userId is required');

  const runId = options.runId || generateRunId();
  const stream = options.stream ?? true;

  console.log(`[run] Starting run ${runId} for user ${userId}`);

  // Track RunPublisher readiness so we can publish a fallback terminal
  // `run_error` event if anything throws BEFORE `publisher.init()` succeeds
  // (loadGraph / runLock.acquire / publisher.init itself). Without this,
  // subscribers on the run stream channel (dispatchToolCall, runStartupGraph,
  // _subscribeAndRouteOutput) have no terminal event to latch onto and hang
  // until their 60s timeout.
  const redisForFallback = red.redis;
  const publishFallbackError = async (err: unknown, where: string) => {
    if (!redisForFallback) return;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      await publishRunError(redisForFallback, runId, `[run:${where}] ${message}`, {
        errorStack: stack,
        userId,
        graphId: options.graphId,
        conversationId: options.conversationId,
      });
    } catch (publishErr) {
      console.error(`[run] Fallback publishRunError failed for ${runId}:`, publishErr);
    }
  };

  let userSettings: Awaited<ReturnType<typeof loadUserSettings>>;
  let actualGraphId: string;
  let graphName: string;
  let compiledGraph: any;
  try {
    userSettings = await loadUserSettings(userId);
    const graphId = options.graphId || userSettings.defaultGraphId;
    const loaded = await loadGraph(red, graphId, userId);
    compiledGraph = loaded.compiledGraph;
    actualGraphId = loaded.graphId;
    graphName = loaded.graphName;
    console.log(`[run] Using graph: ${actualGraphId} (${graphName})`);
  } catch (err) {
    await publishFallbackError(err, 'pre-init');
    throw err;
  }

  const redis = red.redis;
  if (!redis) {
    // Can't publish without redis — just throw for the worker's outer catch.
    throw new Error('[run] Redis client not available');
  }

  const lockKey = options.conversationId || runId;
  const agentId = (options as any).agentId as string | undefined;
  const runLock = new RunLock(redis);
  let lock;
  try {
    lock = await runLock.acquire(lockKey, { agentId });
  } catch (err) {
    await publishFallbackError(err, 'lock-acquire');
    throw err;
  }
  if (!lock) {
    const err = new Error(
      `[run] Conversation ${lockKey}${agentId ? `:${agentId}` : ''} already has an active run`,
    );
    await publishFallbackError(err, 'lock-busy');
    throw err;
  }
  console.log(`[run] Acquired lock for conversation ${lockKey}${agentId ? ` agent=${agentId}` : ''}`);

  const publisher = createRunPublisher({ redis, runId, userId, log: red.redlog });

  // W-3: extract triggerType from the already-enriched input so that publisher.init()
  // can guarantee it ends up in this.state.input._trigger even for direct run() callers.
  const triggerType = (input as Record<string, any>)?._trigger?.type as string | undefined;

  console.log(`[run] ${new Date().toISOString()} Calling publisher.init() for run ${runId}`);
  try {
    await publisher.init(actualGraphId, graphName, input, options.conversationId, triggerType);
  } catch (err) {
    // publisher.init() bootstraps Redis state + emits run_start. If it fails,
    // the publisher isn't usable for `fail()` — emit a terminal error via the
    // bare helper and release the lock before rethrowing.
    await publishFallbackError(err, 'publisher-init');
    try { await lock.release(); } catch { /* ignore */ }
    throw err;
  }
  console.log(`[run] ${new Date().toISOString()} publisher.init() complete for run ${runId}`);

  // Check for existing checkpoint (crash recovery)
  try {
    const checkpointer = createMongoCheckpointer();
    const threadIdForRecovery = options.threadId || runId;
    const existingCheckpoint = await checkpointer.getTuple({ 
      configurable: { 
        conversation_id: options.conversationId,
        thread_id: threadIdForRecovery 
      } 
    });
    if (existingCheckpoint) {
      const step = existingCheckpoint.metadata?.step;
      const source = existingCheckpoint.metadata?.source;
      console.log(`[run] Crash recovery: found checkpoint for run ${runId} (step=${step}, source=${source}) — resuming from last completed node`);
      await (publisher as any).publish({
        type: 'run_resuming',
        runId,
        checkpointStep: step,
        checkpointSource: source,
        message: 'Resuming from last checkpoint after crash/retry',
        timestamp: Date.now(),
      });
    }
  } catch (checkpointErr) {
    console.warn('[run] Could not check for existing checkpoint:', checkpointErr);
  }

  let initialState: any;
  try {
    initialState = buildInitialState(red, input, options, userSettings, runId, publisher);

    const nodeCount = compiledGraph.config?.nodes?.length || 0;
    const entryNodeId = compiledGraph.config?.nodes?.[0]?.id || 'entry';
    console.log(`[run] ${new Date().toISOString()} Publishing graph_start for run ${runId}`);
    await publisher.graphStart(nodeCount, entryNodeId);
  } catch (err) {
    // Any failure here (state builder throws, graphStart publish fails) must
    // still emit a terminal error via the initialised publisher — and if that
    // itself fails, fall through to the raw helper as a last resort.
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    try {
      await publisher.fail(`[run:graph-start] ${message}`, stack);
    } catch {
      await publishFallbackError(err, 'graph-start');
    }
    try { await lock.release(); } catch { /* ignore */ }
    throw err;
  }

  const cleanup = async () => {
    await lock.release();
    console.log(`[run] Released lock for conversation ${lockKey}`);
  };

  if (stream) {
    const completion = (async () => {
      try {
        console.log(`[run] ${new Date().toISOString()} Starting execution for run ${runId}`);
        return await executeStreaming(red, compiledGraph, initialState, publisher, userSettings);
      } finally {
        await cleanup();
      }
    })();
    return { runId, publisher, completion };
  } else {
    try {
      return await executeNonStreaming(red, compiledGraph, initialState, publisher, userSettings);
    } finally {
      await cleanup();
    }
  }
}

// =============================================================================
// Helper: Check if result is streaming
// =============================================================================

export function isStreamingResult(result: RunResult | StreamingRunResult): result is StreamingRunResult {
  return 'publisher' in result && 'completion' in result;
}
