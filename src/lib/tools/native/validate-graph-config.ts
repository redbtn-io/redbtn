/**
 * Validate Graph Config — Native Platform Tool
 *
 * STUB — Phase A.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1, §6 (validation)
 *   - inputs: config: GraphConfig
 *   - output: { valid, errors, warnings }
 *
 * Phase C will implement this by running the engine compiler in dry-run mode
 * against the unsaved config — catching bad edges, missing referenced
 * nodeIds, malformed condition expressions, etc. — without persisting.
 *
 * Until then, this returns NOT_IMPLEMENTED so callers (and the meta-pack
 * `list_available_tools`) can see the tool exists in the catalogue but get a
 * clear failure if they actually invoke it. The stub is intentionally
 * deterministic so tests can pin its shape across Phase A/B/C swaps.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const validateGraphConfigTool: NativeToolDefinition = {
  description:
    'Dry-run the graph compiler against a config and return errors/warnings WITHOUT persisting. Catches bad edges, missing nodeIds, malformed conditions. (Stub — Phase C will wire this.)',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description: 'GraphConfig to validate. Same shape as create_graph.config.',
      },
    },
    required: ['config'],
  },

  async handler(_rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: 'Phase C will wire this',
            code: 'NOT_IMPLEMENTED',
            message:
              'validate_graph_config is a Phase A stub. Phase C will implement engine-side dry-run validation.',
          }),
        },
      ],
      isError: true,
    };
  },
};

export default validateGraphConfigTool;
