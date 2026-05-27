/**
 * Tool Resolver
 *
 * Given a list of `ToolRef`s attached to a neuron step, resolve each into a
 * fully-formed `ResolvedTool` ready to bind to the LLM via
 * `model.bindTools(...)`.
 *
 * Resolution order (per ref):
 *   1. `mcp:server.toolName` or `source: 'mcp'`   -> McpRegistry lookup
 *   2. `graph:graphId` or `source: 'graph'`       -> GraphRegistry (graph-as-tool)
 *   3. otherwise                                  -> NativeToolRegistry
 *
 * Each ResolvedTool carries an `invoke(args, ctx)` callback that the engine
 * calls when the LLM emits a tool_call. The callback dispatches to the
 * underlying registry/executor and returns the tool result in a shape the
 * engine can append back to the message history as a `tool` role message.
 *
 * @module lib/tools/tool-resolver
 */

import type { ToolRef } from '../nodes/universal/types';
import { getNativeRegistry } from './native-registry';
import { getMcpClient, getGraphRegistry } from '../run/contextLookup';

// =============================================================================
// Public types
// =============================================================================

/**
 * A tool resolved and ready to be bound to an LLM call.
 */
export interface ResolvedTool {
  /** Tool name as the LLM will see it (must be unique within the binding) */
  name: string;
  /** Description shown to the LLM */
  description: string;
  /** JSON Schema describing the tool's input parameters */
  inputSchema: Record<string, unknown>;
  /** Source registry — diagnostic, also used for tool_start `toolType` events */
  source: 'native' | 'mcp' | 'graph';
  /**
   * Dispatcher. Called by the engine when the LLM emits a tool_call.
   * Returns the raw tool result (already JSON-serialised when possible).
   */
  invoke: (args: Record<string, unknown>, ctx: ToolInvocationContext) => Promise<unknown>;
}

/**
 * Context handed to `ResolvedTool.invoke()`. Mirrors the universal node's
 * native tool context but trimmed to the fields a tool-from-LLM cares about.
 */
export interface ToolInvocationContext {
  /** Current graph state — same object the universal node passes to step executors */
  state: Record<string, unknown>;
  /** Run identifier (when running inside a run) */
  runId: string | null;
  /** Tool execution id — generated per-call by the executor */
  toolId: string;
  /** AbortSignal from RunControlRegistry */
  abortSignal: AbortSignal | null;
  /** Optional resolved credentials (when the neuron step references a connection) */
  credentials?: unknown;
}

// =============================================================================
// Internal helpers
// =============================================================================

interface NormalisedToolRef {
  /** Canonical name — for native tools the registry key, for MCP `server.tool`, for graph `graphId` */
  name: string;
  /** Optional description override */
  descriptionOverride?: string;
  /** Forced source path */
  source: 'native' | 'mcp' | 'graph';
}

/** Normalise a ToolRef into a struct with explicit source. */
function normalise(ref: ToolRef): NormalisedToolRef {
  if (typeof ref === 'string') {
    if (ref.startsWith('mcp:')) {
      return { name: ref.slice(4), source: 'mcp' };
    }
    if (ref.startsWith('graph:')) {
      return { name: ref.slice(6), source: 'graph' };
    }
    return { name: ref, source: 'native' };
  }
  // Object form. If `source` is explicit use it; otherwise sniff prefixes
  // like the string form.
  if (ref.source) {
    return { name: ref.name, descriptionOverride: ref.description, source: ref.source };
  }
  if (ref.name.startsWith('mcp:')) {
    return { name: ref.name.slice(4), descriptionOverride: ref.description, source: 'mcp' };
  }
  if (ref.name.startsWith('graph:')) {
    return { name: ref.name.slice(6), descriptionOverride: ref.description, source: 'graph' };
  }
  return { name: ref.name, descriptionOverride: ref.description, source: 'native' };
}

/**
 * Strip well-known wrapper objects to get a plain JSON schema.
 * Some native tools store zod-like or wrapped schemas — we only need the
 * outer JSON Schema for LLM tool binding.
 */
function ensureJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === 'object') {
    return schema as Record<string, unknown>;
  }
  // Fallback: empty object schema accepts no parameters
  return { type: 'object', properties: {}, additionalProperties: true };
}

