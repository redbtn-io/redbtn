/**
 * validateGraphConfig — Dry-Run Graph Validator
 *
 * Runs the same structural checks the JIT compiler runs in
 * `compileGraphFromConfig`, but in collect-all-errors mode without persisting,
 * compiling, or instantiating any LangGraph nodes.
 *
 * Purpose: close the agent's iteration loop. When an LLM-driven agent is
 * authoring a graph config it should be able to call this BEFORE persisting
 * to Mongo so it gets a full diagnostic picture in one shot, not the first
 * error a fail-fast compiler happens to throw.
 *
 * Used by:
 *   - the `validate_graph_config` native tool
 *   - the webapp `create_graph` / `update_graph` paths (writes the result to
 *     `graphCompileLogs` for `get_graph_compile_log` to surface)
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §2 Phase C
 *
 * The compiler still does its own throw-on-first-error pass at runtime — this
 * helper does NOT replace that. It's a richer, lint-style pre-flight check.
 */
import { END } from '@langchain/langgraph';
import type { GraphConfig, GraphEdgeConfig, GraphNodeConfig } from '../types/graph';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning';

export interface ValidationIssue {
  severity: Severity;
  /** Stable machine-readable code so callers can branch / suppress. */
  code: string;
  /** Human-readable message — always actionable. */
  message: string;
  /** Owning node id (if the issue is scoped to a node). */
  nodeId?: string;
  /** Owning edge index (if the issue is scoped to an edge). */
  edgeIndex?: number;
  /** Owning step index inside a node, if applicable. */
  stepIndex?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Optional registry hooks (best-effort; absence is not an error)
// ---------------------------------------------------------------------------

interface NeuronExistenceCheck {
  has(neuronId: string): Promise<boolean> | boolean;
}

interface NodeExistenceCheck {
  has(nodeId: string): Promise<boolean> | boolean;
}

interface ToolExistenceCheck {
  has(toolName: string): boolean;
}

export interface ValidateGraphOptions {
  /**
   * Optional check for neuron existence. If provided, neuron step references
   * to unknown neuronIds become errors. If absent, neuron-id existence is not
   * checked (the runtime will surface its own missing-neuron error).
   */
  neuronCheck?: NeuronExistenceCheck;
  /**
   * Optional check for node existence (the `nodes` collection in MongoDB,
   * NOT the per-graph node array). If provided, graph-step references to
   * unknown nodeIds become errors. If absent, the check is skipped.
   */
  nodeCheck?: NodeExistenceCheck;
  /**
   * Optional check for tool existence (typically the native tool registry).
   * Tools registered at runtime by MCP servers won't be in this set, so a
   * negative is downgraded from error to warning.
   */
  toolCheck?: ToolExistenceCheck;
  /**
   * Optional resolver that returns the underlying node config (with
   * `steps[]`) for a given `nodeId` from the registry. When provided,
   * the validator runs the parallel-write conflict pass: detects state
   * fields written by 2+ branches inside the same parallel block and
   * emits a `PARALLEL_WRITE_CONFLICT` warning per collision. Without
   * this resolver, the analysis is skipped (no false positives from
   * incomplete information).
   */
  nodeResolver?: (
    nodeId: string,
  ) => Promise<{ steps?: unknown[] } | null | undefined> | { steps?: unknown[] } | null | undefined;
  /**
   * Soft cap on template-chain depth for warnings. A reference like
   * `{{state.a.b.c.d.e.f}}` has depth 6 (counting `state.`).
   * Default: 5.
   */
  longTemplateChainThreshold?: number;
}

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

const VALID_STEP_TYPES = new Set([
  'neuron',
  'tool',
  'transform',
  'conditional',
  'loop',
  'delay',
  'connection',
  'graph',
]);

/**
 * The same allowlist the runtime conditionEvaluator uses. We mirror it here
 * (rather than importing it) because the .js evaluator lives in `dist/` and
 * we want this helper to work in the Vitest TypeScript suite without a build
 * step.
 */
const SAFE_CONDITION_PATTERNS: RegExp[] = [
  /^state\.\w+(\.\w+)*$/,
  /^\w+(\.\w+)*$/,
  /^state\.\w+(\.\w+)* (===|!==|>|<|>=|<=) .+$/,
  /^state\.\w+(\.\w+)* && state\.\w+(\.\w+)*$/,
  /^state\.\w+(\.\w+)* \|\| state\.\w+(\.\w+)*$/,
  /^state\.\w+(\.\w+)* && state\.\w+(\.\w+)* (<|>|<=|>=) state\.\w+(\.\w+)*$/,
];

const DANGEROUS_KEYWORDS = ['eval', 'Function', 'constructor', '__proto__', 'prototype'];

function isSafeConditionExpression(expr: string): boolean {
  const trimmed = expr.trim();
  if (!trimmed) return true; // empty expression = "always fall through"
  if (DANGEROUS_KEYWORDS.some(kw => trimmed.includes(kw))) return false;
  return SAFE_CONDITION_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Extract `{{state.a.b.c}}` chains from a template string and return the dot
 * depth (counting `state.` itself). Returns the longest chain length found.
 */
function maxTemplateChainDepth(text: string): number {
  if (typeof text !== 'string') return 0;
  let max = 0;
  // Match anything inside double curlies — ignore `{{state.X}}` formatting flags
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const expr = match[1].trim();
    // Only count expressions that read state — not `parameters.x` or literals
    if (!expr.startsWith('state.') && !expr.startsWith('parameters.')) continue;
    const parts = expr.split('.');
    if (parts.length > max) max = parts.length;
  }
  return max;
}

/** Walk every string-typed field reachable from a JSON-ish value. */
function forEachString(
  value: unknown,
  visit: (s: string, path: string) => void,
  path = '',
): void {
  if (typeof value === 'string') {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      forEachString(value[i], visit, `${path}[${i}]`);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      forEachString(v, visit, path ? `${path}.${k}` : k);
    }
  }
}

