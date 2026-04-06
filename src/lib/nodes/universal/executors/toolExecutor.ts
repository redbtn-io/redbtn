/**
 * Tool Step Executor
 *
 * Executes MCP tool calls with parameter rendering and retry logic.
 * Supports any registered MCP tool (web_search, scrape_url, run_command, etc.)
 */

import { renderParameters, renderTemplate } from '../templateRenderer';
import { executeWithErrorHandling } from './errorHandler';
import { getParserRegistry } from './parserRegistry';
import { ParserExecutor } from './parserExecutor';
import type { ToolStepConfig } from '../types';
const { getNativeRegistry } = require('../../../tools/native-registry.js');

/** Resolved credentials shape passed to tools via meta/context */
interface ResolvedToolCredentials {
    type: string;
    headers: Record<string, string>;
    providerId: string;
    connectionId: string;
    accountInfo?: { email?: string; name?: string; externalId?: string };
}

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

/**
 * Normalize tool step config by converting legacy inputMapping format to parameters format
 *
 * Legacy format (UI): { toolName, inputMapping: { field1: value1, ... }, outputField }
 * New format (execution): { toolName, parameters: { field1: value1, ... }, outputField }
 *
 * @param config - Tool step configuration that may use legacy format
 * @returns Normalized config with parameters field
 */
function normalizeToolStepConfig(config: ToolStepConfig & { inputMapping?: any }): ToolStepConfig {
    const normalized: any = { ...config };
    // Convert legacy inputMapping to parameters
    if (config.inputMapping && !config.parameters) {
        if (typeof config.inputMapping === 'object' && config.inputMapping !== null) {
            normalized.parameters = config.inputMapping;
        } else if (typeof config.inputMapping === 'string' && (config.inputMapping as string).trim()) {
            // Legacy single string format - try to parse as object
            try {
                normalized.parameters = JSON.parse(config.inputMapping);
            } catch {
                // Treat as single parameter value
                normalized.parameters = { value: config.inputMapping };
            }
        } else {
            normalized.parameters = {};
        }
    }
    // Ensure parameters is always an object
    if (!normalized.parameters || typeof normalized.parameters !== 'object') {
        normalized.parameters = {};
    }
    return normalized as ToolStepConfig;
}

/**
 * Execute a tool step (with error handling wrapper)
 *
 * @param config - Tool step configuration
 * @param state - Current graph state
 * @returns Partial state with output field set to tool result
 */
export async function executeTool(config: ToolStepConfig, state: any): Promise<Partial<any>> {
    console.log('[ToolExecutor] ====== STARTING TOOL EXECUTION ======');
    console.log('[ToolExecutor] ToolName:', config.toolName);
    console.log('[ToolExecutor] OutputField:', config.outputField);
    console.log('[ToolExecutor] Parameters:', JSON.stringify(config.parameters));
    // Normalize legacy config format
    const normalizedConfig = normalizeToolStepConfig(config);
    // If error handling configured (new way), use it
    if (normalizedConfig.errorHandling) {
        return executeWithErrorHandling(
            () => executeToolInternal(normalizedConfig, state),
            normalizedConfig.errorHandling,
            { type: 'tool', field: normalizedConfig.outputField }
        );
    }
    // Otherwise use legacy retry logic (backward compatibility)
    return executeToolInternal(normalizedConfig, state);
}

/**
 * Internal tool execution (actual MCP tool call logic)
 *
 * Flow:
 * 1. Get tool from MCP registry
 * 2. Render parameter templates with current state
 * 3. Call tool with rendered parameters
 * 4. Retry on failure if configured (legacy retryOnError)
 * 5. Return result in specified output field
 *
 * @param config - Tool step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps + infrastructure)
 * @returns Partial state with output field set to tool result
 */
