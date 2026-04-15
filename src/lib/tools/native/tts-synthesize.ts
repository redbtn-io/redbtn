/**
 * TTS Synthesize — Native Tool
 *
 * Synthesizes speech from text using the Google Gemini TTS API.
 * Returns raw PCM audio (24 kHz, mono, 16-bit little-endian) as base64.
 *
 * The audio is ready to be wrapped in a WAV header and played by the
 * Discord bot, or sent directly to a consumer that understands PCM.
 *
 * Environment:
 *   GOOGLE_API_KEY — required (Google AI API key)
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

const ttsSynthesizeTool: NativeToolDefinition = {
  description: 'Synthesize speech from text using Google Gemini TTS. Returns base64-encoded PCM audio (24 kHz mono 16-bit).',
  server: 'system',
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
        description: 'Gemini TTS model to use (default: gemini-2.5-flash-preview-tts)',
        default: 'gemini-2.5-flash-preview-tts',
      },
    },
    required: ['text'],
  },

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handler(args: Record<string, unknown>, _context: NativeToolContext): Promise<NativeMcpResult> {
    const text = (args.text as string || '').trim();
    if (!text) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'text is required and must not be empty' }) }],
        isError: true,
      };
    }

    const voice = (args.voice as string) || 'Kore';
    const model = (args.model as string) || 'gemini-2.5-flash-preview-tts';

    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'GOOGLE_API_KEY environment variable is not set' }) }],
        isError: true,
      };
    }

    try {
      // Use dynamic require so that missing @google/genai at build time doesn't break
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { GoogleGenAI } = require('@google/genai');

      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      });

      const audioData: string | undefined =
        response?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

      if (!audioData) {
        console.error('[tts_synthesize] No audio data in Gemini TTS response:', JSON.stringify(response?.candidates?.[0]?.content));
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'No audio data returned by Gemini TTS' }) }],
          isError: true,
        };
      }

      console.log(
        `[tts_synthesize] Synthesized ${audioData.length} base64 chars (model=${model}, voice=${voice}, textLength=${text.length})`
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            audioData,       // base64-encoded PCM 24 kHz mono 16-bit LE
            mimeType: 'audio/pcm',
            sampleRate: 24000,
            channels: 1,
            bitDepth: 16,
            model,
            voice,
            textLength: text.length,
          }),
        }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tts_synthesize] Gemini TTS error:', msg);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Gemini TTS failed: ${msg}` }) }],
        isError: true,
      };
    }
  },
};

export default ttsSynthesizeTool;
