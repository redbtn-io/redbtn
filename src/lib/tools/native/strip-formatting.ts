/**
 * Strip Formatting — Native Pattern Tool
 *
 * Strip Markdown or HTML formatting from a string and return the plain-text
 * content. Pure utility — no API calls, no side effects.
 *
 * Spec: TOOL-HANDOFF.md §4.6
 *   - inputs: text (required, string),
 *             format (required, 'markdown' | 'html')
 *   - output: { text: string }
 *
 * Implementation:
 *   - Markdown: strip code fences, inline code, bold/italic markers, headings,
 *     blockquotes, list bullets, links/images (keep visible text), tables,
 *     and HTML tags that snuck in. Collapses runs of whitespace.
 *   - HTML: drop `<script>`/`<style>` blocks entirely, decode common HTML
 *     entities, then strip remaining tags. Keeps whitespace conservative.
 *
 * Both branches are intentionally implemented in plain JS / regex so the
 * tool has no third-party dependencies and works in every environment the
 * engine runs in (web worker, edge runtime, etc.).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface StripFormattingArgs {
  text: string;
  format: 'markdown' | 'html';
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

/**
 * Decode the most common HTML entities. Numeric entities (`&#65;`, `&#x41;`)
 * are decoded too. Anything else is left alone.
 */
function decodeHtmlEntities(input: string): string {
  const named: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&nbsp;': ' ',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
    '&hellip;': '…',
    '&mdash;': '—',
    '&ndash;': '–',
    '&lsquo;': '‘',
    '&rsquo;': '’',
    '&ldquo;': '“',
    '&rdquo;': '”',
  };

  let out = input.replace(/&(amp|lt|gt|quot|apos|nbsp|copy|reg|trade|hellip|mdash|ndash|lsquo|rsquo|ldquo|rdquo);/g, (m) => named[m] ?? m);

  // Numeric entities: &#decimal; and &#xHEX;
  out = out.replace(/&#(\d+);/g, (_, n) => {
    const code = parseInt(n, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => {
    const code = parseInt(n, 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : _;
  });

  return out;
}

/**
 * Strip HTML tags. Drops <script>/<style> blocks (including their content),
 * decodes entities, then removes the remaining tags. Whitespace is collapsed
 * but newlines around block-level elements are preserved.
 */
function stripHtml(input: string): string {
  let s = input;

  // Remove script/style blocks entirely (case-insensitive, multiline)
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  // Remove HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // Convert <br> and block-level closes to newlines so plain text stays readable
  s = s.replace(/<br\s*\/?>(\s*)/gi, '\n');
  s = s.replace(
    /<\/(p|div|section|article|header|footer|nav|h[1-6]|li|tr|td|th|blockquote)\s*>/gi,
    '\n',
  );

  // Strip remaining tags
  s = s.replace(/<\/?[^>]+>/g, '');

  // Decode HTML entities
  s = decodeHtmlEntities(s);

  // Collapse runs of whitespace within lines, then trim each line
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n');

  // Collapse 3+ blank lines down to 2
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

/**
 * Strip Markdown formatting. Code blocks become their inner text (no
 * backticks). Inline code, emphasis, headings, quotes, list markers, and
 * link/image syntax are removed. Visible link text is preserved.
 */
function stripMarkdown(input: string): string {
  let s = input;

  // Fenced code blocks: ```lang\n…\n``` → keep inner content
  s = s.replace(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g, (_m, body: string) => body);
  // Indented code blocks (lines starting with 4 spaces or a tab) — leave as-is
  // but strip the marker. (Conservative: many docs want indented samples kept.)

  // Inline code: `foo` → foo
  s = s.replace(/`([^`\n]+)`/g, '$1');

  // Images:  ![alt](url)  → alt
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Images (reference-style): ![alt][ref] → alt
  s = s.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');

  // Links:   [text](url)  → text
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // Links (reference-style): [text][ref] → text
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  // Bare reference definitions: [ref]: http://… → drop entire line
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S.*$/gm, '');

  // Headings: leading ## etc. → strip the markers
  // Use [ \t] not \s to avoid eating newlines (which would collapse blank lines).
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  // Setext headings (=== / --- under text): drop the marker line
  s = s.replace(/^[ \t]{0,3}={3,}[ \t]*$/gm, '');
  s = s.replace(/^[ \t]{0,3}-{3,}[ \t]*$/gm, '');

  // Blockquotes: leading > → drop
  s = s.replace(/^[ \t]{0,3}>[ \t]?/gm, '');

  // Unordered list bullets: -, *, + at start of line → drop
  s = s.replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '');
  // Ordered list markers: 1. / 1) at start of line → drop
  s = s.replace(/^[ \t]{0,3}\d+[.)][ \t]+/gm, '');

  // Tables: pipes and separators → drop pipes, keep cell text
  s = s.replace(/^[ \t]*\|?[ \t]*[-:]+[ \t]*(\|[ \t]*[-:]+[ \t]*)+\|?[ \t]*$/gm, ''); // separator row
  s = s.replace(/\|/g, ' ');

  // Bold / italic / strike — try long-then-short
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1');
  s = s.replace(/___([^_\n]+)___/g, '$1');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/(^|[^*\\])\*([^*\n]+)\*/g, '$1$2');
  s = s.replace(/(^|[^_\\])_([^_\n]+)_/g, '$1$2');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');

  // Horizontal rules (---, ***, ___) → drop
  s = s.replace(/^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');

  // Strip stray HTML tags that may sneak into markdown
  s = s.replace(/<\/?[^>]+>/g, '');
  s = decodeHtmlEntities(s);

  // Tidy whitespace: collapse 3+ newlines, trim each line
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trimEnd())
    .join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

const stripFormattingTool: NativeToolDefinition = {
  description:
    'Strip Markdown or HTML formatting from a string and return the plain-text content. Use before sending text to a system that does not understand formatting (TTS, plain-text logs, embeddings).',
  server: 'pattern',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The formatted source text.',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'html'],
        description:
          'The source format. Pick "markdown" for headings/bullets/links/code-fences, "html" for HTML tags + entities.',
      },
    },
    required: ['text', 'format'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<StripFormattingArgs>;

    if (typeof args.text !== 'string') {
      return validationError('text is required and must be a string');
    }
    if (args.format !== 'markdown' && args.format !== 'html') {
      return validationError(
        'format is required and must be either "markdown" or "html"',
      );
    }

    try {
      const stripped =
        args.format === 'html' ? stripHtml(args.text) : stripMarkdown(args.text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ text: stripped }),
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
              error: `Strip formatting failed: ${message}`,
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default stripFormattingTool;
module.exports = stripFormattingTool;