async function executeToolInternal(config: ToolStepConfig, state: any): Promise<Partial<any>> {
    // Validate required fields
    if (!config.toolName) {
        throw new Error('Tool step missing required field: toolName');
    }
    if (!config.outputField) {
        throw new Error('Tool step missing required field: outputField');
    }
    if (!config.parameters || typeof config.parameters !== 'object') {
        throw new Error(`Tool step "${config.toolName}" missing or invalid parameters object`);
    }

    // Get RunPublisher for tool events (only available in run path)
    const runPublisher = state.runPublisher;

    // Generate unique tool execution ID
    const toolId = `tool_${config.toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // --- streamToConversation support ---
    // When runPublisher exists, parsed chunks route through it (which forwards
    // to conversation stream with runId). This makes tool+parser graphs produce
    // identical events to neuron-based graphs. Standalone ConversationPublisher
    // is only used when there's no RunPublisher (non-run context).
    let convPublisher: any = null;
    let streamMessageId: string | null = null;
    let streamRedis: any = null;
    const streamTarget = (config as any).streamToConversation;
    const streamFilter: string = (config as any).streamFilter || 'stdout'; // 'stdout' | 'stderr' | 'all'
    const useRunPublisherForConv = !!(runPublisher && streamTarget);

    if (streamTarget && !useRunPublisherForConv) {
        // Standalone path: no RunPublisher, create our own ConversationPublisher
        try {
            const Redis = require('ioredis');
            const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
            streamRedis = new Redis(redisUrl);
            // Determine target conversationId
            const targetConvId = streamTarget === true
                ? (state.data?.conversationId || state.conversationId || state.options?.conversationId)
                : String(streamTarget);
            if (targetConvId) {
                const { createConversationPublisher } = require('../../../conversation/index.js');
                convPublisher = createConversationPublisher({
                    redis: streamRedis,
                    conversationId: targetConvId,
                });
                streamMessageId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                await convPublisher.startMessage(streamMessageId, 'assistant');
                console.log(`[ToolExecutor] streamToConversation (standalone) enabled for ${config.toolName} -> conversation ${targetConvId}`);
            }
        } catch (err: any) {
            console.warn('[ToolExecutor] Failed to set up streamToConversation:', err.message);
            convPublisher = null;
            streamMessageId = null;
        }
    } else if (useRunPublisherForConv) {
        console.log(`[ToolExecutor] streamToConversation via RunPublisher for ${config.toolName}`);
    }

    // --- Stream parser setup ---
    // Load parser when streamToConversation is set, regardless of publisher type
    let parserExecutor: ParserExecutor | null = null;
    if ((config as any).streamParser && streamTarget) {
        try {
            const registry = getParserRegistry();
            const parserDef = await registry.getParser((config as any).streamParser);
            if (parserDef) {
                // Build tool executor callback for parser tool steps (e.g. send-discord)
                const nativeReg = getNativeRegistry();
                const parserToolExecutor = async (toolName: string, params: Record<string, any>) => {
                    if (nativeReg.has(toolName)) {
                        const tool = nativeReg.get(toolName);
                        return tool.handler(params, {});
                    }
                    // Fall back to MCP
                    const mcpClient = state.mcpClient;
                    if (mcpClient) {
                        return mcpClient.callTool(toolName, params);
                    }
                    throw new Error(`Tool "${toolName}" not available in parser context`);
                };
                parserExecutor = new ParserExecutor(parserDef.config, parserDef.parserConfig, parserToolExecutor);
                // Inject context from graph state so parser steps can reference channelId, platform, etc.
                const inputData = state.data?.input || state.input || {};
                const triggerSource = (inputData as any)._trigger?.source;
                parserExecutor.setContext({
                    channelId: inputData.channelId,
                    // platform: canonical free-form string ('discord', 'telegram', 'email', etc.)
                    // Falls back to legacy inputData.type for backward compat with old webhook payloads.
                    platform: triggerSource?.platform || state.data?.platform || (inputData as any).type,
                    // Keep triggerType for backward compat — deprecated, use platform instead.
                    triggerType: state.data?.triggerType || (inputData as any).type,
                    messageId: inputData.messageId,
                    replyToMessageId: state.data?.replyToMessageId || inputData.messageId,
                });
                console.log(`[ToolExecutor] Stream parser "${(config as any).streamParser}" loaded for ${config.toolName} (tool steps enabled)`);
            } else {
                console.warn(`[ToolExecutor] Stream parser "${(config as any).streamParser}" not found, using passthrough`);
            }
        } catch (err: any) {
            console.warn('[ToolExecutor] Failed to load stream parser:', err.message);
        }
    }

    // Helper: extract stdout/stderr from tool result for conversation streaming
    function extractStreamContent(serializedResult: any): string {
        if (!serializedResult) return '';
        if (typeof serializedResult === 'string') return serializedResult;
        // For structured results (e.g. ssh_shell), extract stdout/stderr based on filter
        const stdout = serializedResult.stdout || serializedResult.output || '';
        const stderr = serializedResult.stderr || '';
        if (streamFilter === 'all') return [stdout, stderr].filter(Boolean).join('\n');
        if (streamFilter === 'stderr') return stderr;
        return stdout; // default: 'stdout'
    }

    // Helper: forward tool result to conversation stream and clean up
    async function forwardToConversation(serializedResult: any): Promise<void> {
        if (useRunPublisherForConv) {
            // RunPublisher path: just flush parser remaining buffer
            // RunPublisher.complete() handles conversation stream completion
            if (parserExecutor) {
                try {
                    const flushOutput = await parserExecutor.flush();
                    if (flushOutput) {
                        if (typeof flushOutput === 'string') {
                            await runPublisher.chunk(flushOutput);
                        } else if (flushOutput && typeof flushOutput === 'object' && flushOutput.content) {
                            if (flushOutput.thinking) {
                                await runPublisher.thinkingChunk(flushOutput.content);
                            } else {
                                await runPublisher.chunk(flushOutput.content);
                            }
                        }
                    }
                } catch (flushErr: any) {
                    console.warn('[ToolExecutor] Parser flush error:', flushErr.message);
                }
            }
            return; // RunPublisher handles conversation completion via run_complete
        }
        if (!convPublisher || !streamMessageId) return;
        try {
            if (parserExecutor) {
                // Parser handled per-chunk streaming -- just flush remaining buffer and complete
                try {
                    const flushOutput = await parserExecutor.flush();
                    if (flushOutput) {
                        await convPublisher.streamChunk(streamMessageId, flushOutput);
                    }
                } catch (flushErr: any) {
                    console.warn('[ToolExecutor] Parser flush error:', flushErr.message);
                }
                await convPublisher.completeMessage(streamMessageId);
            } else {
                const content = extractStreamContent(serializedResult);
                if (content) {
                    await convPublisher.streamChunk(streamMessageId, content);
                }
                await convPublisher.completeMessage(streamMessageId);
            }
        } catch (err: any) {
            console.warn('[ToolExecutor] streamToConversation forward failed:', err.message);
        } finally {
            try { if (streamRedis) await streamRedis.quit(); } catch { /* ignore */ }
        }
    }

    // Helper: clean up conversation stream resources on error
    async function cleanupConversationStream(): Promise<void> {
        if (!convPublisher || !streamMessageId) return;
        try {
            await convPublisher.completeMessage(streamMessageId, '[tool execution failed]');
        } catch { /* ignore */ }
        finally {
            try { if (streamRedis) await streamRedis.quit(); } catch { /* ignore */ }
        }
    }

    try {
        // Render parameter templates with current state (needed for both native and MCP paths)
        const renderedParams = renderParameters(config.parameters, state);

        // -------------------------------------------------------------------------
        // Connection credential resolution — when connectionId or providerId is set,
        // resolve user credentials from ConnectionManager and pass to tools
        // -------------------------------------------------------------------------
        let resolvedCredentials: ResolvedToolCredentials | null = null;
        if (config.connectionId || config.providerId) {
            const connectionManager = state.connectionManager;
            if (connectionManager) {
                try {
                    const connId = config.connectionId
                        ? renderTemplate(config.connectionId, state)
                        : undefined;
                    const provId = config.providerId
                        ? renderTemplate(config.providerId, state)
                        : undefined;

                    let context: any = null;
                    if (connId) {
                        context = await connectionManager.getConnection(connId);
                    } else if (provId) {
                        context = await connectionManager.getDefaultConnection(provId);
                    }

                    if (context) {
                        if (context.connection.status !== 'active') {
                            console.warn(`[ToolExecutor] Connection ${context.connection.connectionId} is not active (status: ${context.connection.status})`);
                        } else {
                            resolvedCredentials = {
                                type: context.credentials.type,
                                headers: context.credentials.headers,
                                providerId: context.provider.providerId,
                                connectionId: context.connection.connectionId,
                                accountInfo: context.connection.accountInfo ? {
                                    email: context.connection.accountInfo.email,
                                    name: context.connection.accountInfo.name,
                                    externalId: context.connection.accountInfo.externalId,
                                } : undefined,
                            };
                            console.log(`[ToolExecutor] Resolved credentials for ${config.toolName} from ${resolvedCredentials.providerId} (${resolvedCredentials.connectionId})`);
                        }
                    } else {
                        console.warn(`[ToolExecutor] No connection found for tool ${config.toolName} (connectionId=${connId}, providerId=${provId})`);
                    }
                } catch (credErr: any) {
                    console.warn(`[ToolExecutor] Failed to resolve credentials for ${config.toolName}:`, credErr.message);
                }
            } else {
                console.warn(`[ToolExecutor] ConnectionManager not available in state, cannot resolve credentials for ${config.toolName}`);
            }
        }

        // -------------------------------------------------------------------------
        // Native tool fast path — check BEFORE MCP to avoid JSON-RPC overhead
        // -------------------------------------------------------------------------
        const nativeRegistry = getNativeRegistry();
        if (nativeRegistry.has(config.toolName)) {
            console.log(`[ToolExecutor] Routing to native tool: ${config.toolName}`);
            if (runPublisher) {
                await runPublisher.toolStart(toolId, config.toolName, 'native', { input: renderedParams });
            }

            // Build onChunk callback for real-time stream parsing
            const onChunk = (parserExecutor && (useRunPublisherForConv || (convPublisher && streamMessageId)))
                ? (chunk: any, streamType: string) => {
                    const sf: string = (config as any).streamFilter || 'stdout';
                    if (sf !== 'all' && sf !== streamType) return;
                    try {
                        parserExecutor.processChunk(chunk, streamType).then((outputs: any[]) => {
                            if (outputs && outputs.length > 0) {
                                for (const output of outputs) {
                                    if (useRunPublisherForConv) {
                                        // Route through RunPublisher → both run stream + conversation stream
                                        if (typeof output === 'string') {
                                            runPublisher.chunk(output).catch((err: any) => {
                                                console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                            });
                                        } else if (Array.isArray(output)) {
                                            for (const item of output) {
                                                if (item && item.content) {
                                                    if (item.thinking) {
                                                        runPublisher.thinkingChunk(item.content).catch((err: any) => {
                                                            console.warn('[ToolExecutor] onChunk RunPublisher.thinkingChunk error:', err.message);
                                                        });
                                                    } else {
                                                        runPublisher.chunk(item.content).catch((err: any) => {
                                                            console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                                        });
                                                    }
                                                }
                                            }
                                        } else if (output && typeof output === 'object' && output.content) {
                                            if (output.thinking) {
                                                runPublisher.thinkingChunk(output.content).catch((err: any) => {
                                                    console.warn('[ToolExecutor] onChunk RunPublisher.thinkingChunk error:', err.message);
                                                });
                                            } else {
                                                runPublisher.chunk(output.content).catch((err: any) => {
                                                    console.warn('[ToolExecutor] onChunk RunPublisher.chunk error:', err.message);
                                                });
                                            }
                                        }
                                    } else {
                                        // Standalone ConversationPublisher path
                                        if (typeof output === 'string') {
                                            convPublisher.streamChunk(streamMessageId, output, false).catch((err: any) => {
                                                console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                            });
                                        } else if (Array.isArray(output)) {
                                            for (const item of output) {
                                                if (item && item.content) {
                                                    convPublisher.streamChunk(streamMessageId, item.content, !!item.thinking).catch((err: any) => {
                                                        console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                                    });
                                                }
                                            }
                                        } else if (output && typeof output === 'object' && output.content) {
                                            convPublisher.streamChunk(streamMessageId, output.content, !!output.thinking).catch((err: any) => {
                                                console.warn('[ToolExecutor] onChunk streamChunk error:', err.message);
                                            });
                                        }
                                    }
                                }
                            }
                        }).catch((err: any) => {
                            console.warn('[ToolExecutor] onChunk processChunk error:', err.message);
                        });
                    } catch (err: any) {
                        console.warn('[ToolExecutor] onChunk error:', err.message);
                    }
                }
                : undefined;

            // Build context for the native tool handler
            const nativeContext = {
                publisher: runPublisher || null,
                state,
                runId: state.data?.runId || state.runId || null,
                nodeId: state.nodeConfig?.graphNodeId || state.nodeConfig?.nodeId || null,
                toolId: toolId,
                abortSignal: state._abortController?.signal || null,
                onChunk,
                credentials: resolvedCredentials,
            };

            // Retry logic — mirrors the MCP path
            const maxNativeRetries = config.retryOnError ? (config.maxRetries ?? 3) : 0;
            let lastNativeError: Error | undefined;
            for (let attempt = 0; attempt <= maxNativeRetries; attempt++) {
                try {
                    if (attempt > 0) {
                        console.log(`[ToolExecutor] Native tool retry ${attempt}/${maxNativeRetries}: ${config.toolName}`);
                        if (runPublisher) {
                            await runPublisher.toolProgress(toolId, `retry_${attempt}`, {
                                progress: attempt / (maxNativeRetries + 1),
                                data: { attempt, maxRetries: maxNativeRetries }
                            });
                        }
                        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
                    }
                    const nativeResult = await nativeRegistry.callTool(config.toolName, renderedParams, nativeContext);
                    // Extract result content using the same logic as the MCP path
                    let extractedNativeResult: any = nativeResult;
                    if (nativeResult && !nativeResult.isError && nativeResult.content && Array.isArray(nativeResult.content)) {
                        const firstContent = nativeResult.content[0];
                        if (firstContent?.type === 'text' && firstContent.text) {
                            try {
                                extractedNativeResult = JSON.parse(firstContent.text);
                            } catch {
                                extractedNativeResult = firstContent.text;
                            }
                        }
                    }
                    let serializedNativeResult: any;
                    try {
                        serializedNativeResult = JSON.parse(JSON.stringify(extractedNativeResult));
                    } catch {
                        serializedNativeResult = String(extractedNativeResult);
                    }
                    if (runPublisher) {
                        const resultLength = typeof serializedNativeResult === 'string'
                            ? serializedNativeResult.length
                            : JSON.stringify(serializedNativeResult).length;
                        await runPublisher.toolComplete(toolId, serializedNativeResult, {
                            outputField: config.outputField,
                            attempts: attempt + 1,
                            resultLength,
                        });
                    }
                    // Forward native tool result to conversation stream
                    await forwardToConversation(serializedNativeResult);
                    return { [config.outputField]: serializedNativeResult };
                } catch (nativeErr: any) {
                    lastNativeError = nativeErr instanceof Error ? nativeErr : new Error(String(nativeErr));
                    if (attempt >= maxNativeRetries) break;
                }
            }
            // All retries exhausted
            const nativeErrMsg = lastNativeError?.message || 'Native tool call failed';
            if (runPublisher) {
                await runPublisher.toolError(toolId, nativeErrMsg);
            }
            await cleanupConversationStream();
            throw lastNativeError || new Error(nativeErrMsg);
        }

        // -------------------------------------------------------------------------
        // MCP path (original logic)
        // -------------------------------------------------------------------------
        // Get MCP client from state (it's the registry)
        const mcpClient = state.mcpClient;
        if (!mcpClient) {
            throw new Error('MCP client not available in state');
        }
        if (DEBUG)
            console.log('[ToolExecutor] Executing tool step', {
                toolName: config.toolName,
                outputField: config.outputField
            });

        // Emit tool_start event
        if (runPublisher) {
            await runPublisher.toolStart(toolId, config.toolName, 'mcp', {
                input: renderedParams
            });
        }

        // Get metadata for tool execution
        // Note: messageId in meta is set by legacy respond() callers only.
        // In the run() path, state.messageId is undefined and MCP registry event
        // publishing is skipped. Tool events are published via RunPublisher instead.
        const meta: Record<string, any> = {
            conversationId: state.options?.conversationId || state.data?.options?.conversationId,
            generationId: state.options?.generationId || state.data?.options?.generationId,
            messageId: state.messageId || state.data?.messageId,
            credentials: resolvedCredentials,
        };
        if (DEBUG)
            console.log('[ToolExecutor] Tool meta for event publishing:', {
                conversationId: meta.conversationId,
                messageId: meta.messageId
            });

        // Execute with retry logic
        const maxRetries = config.retryOnError ? (config.maxRetries ?? 3) : 0;
        let lastError: Error | undefined;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                // Emit retry progress if not first attempt
                if (attempt > 0 && runPublisher) {
                    await runPublisher.toolProgress(toolId, `retry_${attempt}`, {
                        progress: attempt / (maxRetries + 1),
                        data: { attempt, maxRetries }
                    });
                }
                // Call tool via registry (handles server lookup and execution)
                if (DEBUG)
                    console.log(`[ToolExecutor] Calling mcpClient.callTool: ${config.toolName}`);
                const result = await mcpClient.callTool(config.toolName, renderedParams, meta);
                if (DEBUG)
                    console.log(`[ToolExecutor] mcpClient.callTool returned for ${config.toolName}`);
                if (DEBUG)
                    console.log('[ToolExecutor] Tool call succeeded', {
                        toolName: config.toolName,
                        outputField: config.outputField,
                        attempt: attempt + 1
                    });

                // Check if result is serializable BEFORE processing
                try {
                    JSON.stringify(result);
                } catch {
                    console.error('[ToolExecutor] Tool result contains circular references from MCP!', {
                        toolName: config.toolName,
                        resultKeys: Object.keys(result || {})
                    });
                }

                // Extract result content (MCP tools return {content: [...], isError: false})
                let extractedResult: any = result;
                if (result && !result.isError && result.content && Array.isArray(result.content)) {
                    // Try to parse JSON content if it's text
                    const firstContent = result.content[0];
                    if (firstContent?.type === 'text' && firstContent.text) {
                        try {
                            extractedResult = JSON.parse(firstContent.text);
                        } catch {
                            // Not JSON, use raw text
                            extractedResult = firstContent.text;
                        }
                    }
                }

                // Ensure result is JSON-serializable (remove circular references, MongoDB objects, etc.)
                let serializedResult: any;
                try {
                    serializedResult = JSON.parse(JSON.stringify(extractedResult));
                } catch {
                    console.warn('[ToolExecutor] Result contains circular references, extracting primitive data');
                    // If serialization fails, try to extract only primitive data
                    if (typeof extractedResult === 'string') {
                        serializedResult = extractedResult;
                    } else if (extractedResult && typeof extractedResult === 'object') {
                        // Extract only serializable properties
                        serializedResult = {} as Record<string, any>;
                        for (const key in extractedResult) {
                            try {
                                const value = extractedResult[key];
                                // Only include primitives, arrays, and plain objects
                                if (value === null || typeof value !== 'object' || Array.isArray(value)) {
                                    JSON.stringify(value); // Test if serializable
                                    serializedResult[key] = value;
                                }
                            } catch {
                                // Skip non-serializable properties
                            }
                        }
                    } else {
                        serializedResult = String(extractedResult);
                    }
                }

                // Emit tool_complete event
                if (runPublisher) {
                    const resultLength = typeof serializedResult === 'string'
                        ? serializedResult.length
                        : JSON.stringify(serializedResult).length;
                    await runPublisher.toolComplete(toolId, serializedResult, {
                        outputField: config.outputField,
                        attempts: attempt + 1,
                        resultLength,
                    });
                }

                // Forward MCP tool result to conversation stream
                await forwardToConversation(serializedResult);

                // Return output field
                return {
                    [config.outputField]: serializedResult
                };
            } catch (error: any) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < maxRetries) {
                    // Calculate exponential backoff: 1s, 2s, 3s
                    const delayMs = (attempt + 1) * 1000;
                    console.warn('[ToolExecutor] Tool call failed, retrying', {
                        toolName: config.toolName,
                        attempt: attempt + 1,
                        maxRetries,
                        delayMs,
                        error: lastError.message
                    });
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                }
            }
        }

        // All retries exhausted - emit tool_error
        const errorMessage = lastError?.message || 'Tool call failed';
        if (runPublisher) {
            await runPublisher.toolError(toolId, errorMessage);
        }
        await cleanupConversationStream();
        console.error('[ToolExecutor] Tool step failed after retries', {
            toolName: config.toolName,
            outputField: config.outputField,
            attempts: maxRetries + 1,
            error: errorMessage
        });
        throw lastError || new Error('Tool call failed');

    } catch (error: any) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        // Emit tool_error if not already emitted (for non-retry errors)
        if (runPublisher) {
            await runPublisher.toolError(toolId, errorMessage);
        }
        await cleanupConversationStream();
        console.error('[ToolExecutor] Tool step failed', {
            toolName: config.toolName,
            outputField: config.outputField,
            error: errorMessage
        });
        throw new Error(`Tool step failed: ${errorMessage}`);
    }
}
