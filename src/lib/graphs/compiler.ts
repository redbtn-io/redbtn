/**
 * Graph Compiler
 *
 * Compiles graph configurations into LangGraph StateGraph instances.
 * Uses JIT (Just-In-Time) compilation with validation.
 * All nodes run through universalNode — config is loaded from MongoDB by nodeId.
 */

import { StateGraph, END, Send } from '@langchain/langgraph';
import { GraphConfig, GraphEdgeConfig, CompiledGraph } from '../types/graph';

// These imports resolve from the dist/ directory at runtime — they are
// hand-maintained modules that have no source counterpart in src/.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { universalNode } = require('./nodeRegistry');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createConditionFunction } = require('./conditionEvaluator');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { RedGraphState } = require('./state');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createMongoCheckpointer } = require('./MongoCheckpointer');

// Shared checkpointer instance (stateless — safe to reuse across compilations)
const _sharedCheckpointer = createMongoCheckpointer();

/**
 * Creates a configurable node wrapper that injects config into the state.
 * This allows nodes to access custom configuration from GraphNodeConfig.
 *
 * @param graphNodeId The graph node ID (e.g., "context-1768684860197-u6xweb") — used for event publishing
 * @param config Optional additional configuration for the node
 */
function createConfigurableNode(graphNodeId: string, config: Record<string, unknown> = {}) {
  return async (state: any) => {
    // Inject node config into state so the node can access it
    // - graphNodeId: Used for event publishing (the unique node instance in this graph)
    // - nodeId: Used for registry lookup (explicit config.nodeId or falls back to graphNodeId)
    const enhancedState = {
      ...state,
      nodeConfig: {
        ...config,
        graphNodeId,
        nodeId: (config.nodeId as string) || graphNodeId,
      },
    };
    return await universalNode(enhancedState);
  };
}

/**
 * Compiles a graph configuration into a LangGraph CompiledStateGraph.
 * This is a JIT compilation process that happens at runtime when a graph is loaded.
 *
 * @param config Graph configuration from MongoDB
 * @returns Compiled graph ready for invocation
 * @throws GraphCompilationError if graph is invalid
 */
export function compileGraphFromConfig(config: GraphConfig): CompiledGraph {
  console.log(`[GraphCompiler] Compiling graph: ${config.graphId}`);

  // Step 1: Validate configuration before compilation
  validateGraphConfig(config);

  // Step 2: Create StateGraph builder with RedGraphState annotations
  const builder = new StateGraph(RedGraphState);

  // Step 3: Add all nodes to the graph
  for (const node of config.nodes) {
    console.log(`[GraphCompiler]   Adding node: ${node.id} (nodeId: ${node.config?.nodeId || node.id})`);
    const wrappedFn = createConfigurableNode(node.id, (node.config as Record<string, unknown>) || {});
    builder.addNode(node.id, wrappedFn);
  }

  // Step 3.5: Add global error handler node (if not already present)
  if (!config.nodes.some(n => n.id === 'error_handler')) {
    console.log(`[GraphCompiler]   Adding system node: error_handler`);
    const errorHandlerFn = createConfigurableNode('error_handler', {});
    builder.addNode('error_handler', errorHandlerFn);
  }

  // Step 4: Add all edges (simple, conditional, parallel fan-out, and join fan-in)
  for (const edge of config.edges) {
    if (edge.join) {
      // Fan-in: wait for all listed sources before proceeding
      addJoinEdge(builder, edge);
    } else if (edge.parallel) {
      // Fan-out: fire all listed nodes in parallel
      addFanOutEdge(builder, edge, config);
    } else if (edge.condition || edge.targets) {
      // Conditional edge with branching logic
      addConditionalEdge(builder, edge, config);
    } else {
      // Simple direct edge
      addSimpleEdge(builder, edge);
    }
  }

  // Step 5: Compile the graph with MongoDB checkpointer for crash recovery.
  // The checkpointer persists full graph state to MongoDB after every node
  // completes. On crash/retry, LangGraph resumes from the last checkpoint
  // when the same thread_id is passed in the invocation config.
  const compiled = builder.compile({ checkpointer: _sharedCheckpointer });
  console.log(`[GraphCompiler] Successfully compiled graph: ${config.graphId} (with MongoDB checkpointer)`);

  return {
    graphId: config.graphId,
    config,
    graph: compiled,
    compiledAt: new Date(),
  };
}

/**
 * Validates graph configuration before compilation.
 * Throws errors for critical issues, logs warnings for best practices.
 */
