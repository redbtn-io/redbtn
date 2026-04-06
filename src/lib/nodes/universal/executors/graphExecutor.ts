/**
 * Graph Step Executor
 *
 * Enables a universal node step to invoke another graph as a subgraph.
 * The subgraph executes using the parent's infrastructure (neuronRegistry,
 * mcpClient, connectionManager, runPublisher) — it does NOT acquire a separate
 * RunLock and does NOT create its own RunPublisher.
 *
 * Infinite recursion guard: the executor tracks subgraph call depth via
 * state._subgraphDepth and rejects execution at depth > 5.
 */

export interface GraphStepConfig {
    /** ID of the graph to invoke (must exist in MongoDB graphs collection) */
    graphId: string;
    /**
     * Map parent state paths → subgraph input field names.
     * Supports {{state.X}} template syntax for the source path.
     * If omitted, passes the parent's entire data object through.
     *
     * Example: { "userQuery": "{{state.data.query.message}}" }
     */
    inputMapping?: Record<string, string>;
    /**
     * Where to store the subgraph's output in the parent state.
     * Use dot-notation to write into nested fields, e.g. "data.subResult".
     */
    outputField: string;
    /** Max time in ms before the subgraph is abandoned (no timeout if omitted) */
    timeout?: number;
    /**
     * Per-node parameter overrides injected into the subgraph as
     * `state.data.input._configOverrides`. The universalNode picks these up
     * the same way automation runs do.
     *
     * Example: { "search-node": { maxResults: 5 }, "respond-node": { temperature: 0.2 } }
     */
    configOverrides?: Record<string, any>;
    /**
     * Secret names to resolve and forward to the subgraph.
     * Resolved secrets are injected as `state.data.input._secrets` in the subgraph.
     * Falls back to forwarding parent state's `_secrets` when the list is empty.
     */
    secretNames?: string[];
    /** Error handling for this step (propagates to parent error handler by default) */
    errorHandling?: {
        retry?: number;
        retryDelay?: number;
        fallbackValue?: any;
        onError?: 'throw' | 'fallback' | 'skip';
    };
}

/**
 * Runtime overrides passed by the caller (e.g. from a parser subgraph output).
 * These are merged on top of the step-level config, allowing per-invocation
 * customisation without modifying the stored step config.
 */
export interface GraphExecutorRuntimeOverrides {
    /** Per-node parameter overrides (merged with / overriding config.configOverrides) */
    configOverrides?: Record<string, any>;
    /** Additional input fields to inject into the subgraph's data.input */
    input?: Record<string, any>;
}

/** Max subgraph call depth — prevents infinite recursion */
const MAX_SUBGRAPH_DEPTH = 5;

/**
 * Resolve a dotted path against a state object.
 * Supports simple template syntax: "{{state.data.query}}" → state.data.query value.
 */
function resolveStatePath(path: string, state: any): any {
    // Strip {{...}} wrapper if present
    const cleaned = path.trim().replace(/^\{\{(.+)\}\}$/, '$1').trim();
    // Navigate the path
    const parts = cleaned.split('.');
    let current: any = { state };
    for (const part of parts) {
        if (current === undefined || current === null) return undefined;
        current = current[part];
    }
    return current;
}

/**
 * Set a value at a dotted path within an object (mutates obj).
 */