// =============================================================================
// Native resolver
// =============================================================================

function resolveNative(
  name: string,
  descriptionOverride: string | undefined,
): ResolvedTool {
  const registry = getNativeRegistry();
  const def = registry.get(name);
  if (!def) {
    throw new Error(`tool-resolver: native tool '${name}' not found`);
  }

  return {
    name,
    description: descriptionOverride ?? def.description,
    inputSchema: ensureJsonSchema(def.inputSchema),
    source: 'native',
    invoke: async (args, ctx) => {
      const result = await registry.callTool(name, args, {
        publisher: null,
        state: ctx.state,
        runId: ctx.runId,
        nodeId: null,
        toolId: ctx.toolId,
        abortSignal: ctx.abortSignal,
        // The neuron-driven path doesn't currently honour onChunk parsing —
        // the LLM consumes the result wholesale.
        onChunk: undefined,
        credentials: ctx.credentials as any,
      });

      // Unwrap MCP-shaped result for the LLM's benefit
      if (result && !result.isError && Array.isArray(result.content)) {
        const text = result.content.find((c) => c?.type === 'text');
        if (text?.text) {
          try {
            return JSON.parse(text.text);
          } catch {
            return text.text;
          }
        }
      }
      return result;
    },
  };
}

// =============================================================================
// MCP resolver
// =============================================================================

function resolveMcp(
  name: string,
  descriptionOverride: string | undefined,
  state: Record<string, unknown>,
): ResolvedTool {
  // `name` may be `serverName.toolName` or just `toolName`. The registry
  // looks up by tool name across all servers, so we strip the server prefix
  // for invocation but keep the full name for the LLM-facing handle so
  // there's no collision when two servers expose the same tool name.
  const dotIdx = name.indexOf('.');
  const toolName = dotIdx >= 0 ? name.slice(dotIdx + 1) : name;
  const llmFacingName = dotIdx >= 0 ? name.replace('.', '__') : name;

  // Pull the registry from the run-context registry (with state fallback for
  // tests). The McpRegistry instance is what gets registered there — same
  // object as `state.mcpClient` was historically, just no longer routed
  // through LangGraph state to avoid checkpoint-serialization corruption.
  const mcpClient: any = getMcpClient(state);

  const found = mcpClient?.findTool ? mcpClient.findTool(toolName) : undefined;
  // Best-effort schema discovery — if the tool is registered we have a
  // schema; otherwise we fall back to a permissive object schema and let
  // the runtime tool-call validate.
  const schema = found?.tool?.inputSchema || { type: 'object', properties: {}, additionalProperties: true };
  const description = descriptionOverride
    || found?.tool?.description
    || `MCP tool: ${name}`;

  return {
    name: llmFacingName,
    description,
    inputSchema: ensureJsonSchema(schema),
    source: 'mcp',
    invoke: async (args, ctx) => {
      const client: any = getMcpClient(ctx.state);
      if (!client) {
        throw new Error(`tool-resolver: McpRegistry not available in run context for tool '${name}'`);
      }
      const result = await client.callTool(toolName, args, {
        // meta — best-effort; webapp passes proper conversation/message ids
        // when the surrounding flow is a chat run.
        conversationId: (ctx.state as any).options?.conversationId
          ?? (ctx.state as any).data?.options?.conversationId,
        credentials: ctx.credentials,
      }, ctx.abortSignal ?? undefined);
      // Unwrap MCP shape (same as native path)
      if (result && !result.isError && Array.isArray(result.content)) {
        const text = result.content.find((c: any) => c?.type === 'text');
        if (text?.text) {
          try {
            return JSON.parse(text.text);
          } catch {
            return text.text;
          }
        }
      }
      return result;
    },
  };
}

// =============================================================================
// Graph-as-tool resolver
// =============================================================================

interface GraphConfigForTool {
  graphId: string;
  publishAsTool?: boolean;
  inputSchema?: Record<string, unknown>;
  toolDescription?: string;
  name?: string;
}

/**
 * Look up a graph and verify it's published as a tool. Returns null on
 * failure rather than throwing so the caller can build a deferred error
 * tool that throws on invoke (this lets resolution succeed for non-graph
 * refs even when one graph is broken).
 */
