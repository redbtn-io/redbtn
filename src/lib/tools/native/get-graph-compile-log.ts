/**
 * Get Graph Compile Log — Native Platform Tool
 *
 * STUB — Phase A.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §3.1, §6 (compile-time error visibility)
 *   - inputs: graphId
 *   - output: { logs: [{level, message, nodeId?}], lastCompiledAt }
 *
 * Phase C will implement `GET /api/v1/graphs/:graphId/compile-log` and have
 * this tool proxy through to it. The endpoint will surface the most recent
 * compile attempt's diagnostics from the LRU cache so agents can debug
 * failures in the closed loop.
 *
 * Until then, this returns NOT_IMPLEMENTED.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const getGraphCompileLogTool: NativeToolDefinition = {
  description:
    'Return the most recent compile-attempt diagnostics for a graph (errors + warnings + lastCompiledAt). Use to debug a failing graph in the closed-loop iteration recipe. (Stub — Phase C will wire this.)',
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId to fetch compile diagnostics for.',
      },
    },
    required: ['graphId'],
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
              'get_graph_compile_log is a Phase A stub. Phase C will implement GET /api/v1/graphs/:graphId/compile-log and proxy it.',
          }),
        },
      ],
      isError: true,
    };
  },
};

export default getGraphCompileLogTool;
module.exports = getGraphCompileLogTool;
