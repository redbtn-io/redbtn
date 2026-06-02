/**
 * Run-context lookup helpers.
 *
 * Read run-scoped infrastructure objects (RunPublisher, NeuronRegistry,
 * MCP client, etc.) without putting them in LangGraph state. Each helper
 * resolves in the same order:
 *
 *   1. Look up the registry by `state.runId` (or `state.data.runId`).
 *   2. Fall back to `state.<field>` for direct callers / unit tests that
 *      hand-build a state object and never registered a run.
 *
 * The registry lives in this worker process, so the objects survive any
 * checkpoint round-trip — only the primitive `runId` flows through
 * checkpoints, and the registry rehydrates everything else from runId.
 *
 * See `RunControlRegistry.ts` for the rationale on why this pattern exists
 * (it's the same shape `_abortController` already uses via `getRunSignal`).
 */
import { runControlRegistry } from './RunControlRegistry';

function resolveRunId(state: any): string | undefined {
  return state?.runId || state?.data?.runId;
}

export function getRunPublisher(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.runPublisher ?? state?.runPublisher;
}

export function getNeuronRegistry(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.neuronRegistry ?? state?.neuronRegistry;
}

export function getMcpClient(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.mcpClient ?? state?.mcpClient;
}

export function getMemory(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.memory ?? state?.memory;
}

export function getConnectionManager(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.connectionManager ?? state?.connectionManager;
}

export function getGraphRegistry(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.graphRegistry ?? state?._graphRegistry;
}

export function getMcpRegistry(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.mcpRegistry ?? state?.mcpRegistry;
}

export function getLogger(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.logger ?? state?.logger;
}

export function getGraphPublisher(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.graphPublisher ?? state?.graphPublisher;
}

/** redToken usage-metering client. Used by neuronExecutor to emit one usage
 *  event per LLM call. Returns undefined when metering isn't wired (direct/test
 *  callers, or init failure) — callers must treat it as optional + fail-safe. */
export function getMeteringClient(state: any): any | undefined {
  const ctx = runControlRegistry.get(resolveRunId(state));
  return ctx?.meteringClient ?? state?.meteringClient;
}
