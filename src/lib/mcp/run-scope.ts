/**
 * Run-scoped MCP client.
 *
 * MCP tools are scoped to the account that OWNS THE GRAPH being run: an
 * account-owned MCP connection (registered with `ownerUserId`) is reachable
 * only from that account's graphs, whoever invoked them. Global registrations
 * stay visible to every run.
 *
 * Step executors reach MCP through the object built here (registered on the
 * run context as `mcpClient`), so this is the single place the scope is fixed.
 * It is fixed at run start and cannot be changed by a state-mutating step.
 *
 * @module lib/mcp/run-scope
 */
import type { McpToolScope } from './registry';

export type CallMcpTool = (
  toolName: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  scope: McpToolScope,
) => Promise<unknown>;

/**
 * Resolve the MCP scope for a run: the graph owner, falling back to the run
 * user when the compiled config carries no owner (in-memory/test graphs).
 */
export function resolveRunMcpScope(
  graphConfig: { userId?: unknown } | null | undefined,
  runUserId: unknown,
): McpToolScope {
  const owner = graphConfig?.userId ?? runUserId;
  return owner ? { userId: String(owner) } : {};
}

/** Build the run-context `mcpClient`, bound to one account scope. */
export function createRunMcpClient(callMcpTool: CallMcpTool, scope: McpToolScope) {
  const frozen: McpToolScope = Object.freeze({ ...scope });
  return {
    scope: frozen,
    callTool: (toolName: string, args: unknown, meta?: unknown, signal?: AbortSignal) =>
      callMcpTool(
        toolName,
        args as Record<string, unknown>,
        meta as Record<string, unknown> | undefined,
        signal,
        frozen,
      ),
  };
}
