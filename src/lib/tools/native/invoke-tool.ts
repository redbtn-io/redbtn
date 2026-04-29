/**
 * Invoke Tool — Native Meta Tool ("tool tools")
 *
 * Dispatch to a registered native tool by name with caller-supplied args.
 * Returns whatever the underlying tool returns, unmodified (same MCP shape:
 * `{ content, isError? }`).
 *
 * Spec: META-PACK-HANDOFF.md §3.3
 *   - inputs:
 *       toolName (required, string)
 *       args     (required, object) — match the tool's inputSchema
 *   - output: pass-through of the underlying tool's NativeMcpResult
 *
 * Safety rules (META-PACK-HANDOFF.md "Critical safety rules"):
 *   1. REFUSE to dispatch to a meta tool — `list_available_tools`,
 *      `get_tool_schema`, or `invoke_tool` itself — to prevent infinite
 *      indirection. Returns `{ isError: true, code: 'META_RECURSION_BLOCKED' }`.
 *   2. Honour `state.toolToolsConfig.{allow, deny}` with glob-style patterns;
 *      deny wins over allow. If neither is set, all tools allowed.
 *   3. Audit-log every dispatch: `[meta-pack] invoking <toolName> via meta dispatch (run=<runId>)`
 *      so post-hoc review of what an agent reached for is easy.
 *
 * Context pass-through:
 *   - The full NativeToolContext is forwarded unchanged to the underlying
 *     tool's handler. That means publisher / runId / state / abortSignal /
 *     credentials all flow through transparently — the dispatched tool
 *     behaves exactly as it would if called directly via the registry.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { getNativeRegistry } from '../native-registry';
import { META_TOOL_NAMES, isAllowed, type ToolToolsConfig } from './list-available-tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface InvokeToolArgs {
  toolName: string;
  args: AnyObject;
}

function errorResult(code: string, message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code }),
      },
    ],
    isError: true,
  };
}

function validationError(message: string): NativeMcpResult {
  return errorResult('VALIDATION', message);
}

/** Defensive read of `state.toolToolsConfig`. */
function readConfig(state: AnyObject | null | undefined): ToolToolsConfig | null {
  if (!state || typeof state !== 'object') return null;
  const cfg = state.toolToolsConfig;
  if (!cfg || typeof cfg !== 'object') return null;
  const out: ToolToolsConfig = {};
  if (Array.isArray(cfg.allow)) {
    out.allow = cfg.allow.filter((x: unknown): x is string => typeof x === 'string');
  }
  if (Array.isArray(cfg.deny)) {
    out.deny = cfg.deny.filter((x: unknown): x is string => typeof x === 'string');
  }
  if (out.allow === undefined && out.deny === undefined) return null;
  return out;
}

const invokeToolTool: NativeToolDefinition = {
  description:
    'Invoke a native tool by name with the given args. Use list_available_tools + get_tool_schema first to discover the tool and construct args correctly. Returns whatever the underlying tool returns.',
  server: 'meta',
  inputSchema: {
    type: 'object',
    required: ['toolName', 'args'],
    properties: {
      toolName: {
        type: 'string',
        description: 'The native tool name to invoke (e.g. "fetch_url").',
      },
      args: {
        type: 'object',
        description: 'Args matching the tool\'s inputSchema.',
        additionalProperties: true,
      },
    },
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<InvokeToolArgs>;

    if (typeof args.toolName !== 'string' || args.toolName.trim().length === 0) {
      return validationError('toolName is required and must be a non-empty string');
    }
    const toolName = args.toolName.trim();

    if (
      args.args === undefined ||
      args.args === null ||
      typeof args.args !== 'object' ||
      Array.isArray(args.args)
    ) {
      return validationError('args is required and must be an object');
    }
    const innerArgs = args.args as AnyObject;

    // Safety rule 1: refuse to dispatch to any of the meta tools — that would
    // enable infinite indirection (`invoke_tool({ toolName: 'invoke_tool' })`)
    // or trivial probes (`invoke_tool({ toolName: 'list_available_tools' })`).
    // The agent already has these wired; it doesn't need to reach them via
    // meta dispatch.
    if (META_TOOL_NAMES.has(toolName)) {
      return errorResult(
        'META_RECURSION_BLOCKED',
        `Refusing to dispatch to meta tool '${toolName}' via invoke_tool — meta tools are not invokable through themselves`,
      );
    }

    // Safety rule 2: state-level allow/deny gating. Same as the listing/schema
    // tools, but here we treat denials as "tool not found" so the agent can't
    // probe the deny list by getting different error codes for missing vs
    // forbidden tools.
    const config = readConfig(context?.state);
    if (!isAllowed(toolName, config)) {
      return errorResult('TOOL_NOT_FOUND', `Tool not found: ${toolName}`);
    }

    const tool = getNativeRegistry().get(toolName);
    if (!tool) {
      return errorResult('TOOL_NOT_FOUND', `Tool not found: ${toolName}`);
    }

    // Safety rule 3: audit log. Always emit BEFORE invoking so the trail
    // captures even tools that hang or throw.
    const runId = context?.runId ?? 'unknown';
    console.log(
      `[meta-pack] invoking ${toolName} via meta dispatch (run=${runId})`,
    );

    try {
      // Pass the context through unchanged — the dispatched tool sees the same
      // publisher / state / runId / abortSignal it would if called directly.
      const result = await tool.handler(innerArgs, context);
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `invoke_tool: dispatched tool '${toolName}' threw: ${message}`,
              code: 'DISPATCH_ERROR',
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default invokeToolTool;
module.exports = invokeToolTool;
