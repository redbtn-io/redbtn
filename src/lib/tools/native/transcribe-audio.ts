/**
 * Transcribe Audio — Native Tool (Voice pack §4.5)
 *
 * Transcribes audio to text via a local Whisper service. Mirrors the existing
 * webapp proxy at `/api/v1/voice/transcribe` but is callable from inside graphs.
 *
 * Inputs:
 *   - audioBase64 OR audioUrl   (one of the two is required)
 *   - mimeType                  (required — e.g. 'audio/wav', 'audio/webm')
 *   - language?                 (default 'auto')
 *
 * Output:
 *   { text, language, segments?: [{ start, end, text }] }
 *
 * Backend: faster-whisper at `${STT_URL}/v1/audio/transcriptions`. We POST a
 * multipart form with the audio file and ask for the verbose JSON response so
 * that segments are returned when the upstream supports it.
 *
 * Environment:
 *   STT_URL — Whisper endpoint base (default: http://192.168.1.3:8787)
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TranscribeArgs {
  audioBase64?: string;
  audioUrl?: string;
  mimeType: string;
  language?: string;
}

const DEFAULT_STT_BASE = 'http://192.168.1.3:8787';

/**
 * Pick a sensible filename extension from a MIME type so the Whisper server
 * can sniff the format. Defaults to `bin` if unknown — Whisper still tries
 * to decode based on file contents.
 */
function extensionFor(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('webm')) return 'webm';
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('mp3') || lower.includes('mpeg')) return 'mp3';
  if (lower.includes('mp4') || lower.includes('m4a') || lower.includes('aac')) return 'm4a';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('pcm')) return 'pcm';
  return 'bin';
}

/**
 * Resolve the audio bytes from either a base64 input or a URL. Returns the
 * decoded buffer + the resolved MIME type (URL fetch may overwrite the
 * caller-supplied type if the upstream sets a Content-Type header).
 */
async function resolveAudio(
  args: TranscribeArgs,
  abortSignal: AbortSignal | null,
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (args.audioBase64 && args.audioUrl) {
    const err = new Error(
      'Provide exactly one of audioBase64 or audioUrl, not both',
    ) as Error & { code?: string };
    err.code = 'VALIDATION';
    throw err;
  }

  if (args.audioBase64) {
    // Strip optional `data:` prefix if the caller passed a data URI.
    const cleaned = args.audioBase64.startsWith('data:')
      ? args.audioBase64.replace(/^data:[^;]+;base64,/, '')
      : args.audioBase64;
    let buffer: Buffer;
    try {
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      const err = new Error('audioBase64 is not valid base64') as Error & {
        code?: string;
      };
      err.code = 'VALIDATION';
      throw err;
    }
    if (buffer.length === 0) {
      const err = new Error('audioBase64 decoded to an empty buffer') as Error & {
        code?: string;
      };
      err.code = 'VALIDATION';
      throw err;
    }
    return { buffer, mimeType: args.mimeType };
  }

  if (args.audioUrl) {
    const url = args.audioUrl.trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      const err = new Error(
        'audioUrl must be an absolute http(s) URL',
      ) as Error & { code?: string };
      err.code = 'VALIDATION';
      throw err;
    }
    const response = await fetch(url, { signal: abortSignal ?? undefined });
    if (!response.ok) {
      const err = new Error(
        `Failed to fetch audioUrl: HTTP ${response.status} ${response.statusText}`,
      ) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) {
      throw new Error('audioUrl returned an empty body');
    }
    const upstreamType = response.headers.get('content-type') || '';
    const mimeType = upstreamType.split(';')[0].trim() || args.mimeType;
    return { buffer, mimeType };
  }

  const err = new Error(
    'One of audioBase64 or audioUrl is required',
  ) as Error & { code?: string };
  err.code = 'VALIDATION';
  throw err;
}

/**
 * Normalise the Whisper response. faster-whisper / OpenAI-compatible servers
 * may return a plain `{ text }` object or a verbose response with `segments`
 * and `language`. We surface whatever is present.
 */
