/**
 * Graph System Type Definitions
 *
 * Defines the structure for storing and compiling graph configurations.
 * All nodes are universal nodes — the graph compiler routes every node
 * through the same universalNode function, which loads its config from
 * the `nodes` collection in MongoDB by `config.nodeId`.
 */

/**
 * System default graph IDs (Phase 2: Dynamic Graph System)
 * Default graphs are stored with userId: 'system' and isDefault: true in MongoDB
 * These constants provide convenient access to system default graph IDs
 */
export const SYSTEM_TEMPLATES = {
  SIMPLE: 'red-chat',
  DEFAULT: 'red-assistant',
  // Future system graphs:
  // RESEARCH: 'research-assistant',
  // AUTOMATION: 'automation-agent',
  // ENTERPRISE: 'enterprise-workflow'
} as const;

export type SystemTemplateId = typeof SYSTEM_TEMPLATES[keyof typeof SYSTEM_TEMPLATES];

/**
 * Node definition in graph configuration
 */
export interface GraphNodeConfig {
  /** Unique node identifier within the graph (e.g., "context", "router") */
  id: string;
  /** Optional neuron override for this specific node (null = use user default) */
  neuronId?: string | null;
  /**
   * Node configuration — must include nodeId to look up the node config from MongoDB.
   *
   * - nodeId: string - The node to load from the `nodes` collection
   * - parameters?: Record<string, any> - Parameter overrides for this node instance
   *
   * Example:
   * {
   *   nodeId: "router",
   *   parameters: {
   *     temperature: 0.3,
   *     fallbackDecision: "respond"
   *   }
   * }
   */
  config?: {
    nodeId?: string;
    parameters?: Record<string, any>;
    [key: string]: any;
  };
}

/**
 * Edge definition in graph configuration
 * Can be either simple (direct connection), conditional (branching logic),
 * parallel (fan-out to multiple nodes), or join (fan-in barrier).
 */
export interface GraphEdgeConfig {
  /** Source node ID or "__start__". Not required for join edges (use `join` instead). */
  from: string;
  /** Target node ID or "__end__" (for simple edges and join edges) */
  to?: string;
  /** Optional condition expression for conditional edges */
  condition?: string;
  /** For conditional edges: map of condition results to target node IDs */
  targets?: Record<string, string>;
  /** Default target if condition evaluates false or undefined */
  fallback?: string;
  /** Fan-out: fire all listed nodes in parallel */
  parallel?: string[];
  /** Fan-in: wait for all listed sources before firing `to` */
  join?: string[];
}

/**
 * Graph-level configuration options
 */
export interface GraphGlobalConfig {
  /** Maximum number of planner replans allowed (default: 3) */
  maxReplans?: number;
  /** Maximum search loop iterations (default: 5) */
  maxSearchIterations?: number;
  /** Maximum execution time in seconds (default: 300) */
  timeout?: number;
  /** Enable precheck node for pattern matching (default: true) */
  enableFastpath?: boolean;
  /** Default neuron role for nodes without specific assignment */
  defaultNeuronRole?: 'chat' | 'worker' | 'specialist';
}

/**
 * Node position for Studio visual layout
 */
export interface NodePosition {
  x: number;
  y: number;
}

/**
 * Share permission for collaborative editing
 */
export interface SharePermission {
  userId: string;
  permission: 'view' | 'edit';
  sharedAt?: Date;
}

/**
 * Complete graph configuration (stored in MongoDB)
 * This is the authoritative source for graph structure and behavior
 */
export interface GraphConfig {
  /** Unique graph identifier (e.g., "red-graph-default", "user_123_custom") */
  graphId: string;
  /** Owner user ID: "system" for defaults, user ID for custom graphs */
  userId: string;
  /** Graph type: 'responsive' requires input message, 'workflow' can run without input */
  graphType?: 'responsive' | 'workflow';
  /** Input schema for workflows (defines expected input structure) */
  inputSchema?: Record<string, any>;
  /** Default input values (for scheduled/automated workflows) */
  defaultInput?: Record<string, any>;
  /** Output configuration for the graph */
  outputConfig?: {
    streaming?: boolean;
    persistResult?: boolean;
    webhookUrl?: string | null;
    notifyEmail?: string | null;
  };
  /** True for system-provided template graphs */
  isDefault: boolean;
  /** True for protected system graphs */
  isSystem?: boolean;
  /** True if graph cannot be edited directly (must be forked) */
  isImmutable?: boolean;
  /** Parent graph ID if this is a fork/clone */
  parentGraphId?: string;
  /** Display name for UI presentation */
  name: string;
  /** User-facing description of graph purpose */
  description?: string;
  /** Minimum account tier required (AccountLevel enum value) */
  tier: number;
  /** Semantic version for graph updates (default: "1.0.0") */
  version?: string;
  /** All nodes in the graph */
  nodes: GraphNodeConfig[];
  /** All edges (simple and conditional) */
  edges: GraphEdgeConfig[];
  /** Per-node neuron assignments (nodeId → neuronId) */
  neuronAssignments?: Record<string, string>;
  /** Graph-level configuration options */
  config?: GraphGlobalConfig;
  /** Node positions for visual editor (nodeId → {x, y}) */
  layout?: Record<string, NodePosition>;
  /** Base64-encoded thumbnail image for library view */
  thumbnail?: string;
  /** Whether graph is visible in public library */
  isPublic?: boolean;
  /** Original graph ID if this was forked */
  forkedFrom?: string;
  /** Tags for categorization and search */
  tags?: string[];
  /** Users with shared access */
  sharedWith?: SharePermission[];
  /** Creation timestamp */
  createdAt?: Date;
  /** Last update timestamp */
  updatedAt?: Date;
  /** Number of times this graph has been executed */
  usageCount?: number;
}

/**
 * Compiled graph result (runtime representation)
 * Returned by GraphRegistry after JIT compilation
 */
export interface CompiledGraph {
  /** Graph identifier */
  graphId: string;
  /** Original configuration */
  config: GraphConfig;
  /** Compiled LangGraph StateGraph instance */
  graph: any;
  /** Timestamp when graph was compiled */
  compiledAt: Date;
}

/**
 * Type guard to check if a string is a valid system template ID
 */
export function isSystemTemplate(value: string): value is SystemTemplateId {
  return Object.values(SYSTEM_TEMPLATES).includes(value as SystemTemplateId);
}