async function loadGraphConfigForTool(
  graphRegistry: any,
  graphId: string,
  userId: string,
): Promise<GraphConfigForTool | null> {
  if (!graphRegistry?.getConfig) return null;
  try {
    const cfg = await graphRegistry.getConfig(graphId, userId);
    return cfg as GraphConfigForTool;
  } catch {
    return null;
  }
}

async function resolveGraph(
  graphId: string,
  descriptionOverride: string | undefined,
  state: Record<string, unknown>,
): Promise<ResolvedTool> {
  const graphRegistry: any = getGraphRegistry(state);
  const userId: string = ((state as any).data?.userId as string)
    ?? ((state as any).userId as string)
    ?? 'system';

  if (!graphRegistry) {
    throw new Error(`tool-resolver: GraphRegistry not available in run context for graph-as-tool '${graphId}'`);
  }

  const cfg = await loadGraphConfigForTool(graphRegistry, graphId, userId);
  if (!cfg) {
    throw new Error(`tool-resolver: graph '${graphId}' not found or not accessible`);
  }
  if (!cfg.publishAsTool) {
    throw new Error(`tool-resolver: graph '${graphId}' is not published as a tool (publishAsTool !== true)`);
  }

  const description =
    descriptionOverride
    ?? cfg.toolDescription
    ?? cfg.name
    ?? `Subgraph: ${graphId}`;

  return {
    name: graphId,
    description,
    inputSchema: ensureJsonSchema(cfg.inputSchema || { type: 'object', properties: {}, additionalProperties: true }),
    source: 'graph',
    invoke: async (args, ctx) => {
      // Lazy import to avoid a circular dep at module load time —
      // graphExecutor imports stuff that ultimately reads from tool-resolver
      // through neuronExecutor.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const graphExec = await import('../nodes/universal/executors/graphExecutor');
      const executeGraph = graphExec.executeGraph || (graphExec as any).default;
      // We use the existing graph-step executor, treating the LLM's args as
      // the subgraph's data.input. The subgraph's terminal state is returned
      // to the LLM as the tool result.
      const result = await executeGraph(
        {
          graphId,
          outputField: '_subgraphResult',
        } as any,
        // Synthesize a state that has the args injected into data so the
        // subgraph picks them up via data.input or its own inputMapping.
        {
          ...ctx.state,
          data: {
            ...((ctx.state as any).data || {}),
            input: {
              ...(((ctx.state as any).data?.input as Record<string, unknown>) || {}),
              ...args,
            },
          },
        },
        // Runtime override: also inject args into the subgraph's data.input
        { input: args },
      );
      // executeGraph returns { [outputField]: subgraphData }
      return (result as Record<string, unknown>)?._subgraphResult ?? result;
    },
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Resolve a list of tool refs. Resolution is async because graph-as-tool
 * lookups hit the database. Native + MCP refs resolve synchronously.
 *
 * @param refs   - Tool refs from the neuron step config
 * @param state  - Current graph state (used to read mcpClient + _graphRegistry)
 *
 * @throws if any ref fails to resolve. Callers should wrap in try/catch and
 *         convert to a step-level error if they want to soft-fail.
 */
export async function resolveTools(
  refs: ToolRef[],
  state: Record<string, unknown>,
): Promise<ResolvedTool[]> {
  const out: ResolvedTool[] = [];
  for (const ref of refs) {
    const norm = normalise(ref);
    switch (norm.source) {
      case 'native':
        out.push(resolveNative(norm.name, norm.descriptionOverride));
        break;
      case 'mcp':
        out.push(resolveMcp(norm.name, norm.descriptionOverride, state));
        break;
      case 'graph':
        out.push(await resolveGraph(norm.name, norm.descriptionOverride, state));
        break;
    }
  }
  return out;
}

/**
 * Convert a list of resolved tools into the LangChain-binding shape.
 * `model.bindTools()` accepts an array of objects with `name`,
 * `description`, and `schema` (JSON Schema). Some providers may additionally
 * accept `function` shapes; the LangChain core normalises both.
 */
export function toBindToolsPayload(tools: ResolvedTool[]): Array<{
  name: string;
  description: string;
  schema: Record<string, unknown>;
}> {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    schema: t.inputSchema,
  }));
}
