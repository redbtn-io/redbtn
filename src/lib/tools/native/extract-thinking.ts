/**
 * Extract Thinking — Native Pattern Tool
 *
 * Strips DeepSeek-R1 / Qwen-style `<think>…</think>` reasoning tags from a
 * piece of text and returns the thinking and clean content separately.
 * Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.6
 *   - inputs: text (required, string)
 *   - output: { thinking: string, content: string }
 *
 * Implementation:
 *   - Delegates to the engine helper `extractThinking()` in
 *     `redbtn/src/lib/utils/thinking.ts`, which is the same function the
 *     responder, planner, and other LLM-consuming nodes use.
 *   - When the input has no `<think>` tags, returns `{ thinking: '', content: text }`.
 *     (The helper returns `null` for "no thinking found"; the spec wants a
 *     plain string, so we coerce.)
 *   - Multiple `<think>` blocks are concatenated into a single `thinking`
 *     string separated by `\n\n---\n\n` (the helper's existing behaviour).
 *   - Empty input is allowed — returns `{ thinking: '', content: '' }`.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import { extractThinking } from '../../utils/thinking';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ExtractThinkingArgs {
  text: string;
}

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

const extractThinkingTool: NativeToolDefinition = {
  description:
    'Strip <think>...</think> reasoning tags from text and return the thinking and clean content separately. Use to post-process raw LLM output from reasoning models (DeepSeek-R1, Qwen-thinking, etc.).',
  server: 'pattern',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description:
          'The text to scan. Anything wrapped in <think>...</think> is moved into the `thinking` field; the rest is returned as `content` with whitespace tidied.',
      },
    },
    required: ['text'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ExtractThinkingArgs>;

    if (typeof args.text !== 'string') {
      return validationError('text is required and must be a string');
    }

    try {
      const { thinking, cleanedContent } = extractThinking(args.text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              thinking: thinking ?? '',
              content: cleanedContent ?? '',
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
            text: JSON.stringify({
              error: `extractThinking failed: ${message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default extractThinkingTool;
module.exports = extractThinkingTool;
