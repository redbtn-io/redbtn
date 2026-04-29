/**
 * Get Tool Schema — Native Meta Tool ("tool tools")
 *
 * Inspect a single native tool's input schema. Call after `list_available_tools`
 * once you've picked a tool name and need to construct args for `invoke_tool`.
 *
 * Spec: META-PACK-HANDOFF.md §3.2
 *   - inputs: toolName (required, string)
 *   - output: { name, description, server, inputSchema }
 *
 * Behaviour:
 *   - `getNativeRegistry().get(toolName)`
 *   - Not found             → isError, code: 'TOOL_NOT_FOUND'
 *   - Denied by config      → same shape as not-found (don't reveal existence)
 *   - Asking for a meta tool → refuse with code: 'META_TOOL_NOT_INTROSPECTABLE'
 *
 * Why don't we expose the meta tools' schemas? Because the calling agent ALREADY
 * has them wired (otherwise this very call wouldn't be possible). Hiding them
 * from `get_tool_schema` mirrors the same hide-from-`list_available_tools`
 * behaviour and prevents trivial recursion attempts (`invoke_tool('invoke_tool')`
 * is also blocked one layer down).
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

interface GetToolSchemaArgs {
  toolName: string;
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

const getToolSchemaTool: NativeToolDefinition = {
  description:
    'Get the input schema for a specific tool. Call after list_available_tools when you know the tool name and need to construct args for invoke_tool.',
  server: 'meta',
  inputSchema: {
    type: 'object',
    required: ['toolName'],
    properties: {
      toolName: {
        type: 'string',
        description: 'The native tool name to introspect (e.g. "fetch_url").',
      },
    },
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<GetToolSchemaArgs>;

    if (typeof args.toolName !== 'string' || args.toolName.trim().length === 0) {
      return validationError('toolName is required and must be a non-empty string');
    }
    const toolName = args.toolName.trim();

    // Refuse to introspect the meta tools themselves — the agent already has
    // them wired (otherwise this call wouldn't have been possible).
    if (META_TOOL_NAMES.has(toolName)) {
      return errorResult(
        'META_TOOL_NOT_INTROSPECTABLE',
        `Cannot introspect meta tool '${toolName}' — it's already wired into the agent`,
      );
    }

    const config = readConfig(context?.state);

    // Apply deny/allow BEFORE the registry lookup so the response is identical
    // to the not-found case — denied tools must not reveal their existence.
    if (!isAllowed(toolName, config)) {
      return errorResult('TOOL_NOT_FOUND', `Tool not found: ${toolName}`);
    }

    try {
      const tool = getNativeRegistry().get(toolName);
      if (!tool) {
        return errorResult('TOOL_NOT_FOUND', `Tool not found: ${toolName}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              name: toolName,
              description: tool.description,
              server: tool.server || 'system',
              inputSchema: tool.inputSchema,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: `get_tool_schema failed: ${message}` }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default getToolSchemaTool;
module.exports = getToolSchemaTool;
