/**
 * Run-scoped MCP client.
 *
 * A run may only use MCP connections owned by the account the run EXECUTES
 * AS. That is the run's `userId` — for a user's own graph the owner, for a
 * system graph or a graph shared to someone else the invoking user — or, on a
 * run-as-caller delegated run, the caller (`connectionIdentityUserId`), the
 * same identity the ConnectionManager's ownership gate keys on. Other
 * accounts' connections are never reachable; there are no global ones.
 *
 * Step executors reach MCP through the object built here (registered on the
 * run context as `mcpClient`), so this is the single place the scope is fixed.
 * It is fixed at run start and cannot be changed by a state-mutating step.
 *
 * @module lib/mcp/run-scope
 */
import type { FoundTool, McpToolScope } from './registry';

export type CallMcpTool = (
  toolName: string,
  args: Record<string, unknown>,
  meta: Record<string, unknown> | undefined,
  signal: AbortSignal | undefined,
  scope: McpToolScope,
  serverName?: string,
) => Promise<unknown>;

/** Look a tool up in the registry for one account scope (no network). */
export type FindMcpTool = (toolName: string, scope: McpToolScope, serverName?: string) => FoundTool | undefined;

/**
 * Resolve the MCP scope for a run: the account it executes as. Mirrors
 * `ConnectionManager({ userId: connectionIdentityUserId ?? userId })` in
 * functions/run.ts so MCP connections and OAuth connections resolve against
 * the same identity.
 */
export function resolveRunMcpScope(options: {
  userId?: unknown;
  connectionIdentityUserId?: unknown;
} | null | undefined): McpToolScope {
  const who = options?.connectionIdentityUserId || options?.userId;
  return who ? { userId: String(who) } : {};
}

/**
 * Build the run-context `mcpClient`, bound to one account scope.
 *
 * `findMcpTool` backs `findTool`, which the neuron tool resolver uses to hand
 * the model a tool's real description and input schema. Without it every MCP
 * tool reaches the model as an empty object schema, and the model guesses
 * argument names and types (`channel_id` for `channelId`, a 64-bit Discord id
 * as a JSON number that gets rounded to a different id).
 */
export function createRunMcpClient(callMcpTool: CallMcpTool, scope: McpToolScope, findMcpTool?: FindMcpTool) {
  const frozen: McpToolScope = Object.freeze({ ...scope });
  return {
    scope: frozen,
    callTool: (toolName: string, args: unknown, meta?: unknown, signal?: AbortSignal, serverName?: string) =>
      callMcpTool(
        toolName,
        args as Record<string, unknown>,
        meta as Record<string, unknown> | undefined,
        signal,
        frozen,
        serverName,
      ),
    findTool: (toolName: string, serverName?: string): FoundTool | undefined => (findMcpTool ? findMcpTool(toolName, frozen, serverName) : undefined),
  };
}
