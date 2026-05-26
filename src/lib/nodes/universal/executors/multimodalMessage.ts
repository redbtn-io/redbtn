/**
 * Multimodal HumanMessage builder.
 *
 * Extracted from neuronExecutor.ts so this can be unit-tested without
 * dragging in the executor file's runtime-only require graph. Depends only
 * on `@langchain/core/messages` (no globalState require chain).
 *
 * Chat-path precedence (NEW, Phase 8):
 *   - Prefers `state.data.input.attachments` (the chat composer / dispatch
 *     path) over `state.data._trigger.metadata.attachments` (Discord
 *     fallback). When `input.attachments` is non-empty it wins outright;
 *     otherwise the trigger source is used as a fallback.
 *
 * Auto-inference gate (NEW, Phase 8):
 *   - When any attachment carries an image kind/MIME, treat the call as
 *     multimodal even when no `multimodal`/`imageInput` flag is set on the
 *     step. Explicit `config.multimodal === false` is an escape hatch that
 *     suppresses the multimodal path regardless.
 *
 * Audio behavior (unchanged):
 *   - Pulled from `state.data.input.audioData` (base64) when
 *     `config.audioInput` or `config.multimodal` is set.
 */

import { HumanMessage } from '@langchain/core/messages';
import type { NeuronStepConfig } from '../types';

/**
 * Attachment reference shape — mirrors the engine's persisted AttachmentRef
 * (every field optional) and the Discord trigger payload.
 */
export interface AttachmentRef {
  kind?: 'image' | 'video' | 'audio' | 'document' | 'file';
  mimeType?: string;
  url?: string;
  filename?: string;
  size?: number;
}

function isImageAttachment(a: AttachmentRef): boolean {
  return a.kind === 'image' || (a.mimeType ?? '').startsWith('image/');
}

/**
 * Choose which attachment list to use. Prefers the chat-path
 * `input.attachments` whenever it has at least one entry; otherwise falls
 * back to the Discord-side `_trigger.metadata.attachments`.
 *
 * Exported for unit testing.
 */
export function resolveAttachmentSource(state: any): AttachmentRef[] {
  const input = state?.data?.input || {};
  const inputAttachments: AttachmentRef[] = Array.isArray(input.attachments) ? input.attachments : [];
  if (inputAttachments.length > 0) return inputAttachments;
  const trig = state?.data?._trigger?.metadata?.attachments;
  return Array.isArray(trig) ? trig : [];
}

/**
 * Build a multimodal HumanMessage that may include audio and/or image
 * content parts. Returns null when no multimodal content is found, so
 * callers can fall back to a plain string message.
 *
 * @langchain/google-genai v2.1.26 supports:
 *   { type: "media", mimeType: "audio/wav", data: base64 }  -> inlineData
 *   { type: "image_url", image_url: { url: "https://..." } } -> fileData / inlineData
 */
export function buildMultimodalMessage(
  config: NeuronStepConfig,
  textContent: string,
  state: any,
): HumanMessage | null {
  const attachments = resolveAttachmentSource(state);
  const hasImageAttachment = attachments.some(isImageAttachment);

  const input = state?.data?.input || {};
  const hasAudioData = Boolean(input.audioData);

  // Explicit escape hatch — when the caller set multimodal:false they want
  // a text-only call even if attachments are present.
  const multimodalSuppressed = config.multimodal === false;

  const wantsAudio =
    !multimodalSuppressed && (config.audioInput || config.multimodal === true || hasAudioData);
  const wantsImages =
    !multimodalSuppressed && (config.imageInput || config.multimodal === true || hasImageAttachment);

  if (!wantsAudio && !wantsImages) return null;

  const contentParts: unknown[] = [];
  let hasMultimodal = false;

  // --- Audio input ---
  if (wantsAudio && hasAudioData) {
    const mimeType: string = input.audioMimeType || 'audio/wav';
    contentParts.push({
      type: 'media',
      mimeType,
      data: input.audioData, // base64 encoded
    });
    hasMultimodal = true;
    console.log(
      `[NeuronExecutor] Multimodal: added audio content part (${mimeType}, ${
        (input.audioData as string).length
      } base64 chars)`,
    );
  }

  // --- Image input from attachments ---
  if (wantsImages && attachments.length > 0) {
    for (const attachment of attachments) {
      if (!isImageAttachment(attachment)) continue;
      if (!attachment.url) continue;

      contentParts.push({
        type: 'image_url',
        image_url: { url: attachment.url },
      });
      hasMultimodal = true;
      console.log(
        `[NeuronExecutor] Multimodal: added image content part (${attachment.mimeType ?? 'image/?'}, ${attachment.url.substring(0, 80)})`,
      );
    }
  }

  if (!hasMultimodal) return null;

  // Append the rendered text prompt as the last part
  if (textContent) {
    contentParts.push({ type: 'text', text: textContent });
  }

  return new HumanMessage({ content: contentParts as any });
}