/**
 * Resolve a nested mongoose-friendly resolver (sync/async) to a boolean.
 */
async function resolveCheck(
  check: { has(id: string): boolean | Promise<boolean> },
  id: string,
): Promise<boolean> {
  try {
    const out = check.has(id);
    return out instanceof Promise ? await out : Boolean(out);
  } catch {
    return true; // be conservative — registry lookup failure shouldn't block
  }
}

// ---------------------------------------------------------------------------
// Main validator
// ---------------------------------------------------------------------------

/**
 * Validate a graph configuration without persisting or compiling it.
 *
 * Returns ALL issues found — never short-circuits on the first error.
 *
 * Synchronous callers can pass no options and rely on structural checks only.
 * Async callers can pass `neuronCheck` / `nodeCheck` / `toolCheck` to also
 * verify that referenced IDs exist in their respective collections.
 */
export async function validateGraphConfig(
  config: GraphConfig | undefined | null,
  options: ValidateGraphOptions = {},
): Promise<ValidationResult> {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const longThreshold = options.longTemplateChainThreshold ?? 5;

  const err = (issue: Omit<ValidationIssue, 'severity'>) =>
    errors.push({ severity: 'error', ...issue });
  const warn = (issue: Omit<ValidationIssue, 'severity'>) =>
    warnings.push({ severity: 'warning', ...issue });

  // -------------------------------------------------------------------------
  // 1. Top-level shape
  // -------------------------------------------------------------------------
  if (!config || typeof config !== 'object') {
    err({ code: 'MISSING_CONFIG', message: 'Graph config is missing or not an object' });
    return { valid: false, errors, warnings };
  }

  if (!config.graphId || typeof config.graphId !== 'string' || !config.graphId.trim()) {
    err({ code: 'MISSING_GRAPH_ID', message: 'Graph is missing required field: graphId' });
  }

  if (!Array.isArray(config.nodes) || config.nodes.length === 0) {
    err({ code: 'NO_NODES', message: 'Graph must have at least one node' });
  }

  if (!Array.isArray(config.edges) || config.edges.length === 0) {
    err({ code: 'NO_EDGES', message: 'Graph must have at least one edge' });
  }

  // After this point we may operate on partial / empty arrays — guard each loop
  const nodes: GraphNodeConfig[] = Array.isArray(config.nodes) ? config.nodes : [];
  const edges: GraphEdgeConfig[] = Array.isArray(config.edges) ? config.edges : [];

  // -------------------------------------------------------------------------
  // 2. Per-node structural checks
  // -------------------------------------------------------------------------
  const nodeIds: string[] = [];
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const node of nodes) {
    if (!node || typeof node !== 'object') {
      err({
        code: 'BAD_NODE_SHAPE',
        message: `Node entry is not an object: ${JSON.stringify(node)}`,
      });
      continue;
    }
    if (!node.id || typeof node.id !== 'string') {
      err({
        code: 'NODE_MISSING_ID',
        message: `Node is missing required field: id (got ${JSON.stringify(node.id)})`,
      });
      continue;
    }
    if (seenIds.has(node.id)) {
      duplicateIds.add(node.id);
    } else {
      seenIds.add(node.id);
    }
    nodeIds.push(node.id);
  }

  if (duplicateIds.size > 0) {
    err({
      code: 'DUPLICATE_NODE_ID',
      message: `Duplicate node IDs in graph: ${Array.from(duplicateIds).join(', ')}`,
    });
  }

  // -------------------------------------------------------------------------
  // 3. Edge structural checks (pre-compute valid target set)
  // -------------------------------------------------------------------------
  const validTargets = new Set<string>([
    ...nodeIds,
    '__start__',
    '__end__',
    END as string,
  ]);

  // Tracks node ids referenced by an incoming edge — used for the
  // "unused node" warning at the bottom.
  const referencedNodes = new Set<string>();
  // Tracks every parallel block by index → set of join sources we expect.
  const parallelBlocks: Array<{ edgeIndex: number; sources: Set<string> }> = [];
  const joinBlocks: Array<{ edgeIndex: number; sources: Set<string> }> = [];

  edges.forEach((edge, edgeIndex) => {
    if (!edge || typeof edge !== 'object') {
      err({
        code: 'BAD_EDGE_SHAPE',
        edgeIndex,
        message: `Edge[${edgeIndex}] is not an object: ${JSON.stringify(edge)}`,
      });
      return;
    }

    const isJoin = Array.isArray(edge.join);
    const isParallel = Array.isArray(edge.parallel);
    const isConditional = Boolean(edge.condition || edge.targets);

    // ------- `from` ----------------------------------------------------------
    // Join edges legally have no `from` — they are anonymous fan-in barriers.
    if (!isJoin) {
      if (!edge.from) {
        err({
          code: 'EDGE_MISSING_FROM',
          edgeIndex,
          message: `Edge[${edgeIndex}] is missing required field: from`,
        });
      } else if (!validTargets.has(edge.from)) {
        err({
          code: 'EDGE_UNKNOWN_FROM',
          edgeIndex,
          message: `Edge[${edgeIndex}] references unknown source node: '${edge.from}'`,
        });
      }
    }

    // ------- simple `to` ----------------------------------------------------
    if (edge.to && !validTargets.has(edge.to)) {
      err({
        code: 'EDGE_UNKNOWN_TO',
        edgeIndex,
        message: `Edge[${edgeIndex}] references unknown target node: '${edge.to}'`,
      });
    }
    if (edge.to) referencedNodes.add(edge.to);

    // ------- conditional edges ---------------------------------------------
    if (isConditional) {
      const hasTargets = edge.targets && Object.keys(edge.targets).length > 0;
      const hasFallback = Boolean(edge.fallback);

      if (!hasTargets && !edge.to) {
        err({
          code: 'CONDITIONAL_MISSING_TARGETS',
          edgeIndex,
          message: `Conditional edge[${edgeIndex}] (from '${edge.from}') is missing 'targets' map. Provide either targets:{key:nodeId} or a single 'to' target.`,
        });
      }

      if (hasTargets && !hasFallback) {
        warn({
          code: 'CONDITIONAL_MISSING_FALLBACK',
          edgeIndex,
          message: `Conditional edge[${edgeIndex}] (from '${edge.from}') has no 'fallback' — runs that don't match a target key will route to __end__. Add 'fallback' to make routing explicit.`,
        });
      }

      if (edge.targets) {
        for (const [key, target] of Object.entries(edge.targets)) {
          if (!validTargets.has(target)) {
            err({
              code: 'EDGE_UNKNOWN_TARGET',
              edgeIndex,
              message: `Conditional edge[${edgeIndex}] target '${key}' references unknown node: '${target}'`,
            });
          } else {
            referencedNodes.add(target);
          }
        }
      }

      if (edge.fallback && !validTargets.has(edge.fallback)) {
        err({
          code: 'EDGE_UNKNOWN_FALLBACK',
          edgeIndex,
          message: `Conditional edge[${edgeIndex}] fallback references unknown node: '${edge.fallback}'`,
        });
      }
      if (edge.fallback) referencedNodes.add(edge.fallback);

      // Validate the condition expression syntax against the runtime allowlist.
      if (edge.condition && typeof edge.condition === 'string' && edge.condition.trim()) {
        if (!isSafeConditionExpression(edge.condition)) {
          err({
            code: 'CONDITION_BAD_SYNTAX',
            edgeIndex,
            message: `Conditional edge[${edgeIndex}] expression is not safe/parseable by the runtime evaluator: '${edge.condition}'. Allowed shapes: 'state.field', 'state.field === \\'value\\'', 'state.a && state.b', 'state.a || state.b'. For complex logic, compute a flag in a transform step and reference that flag here.`,
          });
        }
      }
    }

    // ------- parallel fan-out -----------------------------------------------
    if (isParallel) {
      if (!edge.parallel || edge.parallel.length === 0) {
        err({
          code: 'PARALLEL_EMPTY',
          edgeIndex,
          message: `Parallel edge[${edgeIndex}] (from '${edge.from}') has empty 'parallel' array — must list at least one target.`,
        });
      } else {
        const sources = new Set<string>();
        for (const target of edge.parallel) {
          sources.add(target);
          if (!validTargets.has(target)) {
            err({
              code: 'PARALLEL_UNKNOWN_TARGET',
              edgeIndex,
              message: `Parallel edge[${edgeIndex}] references unknown target node: '${target}'`,
            });
          } else {
            referencedNodes.add(target);
          }
        }
        parallelBlocks.push({ edgeIndex, sources });
      }
    }

    // ------- join fan-in ----------------------------------------------------
    if (isJoin) {
      if (!edge.join || edge.join.length === 0) {
        err({
          code: 'JOIN_EMPTY',
          edgeIndex,
          message: `Join edge[${edgeIndex}] has empty 'join' array — must list at least one source.`,
        });
      } else {
        const sources = new Set<string>();
        for (const src of edge.join) {
          sources.add(src);
          if (!validTargets.has(src)) {
            err({
              code: 'JOIN_UNKNOWN_SOURCE',
              edgeIndex,
              message: `Join edge[${edgeIndex}] references unknown source node: '${src}'`,
            });
          }
        }
        joinBlocks.push({ edgeIndex, sources });
      }
    }
  });

  // Cross-check parallel/join: every join's sources should be reachable via at
  // least one parallel block (or a chain rooted in one). We verify the simplest
  // case: every join source must appear as a parallel target in at least one
  // parallel block, OR be reachable by a sequential trace from such a target.
  if (joinBlocks.length > 0 && parallelBlocks.length === 0) {
    for (const block of joinBlocks) {
      err({
        code: 'JOIN_WITHOUT_PARALLEL',
        edgeIndex: block.edgeIndex,
        message: `Join edge[${block.edgeIndex}] has no matching 'parallel' edge — fan-in barriers require a fan-out earlier in the graph.`,
      });
    }
  } else {
    // Build a simple set of "nodes reachable from any parallel block by
    // following non-conditional, non-parallel, non-join simple edges". This
    // mirrors the compiler's `traceChain` logic loosely enough to catch the
    // common "join target not in any parallel chain" mistake.
    const reachableFromParallel = new Set<string>();
    for (const block of parallelBlocks) {
      for (const start of block.sources) reachableFromParallel.add(start);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of edges) {
        if (
          edge.from &&
          edge.to &&
          !edge.parallel &&
          !edge.join &&
          !edge.condition &&
          !edge.targets &&
          reachableFromParallel.has(edge.from) &&
          !reachableFromParallel.has(edge.to)
        ) {
          reachableFromParallel.add(edge.to);
          changed = true;
        }
      }
    }

    for (const block of joinBlocks) {
      for (const src of block.sources) {
        if (src === '__start__') continue;
        if (!reachableFromParallel.has(src)) {
          err({
            code: 'JOIN_SOURCE_NOT_PARALLEL',
            edgeIndex: block.edgeIndex,
            message: `Join edge[${block.edgeIndex}] expects source '${src}', but no parallel fan-out reaches that node. Add it to a parallel:[...] block, or remove it from join:[...]`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 4. Step-level checks (per node, per step)
  // -------------------------------------------------------------------------
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;

    // Pull steps from either the inline node config (rare in graph configs)
    // or skip — most graph nodes only contain a `nodeId` reference and the
    // actual steps live in the `nodes` collection. We only validate inline
    // steps here.
    const nodeConfig = node.config as Record<string, unknown> | undefined;
    const inlineSteps = Array.isArray(nodeConfig?.steps)
      ? (nodeConfig.steps as Array<Record<string, unknown>>)
      : [];

    for (let stepIndex = 0; stepIndex < inlineSteps.length; stepIndex++) {
      const step = inlineSteps[stepIndex];
      if (!step || typeof step !== 'object') {
        err({
          code: 'STEP_BAD_SHAPE',
          nodeId: node.id,
          stepIndex,
          message: `Node '${node.id}' step[${stepIndex}] is not an object`,
        });
        continue;
      }

      const stepType = String(step.type || '');
      if (!stepType) {
        err({
          code: 'STEP_MISSING_TYPE',
          nodeId: node.id,
          stepIndex,
          message: `Node '${node.id}' step[${stepIndex}] is missing required field: type`,
        });
        continue;
      }
      if (!VALID_STEP_TYPES.has(stepType)) {
        err({
          code: 'STEP_UNKNOWN_TYPE',
          nodeId: node.id,
          stepIndex,
          message: `Node '${node.id}' step[${stepIndex}] has unknown type: '${stepType}'. Valid: ${Array.from(VALID_STEP_TYPES).join(', ')}`,
        });
        continue;
      }

      const stepConfig = (step.config || {}) as Record<string, unknown>;

      // Neuron step
      if (stepType === 'neuron') {
        const neuronId = stepConfig.neuronId;
        if (neuronId !== undefined) {
          if (typeof neuronId !== 'string' || !neuronId.trim()) {
            err({
              code: 'NEURON_BAD_ID',
              nodeId: node.id,
              stepIndex,
              message: `Node '${node.id}' step[${stepIndex}] neuronId must be a non-empty string when set`,
            });
          } else if (options.neuronCheck) {
            const exists = await resolveCheck(options.neuronCheck, neuronId);
            if (!exists) {
              err({
                code: 'NEURON_UNKNOWN',
                nodeId: node.id,
                stepIndex,
                message: `Node '${node.id}' step[${stepIndex}] references unknown neuronId: '${neuronId}'. Create the neuron via POST /api/v1/neurons or fix the reference.`,
              });
            }
          }
        }
        if (!stepConfig.userPrompt || typeof stepConfig.userPrompt !== 'string') {
          err({
            code: 'NEURON_MISSING_PROMPT',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (neuron) is missing required 'userPrompt'`,
          });
        }
        if (!stepConfig.outputField || typeof stepConfig.outputField !== 'string') {
          err({
            code: 'STEP_MISSING_OUTPUT_FIELD',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (neuron) is missing required 'outputField'`,
          });
        }
      }

      // Tool step
      if (stepType === 'tool') {
        const toolName = stepConfig.toolName;
        if (typeof toolName !== 'string' || !toolName.trim()) {
          err({
            code: 'TOOL_MISSING_NAME',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (tool) is missing required 'toolName'`,
          });
        } else if (options.toolCheck && !options.toolCheck.has(toolName)) {
          // MCP tools may be registered at runtime → warning, not error.
          warn({
            code: 'TOOL_UNKNOWN',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] references unknown tool: '${toolName}'. If this is an MCP tool registered at runtime, ignore this warning. Otherwise, check the spelling or run list_available_tools to see what's registered.`,
          });
        }
        if (!stepConfig.outputField || typeof stepConfig.outputField !== 'string') {
          err({
            code: 'STEP_MISSING_OUTPUT_FIELD',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (tool) is missing required 'outputField'`,
          });
        }
      }

      // Graph step (subgraph invocation)
      if (stepType === 'graph') {
        const graphId = stepConfig.graphId;
        if (typeof graphId !== 'string' || !graphId.trim()) {
          err({
            code: 'GRAPH_STEP_MISSING_ID',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (graph) is missing required 'graphId'`,
          });
        }
        if (!stepConfig.outputField || typeof stepConfig.outputField !== 'string') {
          err({
            code: 'STEP_MISSING_OUTPUT_FIELD',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (graph) is missing required 'outputField'`,
          });
        }
      }

      // Conditional step (intra-node — different from edge conditions)
      if (stepType === 'conditional') {
        const cond = stepConfig.condition;
        if (typeof cond !== 'string' || !cond.trim()) {
          err({
            code: 'CONDITIONAL_STEP_MISSING_CONDITION',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (conditional) is missing required 'condition'`,
          });
        }
        if (!stepConfig.setField || typeof stepConfig.setField !== 'string') {
          err({
            code: 'CONDITIONAL_STEP_MISSING_SET_FIELD',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (conditional) is missing required 'setField'`,
          });
        }
      }

      // Loop step
      if (stepType === 'loop') {
        const max = stepConfig.maxIterations;
        if (typeof max !== 'number' || !Number.isFinite(max) || max < 1) {
          err({
            code: 'LOOP_MISSING_MAX',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (loop) needs 'maxIterations' >= 1 (got ${JSON.stringify(max)})`,
          });
        }
        if (!stepConfig.exitCondition || typeof stepConfig.exitCondition !== 'string') {
          err({
            code: 'LOOP_MISSING_EXIT',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (loop) is missing required 'exitCondition'`,
          });
        }
        if (!Array.isArray(stepConfig.steps) || stepConfig.steps.length === 0) {
          err({
            code: 'LOOP_MISSING_STEPS',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (loop) needs a non-empty 'steps' array`,
          });
        }
      }

      // Connection step
      if (stepType === 'connection') {
        const hasConn =
          (typeof stepConfig.connectionId === 'string' && stepConfig.connectionId.trim()) ||
          (typeof stepConfig.providerId === 'string' && stepConfig.providerId.trim());
        if (!hasConn) {
          err({
            code: 'CONNECTION_MISSING_REF',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (connection) needs either 'connectionId' or 'providerId'`,
          });
        }
        if (!stepConfig.outputField || typeof stepConfig.outputField !== 'string') {
          err({
            code: 'STEP_MISSING_OUTPUT_FIELD',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (connection) is missing required 'outputField'`,
          });
        }
      }

      // Delay step
      if (stepType === 'delay') {
        const ms = stepConfig.ms;
        const isValidNumber = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
        const isRuntimeResolvedString = typeof ms === 'string';
        if (!isValidNumber && !isRuntimeResolvedString) {
          err({
            code: 'DELAY_BAD_MS',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] (delay) needs 'ms' >= 0 or a runtime-resolved string (got ${JSON.stringify(ms)})`,
          });
        }
      }

      // -------- Long-template-chain warning -----------------------------
      forEachString(stepConfig, (s) => {
        const depth = maxTemplateChainDepth(s);
        if (depth > longThreshold) {
          warn({
            code: 'LONG_TEMPLATE_CHAIN',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] template chain depth ${depth} exceeds ${longThreshold}. Consider extracting an intermediate transform step for readability.`,
          });
        }
      });

      // -------- Per-step inline condition syntax check ------------------
      if (typeof step.condition === 'string' && step.condition.trim()) {
        if (!isSafeConditionExpression(step.condition)) {
          err({
            code: 'STEP_CONDITION_BAD_SYNTAX',
            nodeId: node.id,
            stepIndex,
            message: `Node '${node.id}' step[${stepIndex}] condition is not safe/parseable: '${step.condition}'. Use a transform step to compute a flag and reference it here.`,
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 5. Async existence checks for graph-level node references
  // -------------------------------------------------------------------------
  if (options.nodeCheck) {
    for (const node of nodes) {
      const nodeIdRef = (node?.config?.nodeId as string | undefined) ?? node?.id;
      if (!nodeIdRef) continue;
      const exists = await resolveCheck(options.nodeCheck, nodeIdRef);
      if (!exists) {
        err({
          code: 'NODE_UNKNOWN',
          nodeId: node.id,
          message: `Graph node '${node.id}' references unknown nodeId in 'nodes' collection: '${nodeIdRef}'. Create it via POST /api/v1/nodes or fix the reference.`,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 6. Style warnings
  // -------------------------------------------------------------------------

  // Unused (orphaned) nodes — defined but never referenced by any edge target.
  // __start__ is implicitly the entry, so a node only "wired" in by being the
  // target of __start__ is fine. A node can also be the FROM of an edge but
  // never the TO/target of one — that's the orphan case (no incoming).
  for (const node of nodes) {
    if (!node?.id) continue;
    if (!referencedNodes.has(node.id)) {
      warn({
        code: 'NODE_UNREFERENCED',
        nodeId: node.id,
        message: `Node '${node.id}' has no incoming edges. It will never be reached. Add an edge or remove the node.`,
      });
    }
  }

  // Missing description on graph
  if (!config.description || (typeof config.description === 'string' && !config.description.trim())) {
    warn({
      code: 'GRAPH_MISSING_DESCRIPTION',
      message: `Graph has no description. Adding one helps users understand its purpose at a glance.`,
    });
  }

  // Missing graph name
  if (!config.name || (typeof config.name === 'string' && !config.name.trim())) {
    warn({
      code: 'GRAPH_MISSING_NAME',
      message: `Graph has no display name (config.name). The graphId will be shown in the UI as a fallback.`,
    });
  }

  // Tier sanity — runtime errors out at <0 or >4
  if (config.tier !== undefined) {
    if (typeof config.tier !== 'number' || config.tier < 0 || config.tier > 4) {
      err({
        code: 'BAD_TIER',
        message: `Invalid tier: ${config.tier}. Must be a number 0-4 (0=admin, 4=free).`,
      });
    }
  }

  // Very large graph
  if (nodes.length > 20) {
    warn({
      code: 'LARGE_GRAPH',
      message: `Graph has ${nodes.length} nodes — large graphs are harder to debug and maintain. Consider extracting subgraphs via the 'graph' step type.`,
    });
  }

  // Parallel-write conflict pass — only runs when caller supplies a
  // nodeResolver so we can see each graph node's underlying steps[].
  // Webapp wires this via graph-compile-log.ts; agents calling the
  // validate_graph_config tool from inside a graph also get it.
  if (options?.nodeResolver) {
    try {
      const issues = await detectParallelWriteConflicts(
        nodes as GraphNodeConfig[],
        edges as GraphEdgeConfig[],
        parallelBlocks,
        joinBlocks,
        options.nodeResolver,
      );
      for (const issue of issues) {
        if (issue.severity === 'error') errors.push(issue);
        else warnings.push(issue);
      }
    } catch (e) {
      // Conservative: a crash in this analyzer must NOT fail the whole
      // validation. Compile-log still records errors/warnings collected
      // up to this point; the parallel-write pass is purely additive.
      console.warn('[validateGraphConfig] parallel-write pass crashed:', e);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Parallel-write conflict detection
// ---------------------------------------------------------------------------
//
// LangGraph's parallel-branch isolation means each branch sees a snapshot
// taken at the fan-out point and writes are merged at the join. If two
// parallel branches write to the same state field without a reducer, the
// last-write-wins behavior at merge time is non-deterministic — and almost
// always a bug the author didn't notice.
//
// This pass walks each parallel block, traces each branch from its target
// to the join (or graph terminal), collects the set of state fields each
// branch writes via `outputField` on neuron / tool / transform / graph
// steps (recursing into loop bodies), and flags any field written by 2+
// branches.
//
// Fields under `shared.*` and `globalState.*` are exempt — those have
// well-defined cross-branch semantics (Redis hash and Mongo collection
// respectively) and ARE the recommended way to coordinate parallel
// branches. Highlighting them as conflicts would defeat their purpose.

const SAFE_CROSS_BRANCH_PREFIXES = ['shared.', 'globalState.'];

async function detectParallelWriteConflicts(
  nodes: GraphNodeConfig[],
  edges: GraphEdgeConfig[],
  parallelBlocks: Array<{ edgeIndex: number; sources: Set<string> }>,
  joinBlocks: Array<{ edgeIndex: number; sources: Set<string> }>,
  nodeResolver: NonNullable<ValidateGraphOptions['nodeResolver']>,
): Promise<ValidationIssue[]> {
  if (parallelBlocks.length === 0) return [];

  const issues: ValidationIssue[] = [];
  const nodesByGraphId = new Map<string, GraphNodeConfig>();
  for (const n of nodes) nodesByGraphId.set(n.id, n);

  // Cache resolved node steps so a node referenced by multiple graph
  // entries (or multiple branches) only round-trips once per validate call.
  const stepCache = new Map<string, unknown[]>();
  const resolveSteps = async (registryNodeId: string): Promise<unknown[]> => {
    if (stepCache.has(registryNodeId)) return stepCache.get(registryNodeId)!;
    const doc = await nodeResolver(registryNodeId);
    const steps = (doc?.steps as unknown[] | undefined) ?? [];
    stepCache.set(registryNodeId, steps);
    return steps;
  };

  for (const block of parallelBlocks) {
    // Pair each block with its closest join: the first joinBlock whose
    // sources are a subset of nodes reachable from this block's targets.
    // Falls back to "any join in the graph" if no perfect match — that's
    // already an existing-block error caught upstream, but we still want
    // a useful boundary set.
    const allJoinSources = new Set<string>();
    for (const j of joinBlocks) for (const s of j.sources) allJoinSources.add(s);

    // For each branch starting node, collect every reachable graph-node
    // id stopping at any join source (those mark the branch's terminator).
    const branchFields: Array<{
      branchTarget: string;
      // outputField → set of graph-node ids in this branch that write it
      fields: Map<string, Set<string>>;
    }> = [];

    for (const target of block.sources) {
      const reachable = walkBranch(target, edges, allJoinSources);
      const fields = new Map<string, Set<string>>();
      for (const graphNodeId of reachable) {
        const graphNode = nodesByGraphId.get(graphNodeId);
        if (!graphNode) continue;
        // The graph node references a registry node by `config.nodeId`.
        const registryNodeId = (graphNode.config as Record<string, unknown> | undefined)?.nodeId as
          | string
          | undefined;
        if (!registryNodeId) continue;
        let steps: unknown[];
        try {
          steps = await resolveSteps(registryNodeId);
        } catch {
          // Resolver hiccup on this one node — keep going; we'll just
          // miss conflicts that involved its writes.
          continue;
        }
        for (const fld of collectOutputFields(steps)) {
          if (!fields.has(fld)) fields.set(fld, new Set());
          fields.get(fld)!.add(graphNodeId);
        }
      }
      branchFields.push({ branchTarget: target, fields });
    }

    // Aggregate: for each outputField, list which branches write it.
    const fieldOwners = new Map<string, Set<string>>();
    const fieldWriters = new Map<string, Set<string>>(); // field → graph node ids
    for (const { branchTarget, fields } of branchFields) {
      for (const [field, writerNodeIds] of fields) {
        if (!fieldOwners.has(field)) fieldOwners.set(field, new Set());
        if (!fieldWriters.has(field)) fieldWriters.set(field, new Set());
        fieldOwners.get(field)!.add(branchTarget);
        for (const w of writerNodeIds) fieldWriters.get(field)!.add(w);
      }
    }

    for (const [field, branches] of fieldOwners) {
      if (branches.size < 2) continue;
      if (SAFE_CROSS_BRANCH_PREFIXES.some(p => field.startsWith(p))) continue;
      // Ignore fields that only LangGraph itself writes (these are
      // engine-internal and have proper reducers configured).
      if (field === 'messages' || field === 'systemPrefix') continue;
      const writers = fieldWriters.get(field);
      const writerList = writers ? [...writers].join(', ') : '';
      issues.push({
        severity: 'warning',
        code: 'PARALLEL_WRITE_CONFLICT',
        edgeIndex: block.edgeIndex,
        message:
          `Parallel edge[${block.edgeIndex}] has multiple branches writing to '${field}' (writers: ${writerList}). ` +
          `At the join, last-write-wins applies and the result is non-deterministic. ` +
          `Use 'shared.${field.split('.').pop()}' for run-scoped cross-branch coordination, ` +
          `or 'globalState.<ns>.<key>' for cross-run state. ` +
          `If only one branch writes and the others read, this warning is a false positive — ignore it.`,
      });
    }
  }

  return issues;
}

/**
 * Walk forward from a graph node, following sequential `to` and
 * conditional `targets:` edges, until reaching either a join source
 * or an already-visited node (cycle break). Returns the set of graph
 * node ids reachable along this branch — used as the set we'll
 * inspect for outputField writes.
 *
 * Loop fan-outs (parallel:[...]) inside a branch are followed too,
 * since each of their downstream targets still belongs to this branch.
 */
function walkBranch(
  start: string,
  edges: GraphEdgeConfig[],
  joinSources: Set<string>,
): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    if (current === '__end__' || current === '__start__') continue;
    // Stop at the join boundary — anything downstream of the join is
    // post-merge sequential code, not part of THIS branch.
    if (joinSources.has(current) && current !== start) continue;

    for (const edge of edges) {
      if (edge.from !== current) continue;
      if (Array.isArray(edge.join)) continue; // join edges have no `from`
      if (edge.to) queue.push(edge.to);
      if (Array.isArray(edge.parallel)) {
        for (const t of edge.parallel) queue.push(t);
      }
      if (edge.targets) {
        for (const t of Object.values(edge.targets)) queue.push(t as string);
      }
      if (edge.fallback) queue.push(edge.fallback);
    }
  }
  return reachable;
}

/**
 * Recursively collect every `outputField` written by a steps[] tree.
 * Recurses into `loop` step bodies. Skips empty / non-string values.
 */
function collectOutputFields(steps: unknown[]): string[] {
  const out: string[] = [];
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const s = step as Record<string, unknown>;
    const cfg = (s.config as Record<string, unknown> | undefined) ?? undefined;
    const outputField = cfg?.outputField;
    if (typeof outputField === 'string' && outputField.length > 0) {
      out.push(outputField);
    }
    // For transform `set` ops with no outputField, the result merges
    // into top-level state — not tracked as a discrete field write
    // (analysis would require evaluating the value template). Skip.
    if (s.type === 'loop' && cfg && Array.isArray(cfg.steps)) {
      out.push(...collectOutputFields(cfg.steps as unknown[]));
    }
  }
  return out;
}
