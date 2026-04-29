/**
 * Validate Graph Config — Native Platform Pack Tool
 *
 * Runs the structural validator (`validateGraphConfig`) against a candidate
 * graph config and returns all errors + warnings WITHOUT persisting or
 * compiling the graph.
 *
 * Spec: PLATFORM-PACK-HANDOFF.md §2 Phase C + §3.1
 *
 *   - inputs:  { config: GraphConfig }
 *   - output:  { valid: boolean, errors: ValidationIssue[], warnings: ValidationIssue[] }
 *
 * Closes the agent's iteration loop:
 *   1. Agent drafts a graph config.
 *   2. Agent calls validate_graph_config(config) → gets the full diagnostic
 *      picture (errors + warnings) in ONE shot.
 *   3. Agent fixes issues, re-validates.
 *   4. Agent calls create_graph(config) → safe to persist.
 *
 * Supersedes the Phase A stub of the same name (the stub returned
 * NOT_IMPLEMENTED). Registration block in native-registry.ts is shared with
 * the Phase A platform pack — see the comment there.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  validateGraphConfig,
  type ValidateGraphOptions,
  type ValidationResult,
} from '../../graphs/validateGraphConfig';
import { getNativeRegistry } from '../native-registry';
import type { GraphConfig } from '../../types/graph';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ValidateGraphConfigArgs {
  config: GraphConfig;
}

/**
 * Lazy node-existence check via the engine's mongoose connection. Returns
 * undefined if mongoose isn't connected — the validator just skips the
 * existence check in that case (it still does all structural checks).
 */
function makeNodeCheck(): NonNullable<ValidateGraphOptions['nodeCheck']> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (!mongoose?.connection?.readyState) return undefined;
    return {
      async has(nodeId: string): Promise<boolean> {
        try {
          const Model =
            mongoose.models['_PlatformPackNode'] ||
            mongoose.model(
              '_PlatformPackNode',
              new mongoose.Schema({}, { collection: 'nodes', strict: false }),
            );
          const doc = await Model.findOne({ nodeId }).select({ _id: 1 }).lean().exec();
          return !!doc;
        } catch {
          // Be conservative: don't surface false-negatives if Mongo is flaky.
          return true;
        }
      },
    };
  } catch {
    return undefined;
  }
}

function makeNeuronCheck(): NonNullable<ValidateGraphOptions['neuronCheck']> | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (!mongoose?.connection?.readyState) return undefined;
    return {
      async has(neuronId: string): Promise<boolean> {
        try {
          const Model =
            mongoose.models['_PlatformPackNeuron'] ||
            mongoose.model(
              '_PlatformPackNeuron',
              new mongoose.Schema({}, { collection: 'neurons', strict: false }),
            );
          const doc = await Model.findOne({ neuronId }).select({ _id: 1 }).lean().exec();
          return !!doc;
        } catch {
          return true;
        }
      },
    };
  } catch {
    return undefined;
  }
}

function makeToolCheck(): NonNullable<ValidateGraphOptions['toolCheck']> {
  const registry = getNativeRegistry();
  return { has: (toolName: string) => registry.has(toolName) };
}

const validateGraphConfigTool: NativeToolDefinition = {
  description:
    "Run a dry-run validator against a graph config and get back ALL errors + warnings (does not stop on first error) WITHOUT persisting or compiling. Use BEFORE create_graph / update_graph to catch missing references, bad condition expressions, unwired join edges, and stylistic issues. Returns { valid, errors[], warnings[] } where each issue has { severity, code, message, nodeId?, edgeIndex?, stepIndex? }.",
  server: 'platform',
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        description:
          'The full graph configuration (same shape that create_graph accepts). Must include graphId, nodes[], and edges[]. Other fields (name, description, tier, isPublic, etc.) are optional but checked for warnings.',
        additionalProperties: true,
      },
    },
    required: ['config'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ValidateGraphConfigArgs>;
    const config = args.config;

    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'config is required and must be a graph config object',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const options: ValidateGraphOptions = {
      toolCheck: makeToolCheck(),
    };
    const nodeCheck = makeNodeCheck();
    if (nodeCheck) options.nodeCheck = nodeCheck;
    const neuronCheck = makeNeuronCheck();
    if (neuronCheck) options.neuronCheck = neuronCheck;

    let result: ValidationResult;
    try {
      result = await validateGraphConfig(config as GraphConfig, options);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `validator crashed: ${message}`,
              code: 'INTERNAL',
            }),
          },
        ],
        isError: true,
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    };
  },
};

export default validateGraphConfigTool;
module.exports = validateGraphConfigTool;
