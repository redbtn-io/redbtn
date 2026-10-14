/**
 * Describe an image in words, for a model that cannot see the pixels.
 *
 * This is the `describe` rung of the non-vision fallback ladder
 * (lib/neurons/imageFallback.ts), wired for TOOL results: when an image comes
 * back from a tool (`view_image`, a screenshot) and the consuming model is
 * blind to images in tool results, a vision model writes a faithful
 * description (all visible text verbatim, layout, colours, anything broken)
 * that is handed to the blind model as text instead.
 *
 * Backed by Gemini on the platform GOOGLE_API_KEY.
 * Model: VIEW_IMAGE_DESCRIBE_MODEL (default gemini-2.5-flash).
 */

export const DEFAULT_DESCRIBE_MODEL = 'gemini-2.5-flash';
const DESCRIBE_TIMEOUT_MS = 60_000;

export const DESCRIBE_PROMPT = [
  'You are the eyes of a software engineer who cannot see this image.',
  'Describe it so they can act on it without ever looking at it:',
  '1. What it is (screenshot of which kind of screen/app, photo, diagram, error, ...).',
  '2. ALL visible text, transcribed verbatim and in reading order (titles, labels, buttons, numbers, error messages, code).',
  '3. Layout and visual details: positions, colours (name them), sizes, icons, overlapping or cut-off elements, empty or broken areas.',
  '4. Anything that looks wrong, inconsistent or unexpected.',
  'Be precise and complete. No preamble.',
].join('\n');

export type DescribeImageFn = (image: { data: string; mimeType: string }, hint?: string) => Promise<string>;

/** Gemini-backed describer. Throws a CONFIGURATION error when no key is set. */
export const describeImageWithGemini: DescribeImageFn = async (image, hint) => {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GOOGLE_API_KEY is not set; cannot describe the image') as Error & { code?: string };
    err.code = 'CONFIGURATION';
    throw err;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.VIEW_IMAGE_DESCRIBE_MODEL || DEFAULT_DESCRIBE_MODEL;
  const call = ai.models.generateContent({
    model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: image.mimeType, data: image.data } },
        { text: hint ? `${DESCRIBE_PROMPT}\nContext: ${hint}` : DESCRIBE_PROMPT },
      ],
    }],
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`image description timed out after ${DESCRIBE_TIMEOUT_MS} ms`)), DESCRIBE_TIMEOUT_MS);
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: any = await Promise.race([call, timeout]);
    const text: string =
      (typeof res?.text === 'string' && res.text) ||
      (res?.candidates?.[0]?.content?.parts ?? [])
        .map((p: { text?: string }) => p?.text || '')
        .join('');
    if (!text.trim()) throw new Error('vision model returned an empty description');
    return text.trim();
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpBlock = Record<string, any>;

/**
 * Replace (or annotate) every MCP image block in a tool result with a text
 * description. `mode: 'replace'` drops the pixels (blind consumer: they would
 * only cost tokens or break it); `mode: 'append'` keeps them and adds the text.
 * Returns the result unchanged when it carries no image. Never throws: a
 * failed description becomes a text block saying so.
 */
export async function describeToolResultImages<T>(
  result: T,
  mode: 'replace' | 'append',
  describe: DescribeImageFn = describeImageWithGemini,
): Promise<T> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = result as any;
  if (!r || typeof r !== 'object' || !Array.isArray(r.content)) return result;
  const blocks: McpBlock[] = r.content;
  if (!blocks.some((b) => b && b.type === 'image' && typeof b.data === 'string')) return result;

  let n = 0;
  const out: McpBlock[] = [];
  for (const b of blocks) {
    if (!(b && b.type === 'image' && typeof b.data === 'string')) {
      out.push(b);
      continue;
    }
    n++;
    if (mode === 'append') out.push(b);
    let text: string;
    try {
      const d = await describe({ data: b.data, mimeType: typeof b.mimeType === 'string' ? b.mimeType : 'image/png' });
      text = `<image_description index="${n}">\n${d}\n</image_description>`;
    } catch (err) {
      text = `[image ${n}: a vision model could not describe it (${err instanceof Error ? err.message : String(err)}). You cannot see this image; say so in your report.]`;
    }
    out.push({ type: 'text', text });
  }
  return { ...r, content: out } as T;
}