function setNestedPath(obj: Record<string, any>, path: string, value: any): void {
    const parts = path.split('.');
    let current = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const key = parts[i];
        if (typeof current[key] !== 'object' || current[key] === null) {
            current[key] = {};
        }
        current = current[key];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Execute a graph step — invoke a subgraph by graphId and return its output.
 *
 * @param config          - Step-level config (from the node's steps array in MongoDB)
 * @param state           - Current parent graph state
 * @param runtimeOverrides - Optional per-invocation overrides from the caller
 *                          (e.g. parser subgraph output). Merged on top of config.
 */
export async function executeGraph(
    config: GraphStepConfig,
    state: any,
    runtimeOverrides?: GraphExecutorRuntimeOverrides,
): Promise<Partial<any>> {
    const { graphId, inputMapping, outputField, timeout } = config;

    // Validate required config
    if (!graphId) throw new Error('Graph step missing required field: graphId');
    if (!outputField) throw new Error('Graph step missing required field: outputField');

    // Infinite recursion guard
    const currentDepth: number = state._subgraphDepth ?? 0;
    if (currentDepth >= MAX_SUBGRAPH_DEPTH) {
        throw new Error(
            `Graph step exceeded maximum subgraph depth (${MAX_SUBGRAPH_DEPTH}). ` +
            `Attempted to invoke '${graphId}' at depth ${currentDepth + 1}. ` +
            `Check for circular graph references.`
        );
    }

    // Acquire graph registry from state
    const graphRegistry = state._graphRegistry;
    if (!graphRegistry) {
        throw new Error(
            'Graph step requires graphRegistry in state. ' +
            'Ensure _graphRegistry is passed in buildInitialState().'
        );
    }

    const userId: string = state.data?.userId || state.userId;
    if (!userId) throw new Error('Graph step requires userId in state');

    console.log(`[GraphExecutor] Invoking subgraph '${graphId}' at depth ${currentDepth + 1} for user ${userId}`);

    // Compile the subgraph (hits LRU cache in GraphRegistry)
    const compiledGraph = await graphRegistry.getGraph(graphId, userId);

    // Build the subgraph's initial state
    // We share infrastructure from the parent (no separate RunPublisher, no lock).
    const subInput: Record<string, any> = {
        // Pass infrastructure through so neurons, tools, connections all work
        neuronRegistry: state.neuronRegistry,
        memory: state.memory,
        mcpClient: state.mcpClient,
        runPublisher: state.runPublisher,
        connectionManager: state.connectionManager,
        // Track depth to prevent recursion
        _subgraphDepth: currentDepth + 1,
        // Do NOT pass _graphRegistry yet — it's set below to avoid circular concerns.
        // The subgraph will receive it so it can itself call graph steps.
        _graphRegistry: graphRegistry,
        data: {},
    };

    if (inputMapping && Object.keys(inputMapping).length > 0) {
        // Apply explicit field mapping: subgraph field ← resolved parent path
        for (const [subKey, parentPath] of Object.entries(inputMapping)) {
            const value = resolveStatePath(parentPath, state);
            setNestedPath(subInput.data, subKey, value);
        }
    } else {
        // Default: pass a shallow clone of the parent's data
        subInput.data = { ...(state.data || {}) };
    }

    // Always propagate essential execution context
    subInput.data.userId = userId;
    subInput.data.accountTier = state.data?.accountTier;
    subInput.data.defaultNeuronId = state.data?.defaultNeuronId;
    subInput.data.defaultWorkerNeuronId = state.data?.defaultWorkerNeuronId;
    subInput.data.systemMessage = state.data?.systemMessage;
    // Carry conversation messages so subgraph nodes can use history
    if (!subInput.data.messages) {
        subInput.messages = state.messages || [];
    }

    // -----------------------------------------------------------------------
    // configOverrides — per-node parameter overrides for the subgraph.
    // Merge step-level config.configOverrides with caller runtimeOverrides,
    // then inject as state.data.input._configOverrides so universalNode picks
    // them up the same way automation runs do.
    // -----------------------------------------------------------------------
    const mergedConfigOverrides: Record<string, any> = {
        ...(config.configOverrides || {}),
        ...(runtimeOverrides?.configOverrides || {}),
    };
    if (Object.keys(mergedConfigOverrides).length > 0) {
        subInput.data.input = subInput.data.input || {};
        subInput.data.input._configOverrides = mergedConfigOverrides;
        console.log(`[GraphExecutor] Injecting configOverrides for '${graphId}': ${Object.keys(mergedConfigOverrides).join(', ')}`);
    }

    // -----------------------------------------------------------------------
    // Runtime input overrides from caller (e.g. parser subgraph output).
    // Merged into data.input so they're accessible as {{state.data.input.X}}.
    // -----------------------------------------------------------------------
    if (runtimeOverrides?.input && Object.keys(runtimeOverrides.input).length > 0) {
        subInput.data.input = subInput.data.input || {};
        Object.assign(subInput.data.input, runtimeOverrides.input);
    }

    // -----------------------------------------------------------------------
    // secretNames — resolve secrets and forward to subgraph.
    // If secretNames is provided and non-empty, we resolve each named secret
    // from parent state's _secrets map (already resolved by the time it reaches
    // a node) and forward only the requested subset.
    // If secretNames is absent or empty, forward the parent's entire _secrets
    // blob so the subgraph can access the same secrets the parent has.
    // -----------------------------------------------------------------------
    const parentSecrets: Record<string, any> = state.data?.input?._secrets || state._secrets || {};
    if (config.secretNames && config.secretNames.length > 0) {
        const subset: Record<string, any> = {};
        for (const name of config.secretNames) {
            if (parentSecrets[name] !== undefined) {
                subset[name] = parentSecrets[name];
            } else {
                console.warn(`[GraphExecutor] Secret '${name}' not found in parent state for subgraph '${graphId}'`);
            }
        }
        if (Object.keys(subset).length > 0) {
            subInput.data.input = subInput.data.input || {};
            subInput.data.input._secrets = subset;
        }
    } else if (Object.keys(parentSecrets).length > 0) {
        // Forward full parent secrets when no explicit list
        subInput.data.input = subInput.data.input || {};
        subInput.data.input._secrets = parentSecrets;
    }

    // Use a unique ephemeral thread_id so the subgraph checkpointer doesn't
    // collide with the parent run's checkpoint.
    const threadId = `subgraph_${graphId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const invokeConfig = { configurable: { thread_id: threadId } };

    let result: any;
    const t0 = Date.now();

    if (timeout && timeout > 0) {
        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(
                () => reject(new Error(`Subgraph '${graphId}' timed out after ${timeout}ms`)),
                timeout
            )
        );
        result = await Promise.race([
            compiledGraph.graph.invoke(subInput, invokeConfig),
            timeoutPromise,
        ]);
    } else {
        result = await compiledGraph.graph.invoke(subInput, invokeConfig);
    }

    const elapsed = Date.now() - t0;
    const outputKeys = Object.keys(result?.data || result || {});
    console.log(
        `[GraphExecutor] Subgraph '${graphId}' completed in ${elapsed}ms. ` +
        `Output keys: ${outputKeys.join(', ') || '(none)'}`
    );

    // Extract meaningful output — prefer result.data (standard graph output), fall back to root
    const output = result?.data ?? result;

    return { [outputField]: output };
}

export default executeGraph;