function normaliseWhisperResponse(
  raw: AnyObject,
  fallbackLanguage: string,
): { text: string; language: string; segments?: Array<{ start: number; end: number; text: string }> } {
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const language =
    typeof raw.language === 'string' && raw.language
      ? raw.language
      : fallbackLanguage === 'auto'
        ? 'auto'
        : fallbackLanguage;

  let segments: Array<{ start: number; end: number; text: string }> | undefined;
  if (Array.isArray(raw.segments) && raw.segments.length > 0) {
    segments = raw.segments
      .filter((s: AnyObject) => s && typeof s === 'object')
      .map((s: AnyObject) => ({
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        text: String(s.text ?? '').trim(),
      }));
  }

  return segments ? { text, language, segments } : { text, language };
}

const transcribeAudioTool: NativeToolDefinition = {
  description:
    'Transcribe audio to text using a local Whisper STT service. Accepts base64 audio or a URL; supports per-segment timestamps when the upstream returns them.',
  server: 'voice',
  inputSchema: {
    type: 'object',
    properties: {
      audioBase64: {
        type: 'string',
        description:
          'Base64-encoded audio bytes. Provide this OR audioUrl, not both.',
      },
      audioUrl: {
        type: 'string',
        description:
          'Absolute http(s) URL to fetch audio from. Provide this OR audioBase64, not both.',
      },
      mimeType: {
        type: 'string',
        description:
          "MIME type of the audio (e.g. 'audio/wav', 'audio/webm', 'audio/mpeg'). Required.",
      },
      language: {
        type: 'string',
        description:
          "ISO language code (e.g. 'en', 'fr') or 'auto' to let Whisper detect. Default 'auto'.",
        default: 'auto',
      },
    },
    required: ['mimeType'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TranscribeArgs>;

    if (!args.mimeType || typeof args.mimeType !== 'string') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'mimeType is required and must be a string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const language = typeof args.language === 'string' && args.language.trim()
      ? args.language.trim()
      : 'auto';

    const startTime = Date.now();
    let buffer: Buffer;
    let resolvedMime: string;

    try {
      const resolved = await resolveAudio(
        args as TranscribeArgs,
        context?.abortSignal ?? null,
      );
      buffer = resolved.buffer;
      resolvedMime = resolved.mimeType;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      const status = (err as { status?: number })?.status;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              ...(code ? { code } : {}),
              ...(status ? { status } : {}),
            }),
          },
        ],
        isError: true,
      };
    }

    const sttBase = process.env.STT_URL || DEFAULT_STT_BASE;
    const url = `${sttBase.replace(/\/$/, '')}/v1/audio/transcriptions`;

    console.log(
      `[transcribe_audio] mimeType=${resolvedMime} language=${language} bytes=${buffer.length} stt=${url}`,
    );

    try {
      const filename = `audio.${extensionFor(resolvedMime)}`;
      const form = new FormData();
      // Cast Buffer to satisfy Blob's BlobPart type — Node 18+'s Buffer is a
      // Uint8Array, which Blob accepts at runtime even if the TS lib type is
      // a touch picky.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      form.append('file', new Blob([buffer as any], { type: resolvedMime }), filename);
      form.append('model', 'whisper-1');
      form.append('response_format', 'verbose_json');
      if (language && language !== 'auto') {
        form.append('language', language);
      }

      const response = await fetch(url, {
        method: 'POST',
        body: form,
        signal: context?.abortSignal ?? undefined,
      });

      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        const err = new Error(
          `Whisper STT HTTP ${response.status} ${response.statusText}` +
            (body ? `: ${body.slice(0, 200)}` : ''),
        ) as Error & { status?: number };
        err.status = response.status;
        throw err;
      }

      // Whisper-compat servers may emit JSON or plain text depending on
      // `response_format`. We asked for verbose_json, but be defensive.
      const contentType = response.headers.get('content-type') || '';
      let parsed: AnyObject;
      if (contentType.includes('application/json')) {
        parsed = (await response.json()) as AnyObject;
      } else {
        const text = await response.text();
        parsed = { text };
      }

      const result = normaliseWhisperResponse(parsed, language);
      const elapsed = Date.now() - startTime;
      console.log(
        `[transcribe_audio] ok textLength=${result.text.length} segments=${result.segments?.length ?? 0} elapsed=${elapsed}ms`,
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number })?.status;
      console.error(`[transcribe_audio] error: ${message}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: message,
              ...(status ? { status } : {}),
            }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default transcribeAudioTool;
module.exports = transcribeAudioTool;
