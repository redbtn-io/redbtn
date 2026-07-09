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

// Static import (contextLookup has no back-edge to the executors, so this is
// not circular — toolExecutor imports the same helper statically). Replaces an
// earlier module-top `require`, which couldn't resolve the extensionless `.ts`
// when the source is loaded directly under vitest.
import {
    getGraphRegistry,
    setSubgraphProfile,
    clearSubgraphProfile,
} from '../../../run/contextLookup';
import { resolveCapabilityProfile } from '../../../permissions/resolve';

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

    // Acquire graph registry from run-context registry (with state fallback for tests)
    const graphRegistry = getGraphRegistry(state);
    if (!graphRegistry) {
        throw new Error(
            'Graph step requires graphRegistry in run context. ' +
            'Ensure runControlRegistry.register() was called with graphRegistry.'
        );
    }

    const userId: string = state.data?.userId || state.userId;
    if (!userId) throw new Error('Graph step requires userId in state');

    console.log(`[GraphExecutor] Invoking subgraph '${graphId}' at depth ${currentDepth + 1} for user ${userId}`);

    // Compile the subgraph (hits LRU cache in GraphRegistry)
    const compiledGraph = await graphRegistry.getGraph(graphId, userId);

    // Resolve a human-readable subgraph name for the visibility tag. getConfig
    // is LRU-cached in GraphRegistry, so this is cheap. Best-effort — fall back
    // to the graphId when the registry doesn't expose getConfig (e.g. in tests).
    let subgraphName = graphId;
    try {
        if (typeof graphRegistry.getConfig === 'function') {
            const cfg = await graphRegistry.getConfig(graphId, userId);
            subgraphName = cfg?.name || cfg?.graphName || graphId;
        }
    } catch {
        // ignore — name is cosmetic, graphId is a fine fallback
    }

    // Build the subgraph's initial state.
    // Infrastructure (neuronRegistry, mcpClient, memory, runPublisher,
    // connectionManager, graphRegistry) lives in runControlRegistry keyed by
    // runId — and the subgraph inherits the parent's runId, so all of these
    // are visible via `getX(state)` helpers without being copied into state.
    // Keeping them out of state is what lets MongoCheckpointer serialize
    // checkpoints without hitting Mongoose-internal Symbols.
    // We propagate runId/userId here so the registry lookups inside the
    // subgraph resolve correctly.
    const subInput: Record<string, any> = {
        runId: state.runId,
        userId: state.userId,
        // Track depth to prevent recursion
        _subgraphDepth: currentDepth + 1,
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
    // CRITICAL: propagate the parent run's runId INTO subInput.data.
    //
    // `RedGraphState` (lib/graphs/state.js) does NOT declare a top-level
    // `runId` channel — only `data` is a channel. So `subInput.runId` set
    // above is DROPPED by LangGraph when the subgraph runs, and the subgraph's
    // nodes resolve the run context via `resolveRunId(state) = state.runId ||
    // state.data.runId` (lib/run/contextLookup.ts). Without `data.runId`, the
    // inner tool/neuron executors get NO runPublisher/logger → their tool
    // calls and logs never surface on the parent run.
    //
    // When inputMapping is used, subInput.data starts empty and never carries
    // data.runId, which is exactly the bug observed on run
    // run_K5bQmNvIHTxjpHNbRrfC_ (graph LpERO9iVE-u4): the subgraph's inner
    // get_context_history / now tool calls were invisible at the parent level.
    //
    // We therefore force-set data.runId and data.options.runId to the PARENT
    // runId so every subgraph node resolves the parent's RunPublisher.
    // -----------------------------------------------------------------------
    const parentRunId: string | undefined =
        state.runId || state.data?.runId || state.data?.options?.runId;
    if (parentRunId) {
        subInput.data.runId = parentRunId;
        subInput.data.options = {
            ...(subInput.data.options || {}),
            runId: parentRunId,
        };
    }

    // Tag this execution as a subgraph invocation so graph nodes and logs can
    // distinguish it from a top-level chat/webhook/cron run.
    // Carry the parent run's runId forward so child runs are traceable.
    subInput.data.input = subInput.data.input || {};
    subInput.data.input._trigger = {
        type: 'subgraph',
        metadata: {
            parentRunId,
            parentGraphId: state.data?.options?.graphId,
            subgraphDepth: currentDepth + 1,
        },
    };

    // -----------------------------------------------------------------------
    // Subgraph VISIBILITY tag. The tool executor reads `state.data._subgraph`
    // and forwards it to RunPublisher.toolStart so every tool the subgraph
    // fires is tagged `subgraph:{depth,graphId,name}` in state.tools, the
    // persisted message tools, and the tool logs. The webapp filters on this
    // tag to hide/show subgraph-originated tools on the message bubble.
    //
    // `depth` reflects this invocation's depth (currentDepth + 1). For nested
    // subgraphs the depth is 2+. Each level overwrites `_subgraph` with its
    // own graphId/name/depth, so a tool always carries the tag of the deepest
    // subgraph that actually fired it.
    // -----------------------------------------------------------------------
    subInput.data._subgraph = {
        depth: currentDepth + 1,
        graphId,
        name: subgraphName,
    };

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
    // collide with the parent run's checkpoint. Doubles as the capability
    // scopeId below (unique per invocation → concurrency-safe).
    const threadId = `subgraph_${graphId}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const invokeConfig = { configurable: { thread_id: threadId } };

    // -----------------------------------------------------------------------
    // SUBGRAPH-SCOPED CAPABILITY PROFILE.
    //
    // By default a subgraph is enforced against the PARENT run's profile
    // (resolved once at run-start, keyed by the shared runId). That couples a
    // reusable subgraph's permissions to every caller — the parent must
    // pre-grant everything the subgraph needs. Instead: when the subgraph
    // declares its OWN `capabilities` AND is TRUSTED (a system graph, or owned
    // by the same user as the run), apply ITS profile for the duration of the
    // invocation, restoring the parent's when it returns.
    //
    // Trust gate: an untrusted (third-party / public) subgraph can NEVER
    // self-widen on a caller's machine — it inherits the parent profile. A
    // trusted subgraph MAY widen, because its `capabilities` field is itself a
    // grant authored by the account owner (or the system).
    // -----------------------------------------------------------------------
    let capabilityScopeId: string | undefined;
    try {
        const subConfig: any = (compiledGraph as any)?.config
            || (typeof graphRegistry.getConfig === 'function'
                ? await graphRegistry.getConfig(graphId, userId)
                : undefined);
        const subProfile = resolveCapabilityProfile(subConfig);
        if (subProfile && subConfig) {
            const trusted =
                subConfig.isSystem === true
                || (subConfig.userId != null && String(subConfig.userId) === String(userId));
            if (trusted) {
                capabilityScopeId = threadId;
                setSubgraphProfile(capabilityScopeId, subProfile);
                subInput.data._capabilityScope = capabilityScopeId;
                console.log(`[GraphExecutor] Subgraph '${graphId}' running under its OWN capability profile (trusted).`);
            } else {
                console.warn(`[GraphExecutor] Subgraph '${graphId}' declares a capability profile but is neither system nor owned by the run user — inheriting parent profile (no self-widen).`);
            }
        }
    } catch (e) {
        // Never let profile resolution break a subgraph invocation — fall back
        // to inheriting the parent profile (fail-safe: exec stays fail-closed).
        console.warn(`[GraphExecutor] Subgraph '${graphId}' capability-scope resolution failed (inheriting parent): ${e instanceof Error ? e.message : String(e)}`);
    }

    let result: any;
    const t0 = Date.now();

    try {
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
    } finally {
        if (capabilityScopeId) clearSubgraphProfile(capabilityScopeId);
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
