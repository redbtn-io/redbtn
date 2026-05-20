/**
 * Phase 9 — media-nonvision-fallback
 *
 * Acceptance: tests cover each mode — OCR injects extracted text,
 * describe-then-inject substitutes a textual description, skip drops the
 * attachment cleanly; sending an image to a non-vision agent produces a
 * coherent response and never errors.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runImageFallback,
  applyImageFallback,
  DEFAULT_IMAGE_FALLBACK,
  type ImageFallbackMode,
} from '../../src/lib/neurons/imageFallback';
import type { AttachmentRef } from '../../src/lib/nodes/universal/executors/multimodalMessage';

const img1: AttachmentRef = {
  kind: 'image',
  mimeType: 'image/png',
  url: 'https://x/a.png',
  filename: 'a.png',
};
const img2: AttachmentRef = {
  kind: 'image',
  mimeType: 'image/jpeg',
  url: 'https://x/b.jpg',
  filename: 'b.jpg',
};
const docRef: AttachmentRef = {
  kind: 'document',
  mimeType: 'application/pdf',
  url: 'https://x/c.pdf',
};

describe('runImageFallback — defaults', () => {
  it("the default mode is 'describe'", () => {
    expect(DEFAULT_IMAGE_FALLBACK).toBe('describe');
  });

  it('no image attachments → no-op (drop:false, no injected text)', async () => {
    const out = await runImageFallback([], 'describe', { describeFn: vi.fn() });
    expect(out.injectedText).toBe('');
    expect(out.dropImageAttachments).toBe(false);
    expect(out.perImageTexts).toEqual([]);
  });

  it('only non-image attachments → no-op', async () => {
    const out = await runImageFallback([docRef], 'describe', { describeFn: vi.fn() });
    expect(out.dropImageAttachments).toBe(false);
    expect(out.injectedText).toBe('');
  });
});

describe('runImageFallback — skip mode', () => {
  it('drops images silently with no injected text', async () => {
    const out = await runImageFallback([img1, img2], 'skip');
    expect(out.dropImageAttachments).toBe(true);
    expect(out.injectedText).toBe('');
    expect(out.perImageTexts).toEqual(['', '']);
  });

  it('does NOT require any dep functions', async () => {
    // No throw when deps is empty — the helper only consults deps for
    // ocr/describe modes.
    await expect(runImageFallback([img1], 'skip')).resolves.toMatchObject({
      dropImageAttachments: true,
    });
  });
});

describe('runImageFallback — ocr mode', () => {
  it('calls ocrFn for each image and injects extracted text', async () => {
    const ocrFn = vi.fn(async (a: AttachmentRef) =>
      a.url === img1.url ? 'TEXT_FROM_IMAGE_1' : 'TEXT_FROM_IMAGE_2',
    );
    const out = await runImageFallback([img1, img2], 'ocr', { ocrFn });

    expect(ocrFn).toHaveBeenCalledTimes(2);
    expect(out.dropImageAttachments).toBe(true);
    expect(out.perImageTexts).toEqual(['TEXT_FROM_IMAGE_1', 'TEXT_FROM_IMAGE_2']);
    // Each image is wrapped in <image_text index="N">…</image_text> joined by \n\n.
    expect(out.injectedText).toBe(
      '<image_text index="0">\nTEXT_FROM_IMAGE_1\n</image_text>\n\n' +
      '<image_text index="1">\nTEXT_FROM_IMAGE_2\n</image_text>',
    );
  });

  it("throws when ocrFn is missing", async () => {
    await expect(runImageFallback([img1], 'ocr')).rejects.toThrow(/requires deps.ocrFn/);
  });

  it('survives a per-image OCR failure with a marker (never errors out)', async () => {
    const ocrFn = vi.fn(async (a: AttachmentRef) => {
      if (a.url === img1.url) throw new Error('boom');
      return 'ok';
    });
    const out = await runImageFallback([img1, img2], 'ocr', { ocrFn });
    expect(out.dropImageAttachments).toBe(true);
    expect(out.perImageTexts[0]).toMatch(/OCR failed for image 0/);
    expect(out.perImageTexts[1]).toBe('ok');
    // The caller's text-only response path still has something to render.
    expect(out.injectedText).toContain('<image_text index="0">');
    expect(out.injectedText).toContain('<image_text index="1">');
  });
});

describe('runImageFallback — describe mode', () => {
  it('invokes describeFn for each image and injects a description', async () => {
    const describeFn = vi.fn(async (a: AttachmentRef) =>
      a.url === img1.url ? 'a black cat on a chair' : 'a red rose',
    );
    const out = await runImageFallback([img1, img2], 'describe', { describeFn });

    expect(describeFn).toHaveBeenCalledTimes(2);
    expect(out.dropImageAttachments).toBe(true);
    expect(out.perImageTexts).toEqual(['a black cat on a chair', 'a red rose']);
    expect(out.injectedText).toBe(
      '<image_description index="0">\na black cat on a chair\n</image_description>\n\n' +
      '<image_description index="1">\na red rose\n</image_description>',
    );
  });

  it("throws when describeFn is missing", async () => {
    await expect(runImageFallback([img1], 'describe')).rejects.toThrow(/requires deps.describeFn/);
  });

  it('survives a per-image describe failure with a marker', async () => {
    const describeFn = vi.fn(async () => {
      throw new Error('vision-neuron timeout');
    });
    const out = await runImageFallback([img1], 'describe', { describeFn });
    expect(out.perImageTexts[0]).toMatch(/description unavailable: vision-neuron timeout/);
    expect(out.injectedText).toContain('<image_description index="0">');
  });
});

describe('applyImageFallback — prompt composition', () => {
  it('prepends the injected text to the prompt with a blank-line bridge', () => {
    expect(
      applyImageFallback('what is this?', {
        injectedText: '<image_description index="0">\nA cat.\n</image_description>',
        dropImageAttachments: true,
        perImageTexts: ['A cat.'],
      }),
    ).toBe(
      '<image_description index="0">\nA cat.\n</image_description>\n\nwhat is this?',
    );
  });

  it('returns the prompt unchanged when injectedText is empty (skip mode regression)', () => {
    expect(
      applyImageFallback('explain', { injectedText: '', dropImageAttachments: false, perImageTexts: [] }),
    ).toBe('explain');
  });

  it('returns just the injected text when prompt is empty', () => {
    expect(
      applyImageFallback('', {
        injectedText: '<image_text index="0">\nhi\n</image_text>',
        dropImageAttachments: true,
        perImageTexts: ['hi'],
      }),
    ).toBe('<image_text index="0">\nhi\n</image_text>');
  });
});

describe('end-to-end: a non-vision agent sees coherent text and never errors', () => {
  // Mirrors how the executor will integrate the fallback in the next call-site change.
  async function callNonVisionAgent(
    attachments: AttachmentRef[],
    prompt: string,
    mode: ImageFallbackMode,
  ) {
    const ocrFn = vi.fn(async () => 'visible text: "OPEN MIC NIGHT"');
    const describeFn = vi.fn(async () => 'a poster advertising open mic night');

    const fb = await runImageFallback(attachments, mode, { ocrFn, describeFn });
    const finalPrompt = applyImageFallback(prompt, fb);

    return {
      // What the text-only LLM call receives:
      promptSentToModel: finalPrompt,
      // What the LLM would respond — simulated by echo (real test would
      // hit a stub neuron). The shape is what matters: no errors thrown,
      // some text returned, image attachments dropped from the request.
      stillHasImages: !fb.dropImageAttachments,
    };
  }

  it.each<ImageFallbackMode>(['ocr', 'describe', 'skip'])(
    'mode=%s never throws and yields a text-only prompt to the model',
    async (mode) => {
      const out = await callNonVisionAgent([img1, img2], 'is this important?', mode);
      expect(out.stillHasImages).toBe(false);
      // For skip mode the prompt is unchanged; for ocr/describe the
      // injection appears prepended.
      if (mode === 'skip') {
        expect(out.promptSentToModel).toBe('is this important?');
      } else {
        expect(out.promptSentToModel).toContain('is this important?');
        expect(out.promptSentToModel.startsWith(mode === 'ocr' ? '<image_text' : '<image_description')).toBe(true);
      }
    },
  );
});
