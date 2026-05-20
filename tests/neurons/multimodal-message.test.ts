/**
 * Phase 8 — media-wire-attachments-neuron
 *
 * Tests `buildMultimodalMessage` and `resolveAttachmentSource` from
 * redbtn/src/lib/nodes/universal/executors/multimodalMessage.ts.
 *
 * Acceptance: invoking a vision-capable agent with an image attachment
 * results in the neuron call receiving the image as an image_url content
 * part.
 *
 * Two new behaviors from the spike plan:
 *   (1) chat-path precedence — state.data.input.attachments wins over
 *       state.data._trigger.metadata.attachments when non-empty;
 *   (2) auto-inference — when any image attachment is present, the call
 *       is treated as multimodal even without a `multimodal: true` flag,
 *       UNLESS the caller explicitly set `multimodal: false`.
 */

import { describe, it, expect, vi } from 'vitest';

// @langchain/core is installed only inside redbtn/node_modules — the monorepo
// root vitest can't resolve it. Mock with a minimal HumanMessage that
// exposes the same `content` shape so assertions work the same way.
class FakeHumanMessage {
  constructor(public init: { content: unknown }) {}
  get content() { return this.init.content; }
}
vi.mock('@langchain/core/messages', () => ({ HumanMessage: FakeHumanMessage }));

const {
  buildMultimodalMessage,
  resolveAttachmentSource,
} = await import('../../src/lib/nodes/universal/executors/multimodalMessage');
type AttachmentRef = import('../../src/lib/nodes/universal/executors/multimodalMessage').AttachmentRef;

function imageAttachment(over: Partial<AttachmentRef> = {}): AttachmentRef {
  return {
    kind: 'image',
    mimeType: 'image/png',
    url: 'https://attachments.redbtn.io/att_test_1',
    filename: 'photo.png',
    size: 4321,
    ...over,
  };
}

function makeState(over: Record<string, unknown> = {}): any {
  return { data: { input: {}, ...over } };
}

const NEURON_STEP_BASE = { neuronId: 'red-neuron', userPrompt: '{{state.data.messages}}' } as any;

describe('resolveAttachmentSource — chat-path precedence', () => {
  it('prefers state.data.input.attachments when it has entries', () => {
    const a = imageAttachment({ attachmentId: 'from-input' } as any);
    const b = imageAttachment({ attachmentId: 'from-trigger' } as any);
    const state = {
      data: {
        input: { attachments: [a] },
        _trigger: { metadata: { attachments: [b] } },
      },
    };
    expect(resolveAttachmentSource(state)).toEqual([a]);
  });

  it('falls back to trigger.metadata.attachments when input.attachments is empty', () => {
    const trig = imageAttachment({ attachmentId: 'from-trigger' } as any);
    const state = {
      data: {
        input: { attachments: [] },
        _trigger: { metadata: { attachments: [trig] } },
      },
    };
    expect(resolveAttachmentSource(state)).toEqual([trig]);
  });

  it('returns [] when neither source carries attachments', () => {
    expect(resolveAttachmentSource({ data: { input: {} } })).toEqual([]);
    expect(resolveAttachmentSource(undefined)).toEqual([]);
  });
});

