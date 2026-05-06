/**
 * Parallel Context — graph topology helper
 *
 * Identifies the set of graph node IDs that live inside a `parallel:`
 * block (between any fan-out and the corresponding `join:` source set).
 * The compiler stamps these IDs onto each node's runtime wrapper so
 * universalNode can flip `state._parallelContext` on at step time.
 *
 * Why
 * ───
 * LangGraph isolates branch-local state across parallel branches by
 * design. Configs that need cross-branch coordination either had to
 * use the `state.shared.<key>` namespace explicitly (PR #121) or
 * reach for global state (legacy). With the auto-mirror behavior
 * (PR #125-ish) the engine handles this transparently — but only
 * when it knows which nodes are inside a parallel block.
 *
 * Topology rules
 * ──────────────
 * - A graph node is "in parallel context" if it's reachable from a
 *   `parallel: [...]` target while staying inside the branch.
 * - Walk stops at any `join:` source (= the branch terminator) — but
 *   the join source itself IS still in the branch (the writes that
 *   happen there still need to be visible to peers).
 * - Conditional fan-out (`targets:`) inside a branch is followed too;
 *   all reachable nodes still live inside the branch.
 * - Cycles are guarded via a visited set.
 *
 * Returns an empty set when the graph has no `parallel:` edges.
 */

import type { GraphConfig } from '../types/graph';

export function computeParallelContextNodes(config: GraphConfig): Set<string> {
  const result = new Set<string>();
  const edges = config.edges ?? [];
  if (!edges.some(e => Array.isArray((e as any).parallel))) return result;

  // Collect every node id that's a join source — those are the branch
  // boundaries we stop at.
  const joinSources = new Set<string>();
  for (const edge of edges) {
    if (Array.isArray((edge as any).join)) {
      for (const s of (edge as any).join as string[]) joinSources.add(s);
    }
  }

  // BFS forward from each parallel target, stop at any join source.
  for (const edge of edges) {
    if (!Array.isArray((edge as any).parallel)) continue;
    for (const target of (edge as any).parallel as string[]) {
      walkForward(target, edges, joinSources, result);
    }
  }

  return result;
}

function walkForward(
  start: string,
  edges: GraphConfig['edges'],
  joinSources: Set<string>,
  out: Set<string>,
): void {
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (out.has(current)) continue;
    if (current === '__end__' || current === '__start__') continue;
    out.add(current);
    // Stop traversal AT the join source (current is included; downstream
    // nodes are post-merge and not part of THIS branch).
    if (joinSources.has(current) && current !== start) continue;

    for (const edge of edges) {
      if (edge.from !== current) continue;
      if (Array.isArray((edge as any).join)) continue; // join edges have no `from`
      if (edge.to) queue.push(edge.to);
      if (Array.isArray((edge as any).parallel)) {
        for (const t of (edge as any).parallel as string[]) queue.push(t);
      }
      if ((edge as any).targets) {
        for (const t of Object.values((edge as any).targets as Record<string, string>)) {
          queue.push(t);
        }
      }
      if ((edge as any).fallback) queue.push((edge as any).fallback as string);
    }
  }
}
