/**
 * Non-vision Fallback Ladder
 *
 * When an image attachment lands on a step whose resolved neuron CANNOT
 * see (per vision-matrix.ts), this module converts the image into something
 * the model CAN consume — text — using one of three strategies:
 *
 *   - `'ocr'`       — OCR each image to extract literal text content,
 *                     wrap in `<image_text>…</image_text>`.
 *   - `'describe'`  — invoke a system vision-capable neuron to produce a
 *                     concise textual description; wrap in
 *                     `<image_description>…</image_description>`. Default.
 *   - `'skip'`      — drop the image silently; the model never sees it.
 *
 * Pure module: no @langchain/openai/ollama imports, no globalState. The
 * caller supplies the OCR + describe functions as injected dependencies.
 * Used by the neuron executor in the future wiring (see
 * explanations/MEDIA-MULTIMODAL-PATCH-PLAN.md §Phase 10 wiring point).
 */

import type { AttachmentRef } from '../nodes/universal/executors/multimodalMessage';

export type ImageFallbackMode = 'ocr' | 'describe' | 'skip';

/** Default mode when `imageFallback` is unset on a NeuronStepConfig. */
export const DEFAULT_IMAGE_FALLBACK: ImageFallbackMode = 'describe';

export interface ImageFallbackDeps {
  /**
   * Runs OCR on a single image attachment, returning the extracted text.
   * Required when mode is `'ocr'`. The caller decides whether to back
   * this with the `parse_document` native tool, a server-side OCR service,
   * or a small vision-LLM round-trip — the helper is agnostic.
   */
  ocrFn?: (attachment: AttachmentRef) => Promise<string>;
  /**
   * Invokes a vision-capable system neuron to produce a textual
   * description of the image. Required when mode is `'describe'`.
   */
  describeFn?: (attachment: AttachmentRef) => Promise<string>;
}

export interface ImageFallbackResult {
  /**
   * Text to inject into the user message in place of (or in addition to)
   * the prompt. Empty string when mode is `'skip'` or when no images were
   * present. The caller appends this to the existing prompt.
   */
  injectedText: string;
  /**
   * Whether image attachments should be removed from the message
   * (true for all three fallback modes when images are present;
   *  false when no image attachments existed in the first place).
   */
  dropImageAttachments: boolean;
  /**
   * Per-image transcript — useful for logging and for tests. Each entry
   * is the text the fallback produced for that image (or '' if skipped).
   */
  perImageTexts: string[];
}

function isImageAttachment(a: AttachmentRef): boolean {
  return a.kind === 'image' || (a.mimeType ?? '').startsWith('image/');
}

/**
 * Run the fallback ladder over a list of attachments.
 *
 * Throws when `mode` is `'ocr'` or `'describe'` but the corresponding
 * dependency function is missing — silent failures here would surface
 * later as garbled user messages and are worth catching loudly.
 *
 * Returns `{ injectedText: '', dropImageAttachments: false, perImageTexts: [] }`
 * when no image attachments are present (no-op safe path).
 */
export async function runImageFallback(
  attachments: AttachmentRef[],
  mode: ImageFallbackMode = DEFAULT_IMAGE_FALLBACK,
  deps: ImageFallbackDeps = {},
): Promise<ImageFallbackResult> {
  const images = attachments.filter(isImageAttachment);
  if (images.length === 0) {
    return { injectedText: '', dropImageAttachments: false, perImageTexts: [] };
  }

  if (mode === 'skip') {
    return {
      injectedText: '',
      dropImageAttachments: true,
      perImageTexts: images.map(() => ''),
    };
  }

  if (mode === 'ocr') {
    if (!deps.ocrFn) {
      throw new Error("imageFallback: mode='ocr' requires deps.ocrFn");
    }
    const ocrFn = deps.ocrFn;
    const texts = await Promise.all(
      images.map(async (a, idx) => {
        try {
          return await ocrFn(a);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Never propagate — degrade to an empty extraction with a marker
          // so the caller's text-only path still produces a response.
          return `[OCR failed for image ${idx}: ${msg}]`;
        }
      }),
    );
    return {
      injectedText: texts
        .map((t, i) => `<image_text index="${i}">\n${t}\n</image_text>`)
        .join('\n\n'),
      dropImageAttachments: true,
      perImageTexts: texts,
    };
  }

  // mode === 'describe'
  if (!deps.describeFn) {
    throw new Error("imageFallback: mode='describe' requires deps.describeFn");
  }
  const describeFn = deps.describeFn;
  const descs = await Promise.all(
    images.map(async (a, idx) => {
      try {
        return await describeFn(a);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return `[image ${idx} description unavailable: ${msg}]`;
      }
    }),
  );
  return {
    injectedText: descs
      .map((d, i) => `<image_description index="${i}">\n${d}\n</image_description>`)
      .join('\n\n'),
    dropImageAttachments: true,
    perImageTexts: descs,
  };
}

/**
 * Convenience: apply the fallback result to a prompt string. Returns the
 * combined text the caller should hand to the LLM (fallback injection
 * prepended on a blank line above the user's prompt, mimicking how
 * `<context>` blocks are typically threaded into prompts).
 */
export function applyImageFallback(prompt: string, result: ImageFallbackResult): string {
  if (!result.injectedText) return prompt;
  if (!prompt) return result.injectedText;
  return `${result.injectedText}\n\n${prompt}`;
}