function validateGraphConfig(config: GraphConfig): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate nodes exist
  if (!config.nodes || config.nodes.length === 0) {
    errors.push('Graph must have at least one node');
  }

  // Validate edges exist
  if (!config.edges || config.edges.length === 0) {
    errors.push('Graph must have at least one edge');
  }

  // Validate nodes have config.nodeId (required for loading from MongoDB)
  for (const node of config.nodes || []) {
    if (!node.config?.nodeId && !node.id) {
      errors.push(`Node is missing both config.nodeId and id: ${JSON.stringify(node)}`);
    }
  }

  // Check for duplicate node IDs
  if (config.nodes) {
    const nodeIds = config.nodes.map(n => n.id);
    const uniqueIds = new Set(nodeIds);
    if (nodeIds.length !== uniqueIds.size) {
      const duplicates = nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index);
      errors.push(`Duplicate node IDs found: ${duplicates.join(', ')}`);
    }
  }

  // Validate edges reference valid nodes
  if (config.nodes && config.edges) {
    const validNodeIds = new Set([
      ...config.nodes.map(n => n.id),
      '__start__',
      '__end__',
      END,
    ]);

    for (const edge of config.edges) {
      // Validate source node (skip for join edges — they have no `from`, only `join` sources)
      if (!edge.join && !validNodeIds.has(edge.from)) {
        errors.push(`Edge references unknown source node: ${edge.from}`);
      }

      // Validate target node (simple edge)
      if (edge.to && !validNodeIds.has(edge.to)) {
        errors.push(`Edge references unknown target node: ${edge.to}`);
      }

      // Validate all targets in conditional edges
      if (edge.targets) {
        for (const [key, target] of Object.entries(edge.targets)) {
          if (!validNodeIds.has(target)) {
            errors.push(`Edge references unknown target in '${key}': ${target}`);
          }
        }
      }

      // Validate fallback node
      if (edge.fallback && !validNodeIds.has(edge.fallback)) {
        errors.push(`Edge references unknown fallback node: ${edge.fallback}`);
      }

      // Validate parallel fan-out targets
      if (edge.parallel) {
        for (const nodeId of edge.parallel) {
          if (!validNodeIds.has(nodeId)) {
            errors.push(`Parallel edge references unknown target node: ${nodeId}`);
          }
        }
      }

      // Validate join fan-in sources
      if (edge.join) {
        for (const nodeId of edge.join) {
          if (!validNodeIds.has(nodeId)) {
            errors.push(`Join edge references unknown source node: ${nodeId}`);
          }
        }
      }
    }
  }

  // Validate tier value
  if (config.tier !== undefined && (config.tier < 0 || config.tier > 4)) {
    errors.push(`Invalid tier value: ${config.tier} (must be 0-4)`);
  }

  // Warnings: Check for orphaned nodes (no incoming edges)
  if (config.nodes && config.edges) {
    const nodesWithIncoming = new Set<string>();
    for (const edge of config.edges) {
      if (edge.to) {
        nodesWithIncoming.add(edge.to);
      }
      if (edge.targets) {
        for (const target of Object.values(edge.targets)) {
          nodesWithIncoming.add(target);
        }
      }
      if (edge.fallback) {
        nodesWithIncoming.add(edge.fallback);
      }
      // Fan-out targets count as having incoming edges
      if (edge.parallel) {
        for (const nodeId of edge.parallel) {
          nodesWithIncoming.add(nodeId);
        }
      }
      // Join target counts as having incoming edges
      if (edge.join && edge.to) {
        nodesWithIncoming.add(edge.to);
      }
    }

    const orphanedNodes = config.nodes
      .map(n => n.id)
      .filter(id => !nodesWithIncoming.has(id) && id !== '__start__');

    if (orphanedNodes.length > 0) {
      warnings.push(`Orphaned nodes (no incoming edges): ${orphanedNodes.join(', ')}`);
    }
  }

  // Warnings: Check for very large graphs
  if (config.nodes && config.nodes.length > 20) {
    warnings.push(`Large graph detected: ${config.nodes.length} nodes (may impact performance)`);
  }

  // Log warnings
  for (const warning of warnings) {
    console.warn(`[GraphCompiler] WARNING: ${warning}`);
  }

  // Throw if any errors
  if (errors.length > 0) {
    throw new GraphCompilationError(
      `Graph validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`,
      config.graphId
    );
  }
}