describe('buildMultimodalMessage — auto-inference for chat-path image attachments', () => {
  it('produces an image_url content part when input.attachments carries an image, with NO multimodal flag set', () => {
    const img = imageAttachment();
    const state = makeState({ input: { attachments: [img] } });
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'describe this', state);

    expect(msg).not.toBeNull();
    expect(Array.isArray((msg as any).content)).toBe(true);
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    // image part comes first
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: img.url } });
    // trailing text part with the rendered prompt
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'describe this' });
  });

  it('still produces image parts when the caller sets multimodal: true explicitly (legacy callers)', () => {
    const img = imageAttachment();
    const state = makeState({ input: { attachments: [img] } });
    const msg = buildMultimodalMessage(
      { ...NEURON_STEP_BASE, multimodal: true } as any,
      'caption',
      state,
    );
    expect(msg).not.toBeNull();
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });

  it('escape hatch: multimodal:false suppresses the multimodal path even when an image attachment is present', () => {
    const img = imageAttachment();
    const state = makeState({ input: { attachments: [img] } });
    const msg = buildMultimodalMessage(
      { ...NEURON_STEP_BASE, multimodal: false } as any,
      'text only',
      state,
    );
    expect(msg).toBeNull();
  });

  it('returns null when there are no attachments and no audio data (text-only regression)', () => {
    expect(buildMultimodalMessage(NEURON_STEP_BASE, 'hi', makeState())).toBeNull();
  });

  it('skips non-image attachments (regression for the kind/MIME filter)', () => {
    const state = makeState({
      input: {
        attachments: [
          { kind: 'document', mimeType: 'application/pdf', url: 'u-pdf' },
          { kind: 'file', mimeType: 'application/octet-stream', url: 'u-bin' },
        ],
      },
    });
    // No image attachment present → not auto-inferred multimodal.
    expect(buildMultimodalMessage(NEURON_STEP_BASE, 'q', state)).toBeNull();
  });

  it('skips an image attachment with no URL', () => {
    const state = makeState({
      input: { attachments: [{ kind: 'image', mimeType: 'image/png' }] },
    });
    expect(buildMultimodalMessage(NEURON_STEP_BASE, 'q', state)).toBeNull();
  });

  it('multiple image attachments produce multiple image_url parts', () => {
    const a = imageAttachment({ url: 'https://x/a.png' });
    const b = imageAttachment({ url: 'https://x/b.jpg', mimeType: 'image/jpeg' });
    const state = makeState({ input: { attachments: [a, b] } });
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'compare', state);
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    const imageUrls = parts.filter((p) => p.type === 'image_url').map((p) => (p.image_url as { url: string }).url);
    expect(imageUrls).toEqual([a.url, b.url]);
  });

  it('infers image from MIME when ref.kind is absent', () => {
    const state = makeState({
      input: { attachments: [{ mimeType: 'image/webp', url: 'https://x/photo.webp' }] },
    });
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'q', state);
    expect(msg).not.toBeNull();
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('image_url');
  });
});

describe('buildMultimodalMessage — Discord trigger-metadata fallback still works', () => {
  it('Discord-style trigger.metadata.attachments are picked up when input.attachments is empty', () => {
    const img = imageAttachment({ url: 'https://cdn.discord/abc.png' });
    const state = {
      data: {
        input: {},
        _trigger: { metadata: { attachments: [img] } },
      },
    };
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'hi', state);
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'image_url', image_url: { url: img.url } });
  });

  it('chat-path input.attachments WIN over trigger fallback', () => {
    const inputImg = imageAttachment({ url: 'https://chat/a.png' });
    const trigImg = imageAttachment({ url: 'https://discord/b.png' });
    const state = {
      data: {
        input: { attachments: [inputImg] },
        _trigger: { metadata: { attachments: [trigImg] } },
      },
    };
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'go', state);
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    const urls = parts.filter((p) => p.type === 'image_url').map((p) => (p.image_url as { url: string }).url);
    expect(urls).toEqual(['https://chat/a.png']);
  });
});

describe('buildMultimodalMessage — audio behavior (unchanged)', () => {
  it('audioInput=true + input.audioData → produces a media audio part', () => {
    const state = makeState({ input: { audioData: 'AAAA', audioMimeType: 'audio/wav' } });
    const msg = buildMultimodalMessage(
      { ...NEURON_STEP_BASE, audioInput: true } as any,
      'transcribe',
      state,
    );
    expect(msg).not.toBeNull();
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    expect(parts[0]).toEqual({ type: 'media', mimeType: 'audio/wav', data: 'AAAA' });
    expect(parts[parts.length - 1]).toEqual({ type: 'text', text: 'transcribe' });
  });

  it('audio is also auto-inferred when input.audioData is present without an explicit flag', () => {
    const state = makeState({ input: { audioData: 'AAAA' } });
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, 'go', state);
    expect(msg).not.toBeNull();
  });

  it('multimodal:false suppresses audio too (escape hatch)', () => {
    const state = makeState({ input: { audioData: 'AAAA' } });
    const msg = buildMultimodalMessage(
      { ...NEURON_STEP_BASE, multimodal: false } as any,
      'q',
      state,
    );
    expect(msg).toBeNull();
  });
});

describe('buildMultimodalMessage — integration shape for vision agent', () => {
  it('end-to-end: a vision-capable neuron step receives an image_url part and the rendered text', () => {
    // Mirrors what Phase 9's executor produces just before bindTools.
    const state = makeState({
      input: {
        message: "what's in this picture?",
        attachments: [imageAttachment({ url: 'https://attachments.redbtn.io/att_e2e' })],
      },
    });
    const text = "what's in this picture?";
    const msg = buildMultimodalMessage(NEURON_STEP_BASE, text, state);
    expect(msg).not.toBeNull();
    const parts = (msg as any).content as Array<Record<string, unknown>>;
    expect(parts).toEqual([
      { type: 'image_url', image_url: { url: 'https://attachments.redbtn.io/att_e2e' } },
      { type: 'text', text },
    ]);
  });
});
