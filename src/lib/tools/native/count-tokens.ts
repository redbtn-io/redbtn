/**
 * Count Tokens — Native Pattern Tool
 *
 * Count the number of tokens in a string for a given LLM tokenizer.
 * Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.6
 *   - inputs: text (required, string),
 *             model? (string, default 'gpt-4')
 *   - output: { tokens: number, model: string }
 *
 * Implementation:
 *   - Tries to use `tiktoken` for accuracy. The engine helper
 *     `redbtn/src/lib/utils/tokenizer.ts` already encapsulates the
 *     "tiktoken if available, fallback to ~4-chars-per-token estimate"
 *     pattern, but it hard-codes the `gpt-4` encoder. We mirror that
 *     behaviour for the default and accept any model string for forward
 *     compatibility — when an unknown model is requested we still return
 *     a count via the fallback estimator and report which model name was
 *     used.
 *   - Empty string → `{ tokens: 0, model }`.
 *   - The fallback estimate (Math.ceil(text.length / 4)) is documented in
 *     the helper itself and is the same heuristic OpenAI publishes for
 *     rough token counting.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { countTokens as countTokensHelper } from '../../utils/tokenizer';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CountTokensArgs {
  text: string;
  model?: string;
}

const DEFAULT_MODEL = 'gpt-4';

function validationError(message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

/**
 * Try to count tokens with a model-specific tiktoken encoder. Falls back to
 * the engine helper (which itself falls back to a 4-chars-per-token estimate
 * if tiktoken isn't installed).
 */
async function countWithModel(text: string, model: string): Promise<number> {
  // Fast path: empty
  if (text.length === 0) return 0;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tiktoken = await import('tiktoken');
    const encodingFn = (tiktoken as AnyObject).encoding_for_model;
    if (typeof encodingFn === 'function') {
      try {
        const enc = encodingFn(model);
        try {
          const tokens = enc.encode(text).length;
          return tokens;
        } finally {
          try { enc.free(); } catch { /* ignore */ }
        }
      } catch {
        // Unknown model — fall through to helper estimate
      }
    }
  } catch {
    // tiktoken not installed — helper already handles this case
  }

  return countTokensHelper(text);
}

const countTokensTool: NativeToolDefinition = {
  description:
    'Count the number of tokens in a string for a given model tokenizer (default: gpt-4). Use to budget context windows or estimate API costs before issuing an LLM call.',
  server: 'pattern',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to tokenise.',
      },
      model: {
        type: 'string',
        description:
          'Optional model name to pick the tokenizer (e.g. "gpt-4", "gpt-3.5-turbo"). Defaults to "gpt-4".',
        default: DEFAULT_MODEL,
      },
    },
    required: ['text'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CountTokensArgs>;

    if (typeof args.text !== 'string') {
      return validationError('text is required and must be a string');
    }
    const model =
      typeof args.model === 'string' && args.model.trim().length > 0
        ? args.model.trim()
        : DEFAULT_MODEL;

    try {
      const tokens = await countWithModel(args.text, model);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ tokens, model }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Token count failed: ${message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default countTokensTool;
module.exports = countTokensTool;