/**
 * Adds a parallel fan-out edge to the graph builder.
 * Fires all listed target nodes concurrently using LangGraph's conditional edge
 * with an array return value (NamedBarrierValue send pattern).
 */
function addFanOutEdge(builder: any, edge: GraphEdgeConfig, _config: GraphConfig): void {
  const targets = edge.parallel!;
  console.log(`[GraphCompiler]   Adding parallel fan-out: ${edge.from} → [${targets.join(', ')}]`);

  // Use addConditionalEdges with array return for parallel execution.
  // LangGraph treats an array return as "run all these nodes in the same superstep".
  const targetMap: Record<string, string> = {};
  for (const nodeId of targets) {
    targetMap[nodeId] = nodeId;
  }
  targetMap['error_handler'] = 'error_handler';

  builder.addConditionalEdges(edge.from, (state: any) => {
    if (state.data?.nextGraph === 'error_handler') {
      return 'error_handler';
    }
    return targets;
  }, targetMap);
}

/**
 * Adds a fan-in (join/barrier) edge to the graph builder.
 * LangGraph's addEdge(string[], string) creates a NamedBarrierValue channel
 * that waits for all listed source nodes to complete before proceeding.
 */
function addJoinEdge(builder: any, edge: GraphEdgeConfig): void {
  const sources = edge.join!;
  const target = edge.to || '__end__';
  console.log(`[GraphCompiler]   Adding join: [${sources.join(', ')}] → ${target}`);

  // LangGraph's addEdge(string[], string) creates a NamedBarrierValue channel
  builder.addEdge(sources, target);
}

/**
 * Adds a simple edge to the graph builder.
 * Automatically upgrades to conditional edge to handle global error states.
 */
function addSimpleEdge(builder: any, edge: GraphEdgeConfig): void {
  const to = edge.to || END;
  console.log(`[GraphCompiler]   Adding edge: ${edge.from} → ${to} (with error fallback)`);

  // Upgrade to conditional edge to handle error_handler transition
  builder.addConditionalEdges(edge.from, (state: any) => {
    if (state.data?.nextGraph === 'error_handler') {
      return 'error_handler';
    }
    return 'default';
  }, {
    'error_handler': 'error_handler',
    'default': to,
  });
}

/**
 * Adds a conditional edge with branching logic to the graph builder.
 * Automatically injects error handling logic.
 */
function addConditionalEdge(builder: any, edge: GraphEdgeConfig, config: GraphConfig): void {
  if (!edge.condition && !edge.targets) {
    throw new GraphCompilationError(
      `Conditional edge from ${edge.from} missing condition or targets`,
      config.graphId
    );
  }

  // Build condition function using safe evaluator
  const originalConditionFn = createConditionFunction(edge.condition || '', edge.targets || {}, edge.fallback);

  // Wrap condition function to check for error state first
  const conditionFn = (state: any) => {
    if (state.data?.nextGraph === 'error_handler') {
      return 'error_handler';
    }
    return originalConditionFn(state);
  };

  // Build target mapping (all possible destinations)
  // LangGraph expects: conditionFn returns KEY → targetMap[KEY] = nodeId
  const targetMap: Record<string, string> = {};

  if (edge.targets) {
    // Explicit targets provided
    for (const [key, value] of Object.entries(edge.targets)) {
      targetMap[key] = value;
    }
  } else if (edge.to) {
    // Simple condition with single target
    targetMap['true'] = edge.to;
  }

  if (edge.fallback) {
    // CRITICAL: Fallback must be in targetMap for LangGraph to see it as reachable
    targetMap['__fallback__'] = edge.fallback;
  }

  // Always include __end__ as possible target
  targetMap['__end__'] = END;
  // Add error handler to target map
  targetMap['error_handler'] = 'error_handler';

  const targetKeys = Object.keys(edge.targets || {});
  console.log(`[GraphCompiler]   Adding conditional edge: ${edge.from} → [${targetKeys.join(', ')}] (with error fallback)`);
  console.log(`[GraphCompiler]     targetMap keys: ${Object.keys(targetMap).join(', ')}`);
  console.log(`[GraphCompiler]     targetMap nodes: ${Object.values(targetMap).join(', ')}`);

  builder.addConditionalEdges(edge.from, conditionFn, targetMap);
}

/**
 * Custom error for graph compilation failures
 */
export class GraphCompilationError extends Error {
  constructor(message: string, public readonly graphId?: string) {
    super(message);
    this.name = 'GraphCompilationError';
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, GraphCompilationError);
    }
  }
}
