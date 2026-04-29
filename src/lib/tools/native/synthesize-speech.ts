/**
 * Synthesize Speech — Native Tool (Voice pack §4.5)
 *
 * Consolidated TTS tool. Routes to one of two providers:
 *
 *   - `kokoro` (default) — Kokoro TTS server (OpenAI-compatible audio/speech
 *     endpoint at `${TTS_URL}/v1/audio/speech`). Returns WAV by default; PCM
 *     when `format: 'pcm'`.
 *
 *   - `gemini` — Google Gemini TTS via `@google/genai`. Always returns PCM
 *     (24 kHz mono 16-bit LE); when `format: 'wav'` we wrap the PCM in a
 *     RIFF/WAVE header before returning.
 *
 * Output (per TOOL-HANDOFF.md §4.5):
 *   { audioBase64, mimeType, durationMs }
 *
 * `tts_synthesize` is registered as an alias of this tool for one engine
 * version (defaulting `provider` to `gemini` for the legacy callers that
 * relied on Gemini-specific output). It will be removed in a follow-up.
 *
 * Environment:
 *   TTS_URL        — Kokoro endpoint base (default: http://192.168.1.6:8880)
 *   GOOGLE_API_KEY — required when `provider: 'gemini'`
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

type Provider = 'kokoro' | 'gemini';
type Format = 'wav' | 'pcm';

interface SynthesizeArgs {
  text: string;
  voice?: string;
  provider?: Provider;
  format?: Format;
}

const DEFAULT_KOKORO_BASE = 'http://192.168.1.6:8880';
const DEFAULT_KOKORO_VOICE = 'af_bella';
const DEFAULT_GEMINI_VOICE = 'Kore';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-preview-tts';

// Gemini TTS always emits PCM 24 kHz mono 16-bit LE — this matches the
// existing `tts-synthesize.ts` behaviour and what `session-manager.ts`
// assumes when it builds WAV headers from accumulated chunks.
const GEMINI_PCM_SAMPLE_RATE = 24000;
const GEMINI_PCM_CHANNELS = 1;
const GEMINI_PCM_BIT_DEPTH = 16;

/**
 * Build a minimal RIFF/WAVE PCM16 header for raw PCM data.
 *
 * Used when the caller asked for `wav` but the upstream returned raw PCM
 * (the Gemini path). Mirrors the header construction in
 * `webapp/src/lib/streams/session-manager.ts`.
 */
function pcm16ToWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  channels: number,
  bitDepth: number,
): Buffer {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Approximate the duration (in ms) of a PCM16 buffer.
 */
function pcmDurationMs(
  pcmByteLength: number,
  sampleRate: number,
  channels: number,
  bitDepth: number,
): number {
  const bytesPerSample = (bitDepth / 8) * channels;
  if (bytesPerSample <= 0) return 0;
  const samples = pcmByteLength / bytesPerSample;
  return Math.round((samples / sampleRate) * 1000);
}

/**
 * Kokoro path — POST to `${TTS_URL}/v1/audio/speech`.
 *
 * The Kokoro server speaks an OpenAI-compatible interface. We ask for `wav`
 * by default so we can compute `durationMs` precisely, or `pcm` when the
 * caller wants the raw stream for downstream pipelines.
 */
async function synthesizeWithKokoro(args: {
  text: string;
  voice: string;
  format: Format;
  base: string;
  abortSignal: AbortSignal | null;
}): Promise<{ audioBase64: string; mimeType: string; durationMs: number }> {
  const { text, voice, format, base, abortSignal } = args;

  // Map our `format` to Kokoro's `response_format`. Kokoro returns WAV when
  // asked for wav, and raw PCM bytes when asked for pcm.
  const responseFormat = format === 'pcm' ? 'pcm' : 'wav';
  const mimeType = format === 'pcm' ? 'audio/pcm' : 'audio/wav';

  const url = `${base.replace(/\/$/, '')}/v1/audio/speech`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'kokoro',
      input: text,
      voice,
      speed: 1.0,
      response_format: responseFormat,
    }),
    signal: abortSignal ?? undefined,
  });

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    const err = new Error(
      `Kokoro TTS HTTP ${response.status} ${response.statusText}` +
        (body ? `: ${body.slice(0, 200)}` : ''),
    ) as Error & { status?: number };
    err.status = response.status;
    throw err;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const audioBase64 = buffer.toString('base64');

  // Best-effort durationMs:
  //   - For PCM, use the standard formula at 24 kHz mono 16-bit (Kokoro's default).
  //   - For WAV, peek at the header to read the actual sample rate / channels /
  //     bit depth. Fallback to the same default if the header looks unfamiliar.
  let durationMs = 0;
  if (responseFormat === 'pcm') {
    durationMs = pcmDurationMs(buffer.length, 24000, 1, 16);
  } else {
    durationMs = wavDurationMs(buffer);
  }

  return { audioBase64, mimeType, durationMs };
}

/**
 * Compute WAV duration from a RIFF/WAVE buffer by reading the standard PCM
 * header fields. Returns 0 if the header doesn't parse.
 */
