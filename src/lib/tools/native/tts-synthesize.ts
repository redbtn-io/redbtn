/**
 * TTS Synthesize — Native Tool (LEGACY ALIAS)
 *
 * Deprecated. This tool is kept for one engine version as an alias for the
 * consolidated `synthesize_speech` tool (see `./synthesize-speech.ts` and
 * TOOL-HANDOFF.md §4.5). It will be removed in the next engine version.
 *
 * Behaviour preserved for back-compat:
 *   - Default provider: `gemini` (the original behaviour of this tool).
 *   - Default voice: `Kore` (the original Gemini voice).
 *   - Output: PCM 24 kHz mono 16-bit, base64-encoded — matches the legacy
 *     output shape that the Discord bot and other consumers depend on.
 *
 * New callers should use `synthesize_speech` directly, which defaults to
 * Kokoro and supports both providers.
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import synthesizeSpeechTool from './synthesize-speech';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const ttsSynthesizeTool: NativeToolDefinition = {
  description:
    '[DEPRECATED — use synthesize_speech] Synthesize speech from text using Google Gemini TTS. Returns base64-encoded PCM audio (24 kHz mono 16-bit).',
  server: 'voice',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to synthesize',
      },
      voice: {
        type: 'string',
        description: 'Gemini TTS voice name (default: Kore)',
        default: 'Kore',
      },
      model: {
        type: 'string',
        description:
          '[Ignored — synthesize_speech selects the model internally] Gemini TTS model name.',
      },
    },
    required: ['text'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    // Force provider=gemini and format=pcm to preserve the legacy output
    // shape (base64 PCM 24 kHz mono 16-bit). Voice falls back to Kore.
    const result = await synthesizeSpeechTool.handler(
      {
        text: rawArgs.text,
        voice: rawArgs.voice || 'Kore',
        provider: 'gemini',
        format: 'pcm',
      },
      context,
    );

    if (result.isError) {
      // Pass through error envelope unchanged.
      return result;
    }

    // Re-shape the response to the historical schema so existing callers that
    // destructure `audioData`, `sampleRate`, `channels`, `bitDepth` keep working.
    try {
      const body = JSON.parse(result.content[0].text);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              audioData: body.audioBase64,
              mimeType: body.mimeType ?? 'audio/pcm',
              sampleRate: 24000,
              channels: 1,
              bitDepth: 16,
              voice: body.voice,
              textLength: body.textLength,
              durationMs: body.durationMs,
              model: 'gemini-2.5-flash-preview-tts',
            }),
          },
        ],
      };
    } catch {
      // If for any reason re-shape fails, return the modern payload as-is.
      return result;
    }
  },
};

export default ttsSynthesizeTool;
module.exports = ttsSynthesizeTool;