function wavDurationMs(buffer: Buffer): number {
  if (buffer.length < 44) return 0;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') return 0;

  // Walk chunks looking for `fmt ` and `data` to handle non-standard layouts.
  let cursor = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let dataLength = 0;

  while (cursor + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', cursor, cursor + 4);
    const chunkSize = buffer.readUInt32LE(cursor + 4);
    const chunkStart = cursor + 8;
    if (chunkId === 'fmt ' && chunkStart + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitDepth = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === 'data') {
      dataLength = chunkSize;
      break;
    }
    cursor = chunkStart + chunkSize;
    // Pad chunks to even byte boundary per RIFF spec.
    if (chunkSize % 2 === 1) cursor += 1;
  }

  if (!sampleRate || !channels || !bitDepth || !dataLength) return 0;
  const bytesPerSample = (bitDepth / 8) * channels;
  if (bytesPerSample <= 0) return 0;
  const samples = dataLength / bytesPerSample;
  return Math.round((samples / sampleRate) * 1000);
}

/**
 * Gemini path — uses `@google/genai`, returns PCM 24 kHz mono 16-bit.
 *
 * We dynamically `require` the SDK so a missing peer dep doesn't break the
 * tool registry at module load time.
 */
async function synthesizeWithGemini(args: {
  text: string;
  voice: string;
  format: Format;
}): Promise<{ audioBase64: string; mimeType: string; durationMs: number }> {
  const { text, voice, format } = args;

  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    const err = new Error(
      'GOOGLE_API_KEY environment variable is not set',
    ) as Error & { code?: string };
    err.code = 'CONFIGURATION';
    throw err;
  }

  // Dynamic require so missing @google/genai at build time doesn't break
  // the rest of the registry. Mirrors the legacy `tts-synthesize.ts`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });

  const response = await ai.models.generateContent({
    model: DEFAULT_GEMINI_MODEL,
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
    throw new Error('No audio data returned by Gemini TTS');
  }

  const pcmBuffer = Buffer.from(audioData, 'base64');
  const durationMs = pcmDurationMs(
    pcmBuffer.length,
    GEMINI_PCM_SAMPLE_RATE,
    GEMINI_PCM_CHANNELS,
    GEMINI_PCM_BIT_DEPTH,
  );

  if (format === 'wav') {
    const wavBuffer = pcm16ToWav(
      pcmBuffer,
      GEMINI_PCM_SAMPLE_RATE,
      GEMINI_PCM_CHANNELS,
      GEMINI_PCM_BIT_DEPTH,
    );
    return {
      audioBase64: wavBuffer.toString('base64'),
      mimeType: 'audio/wav',
      durationMs,
    };
  }

  return {
    audioBase64: audioData,
    mimeType: 'audio/pcm',
    durationMs,
  };
}

const synthesizeSpeechTool: NativeToolDefinition = {
  description:
    'Synthesize speech from text. Default provider is Kokoro (high-quality OSS TTS); Gemini is also available. Use to generate voice output for chat replies, audio messages, or read-aloud features.',
  server: 'voice',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'Text to synthesize. Required.',
      },
      voice: {
        type: 'string',
        description:
          "Voice identifier. Default depends on provider — 'af_bella' for kokoro, 'Kore' for gemini.",
      },
      provider: {
        type: 'string',
        enum: ['kokoro', 'gemini'],
        description: 'Which TTS backend to use. Defaults to kokoro.',
        default: 'kokoro',
      },
      format: {
        type: 'string',
        enum: ['wav', 'pcm'],
        description:
          "Output format. 'wav' wraps PCM in a RIFF/WAVE header; 'pcm' returns the raw stream (24 kHz mono 16-bit for Gemini, kokoro emits PCM at its server-configured rate). Defaults to wav.",
        default: 'wav',
      },
    },
    required: ['text'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<SynthesizeArgs>;
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'text is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const provider: Provider =
      args.provider === 'gemini' || args.provider === 'kokoro'
        ? args.provider
        : 'kokoro';
    const format: Format = args.format === 'pcm' ? 'pcm' : 'wav';
    const voice =
      typeof args.voice === 'string' && args.voice.trim()
        ? args.voice.trim()
        : provider === 'gemini'
          ? DEFAULT_GEMINI_VOICE
          : DEFAULT_KOKORO_VOICE;

    const startTime = Date.now();
    console.log(
      `[synthesize_speech] provider=${provider} voice=${voice} format=${format} textLength=${text.length}`,
    );

    try {
      let result: { audioBase64: string; mimeType: string; durationMs: number };

      if (provider === 'kokoro') {
        const base = process.env.TTS_URL || DEFAULT_KOKORO_BASE;
        result = await synthesizeWithKokoro({
          text,
          voice,
          format,
          base,
          abortSignal: context?.abortSignal ?? null,
        });
      } else {
        result = await synthesizeWithGemini({ text, voice, format });
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[synthesize_speech] ok provider=${provider} mimeType=${result.mimeType} durationMs=${result.durationMs} elapsed=${elapsed}ms base64Len=${result.audioBase64.length}`,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              audioBase64: result.audioBase64,
              mimeType: result.mimeType,
              durationMs: result.durationMs,
              provider,
              voice,
              format,
              textLength: text.length,
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      const code = (err as { code?: string })?.code;
      console.error(`[synthesize_speech] error provider=${provider}: ${message}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              ...(status ? { status } : {}),
              ...(code ? { code } : {}),
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default synthesizeSpeechTool;
module.exports = synthesizeSpeechTool;
