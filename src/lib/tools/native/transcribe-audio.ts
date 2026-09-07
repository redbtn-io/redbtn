/**
 * Transcribe Audio — Native Tool (Voice pack §4.5)
 *
 * Turns audio into text from inside a graph. Recognition is how Red HEARS;
 * `synthesize_speech` is the other direction.
 *
 * Inputs:
 *   - audioBase64 OR audioUrl   (one of the two is required)
 *   - mimeType                  (required — e.g. 'audio/wav', 'audio/webm')
 *   - language?                 (default 'auto')
 *   - provider?                 (default: STT_PROVIDER env, else 'whisper')
 *
 * Output:
 *   { text, language, provider, segments?: [{ start, end, text }] }
 *
 * Backends live in `lib/voice/stt-request.ts` — the SAME switch the webapp hub
 * uses, mirrored into this repo at the same relative path so a graph and the
 * hub cannot transcribe differently:
 *
 *   whisper (default) — faster-whisper at `${STT_URL}/v1/audio/transcriptions`,
 *                       with vad_filter + temperature=0. Verbose response, so
 *                       per-segment timestamps survive where the server emits
 *                       them.
 *   gemini            — generateContent with the audio inline and a
 *                       transcribe-verbatim system instruction.
 *   openai            — the same OpenAI-compatible multipart against
 *                       api.openai.com.
 *
 * A provider failure is an ERROR, not an empty transcript: the tool returns
 * `isError` with the provider's `kind` (`unconfigured` / `quota` /
 * `unsupported-media` / `upstream` / `network`) so a graph can branch on a
 * dead credential or an exhausted quota instead of concluding nobody spoke.
 * It never silently retries on a different provider.
 *
 * Environment:
 *   STT_PROVIDER   — default recogniser: whisper | gemini | openai
 *   STT_URL        — Whisper endpoint base (default: http://192.168.1.3:8787)
 *   GOOGLE_API_KEY — required when `provider: 'gemini'`
 *   OPENAI_API_KEY — required when `provider: 'openai'`
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import {
  defaultSttProvider,
  isSttProvider,
  SttError,
  STT_PROVIDERS,
  transcribe,
  type SttProvider,
} from '../../voice/stt-request';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TranscribeArgs {
  audioBase64?: string;
  audioUrl?: string;
  mimeType: string;
  language?: string;
  provider?: SttProvider;
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
 * Normalise the verbose transcription body. An OpenAI-compatible server may
 * return a plain `{ text }` object or a verbose response with `segments` and
 * `language`; Gemini returns neither. We surface whatever is present.
 */
function normaliseSegments(
  raw: AnyObject,
  fallbackLanguage: string,
): { language: string; segments?: Array<{ start: number; end: number; text: string }> } {
  const language =
    raw && typeof raw.language === 'string' && raw.language
      ? raw.language
      : fallbackLanguage === 'auto'
        ? 'auto'
        : fallbackLanguage;

  let segments: Array<{ start: number; end: number; text: string }> | undefined;
  if (raw && Array.isArray(raw.segments) && raw.segments.length > 0) {
    segments = raw.segments
      .filter((s: AnyObject) => s && typeof s === 'object')
      .map((s: AnyObject) => ({
        start: Number(s.start ?? 0),
        end: Number(s.end ?? 0),
        text: String(s.text ?? '').trim(),
      }));
  }

  return segments ? { language, segments } : { language };
}

const transcribeAudioTool: NativeToolDefinition = {
  description:
    'Transcribe audio to text. Accepts base64 audio or a URL; supports per-segment timestamps when the upstream returns them. Recognises with a local Whisper service by default, or with Gemini or OpenAI when asked.',
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
          "ISO language code (e.g. 'en', 'fr') or 'auto' to let the recogniser detect. Default 'auto'.",
        default: 'auto',
      },
      provider: {
        type: 'string',
        enum: [...STT_PROVIDERS],
        description:
          "Which engine transcribes. 'whisper' (default) is a local service and keeps the audio on the LAN; 'gemini' and 'openai' are cloud APIs and are billed.",
      },
    },
    required: ['mimeType'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TranscribeArgs>;

    const fail = (payload: AnyObject): NativeMcpResult => ({
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    });

    if (!args.mimeType || typeof args.mimeType !== 'string') {
      return fail({ error: 'mimeType is required and must be a string', code: 'VALIDATION' });
    }

    // An unrecognised provider is a validation error, not a silent substitution:
    // the caller is choosing whether its audio leaves the LAN.
    let provider: SttProvider = defaultSttProvider();
    if (args.provider !== undefined && args.provider !== null) {
      if (!isSttProvider(args.provider)) {
        return fail({
          error: `provider must be one of ${STT_PROVIDERS.join(', ')}`,
          code: 'VALIDATION',
        });
      }
      provider = args.provider;
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
      return fail({
        error: message,
        ...(code ? { code } : {}),
        ...(status ? { status } : {}),
      });
    }

    console.log(
      `[transcribe_audio] provider=${provider} mimeType=${resolvedMime} ` +
        `language=${language} bytes=${buffer.length}`,
    );

    try {
      const result = await transcribe({
        audio: new Uint8Array(buffer),
        provider,
        mimeType: resolvedMime,
        language: language === 'auto' ? null : language,
        verbose: true,
        signal: context?.abortSignal ?? undefined,
      });

      const { language: detected, segments } = normaliseSegments(
        (result.raw ?? {}) as AnyObject,
        language,
      );
      const payload = {
        text: result.text,
        language: detected,
        provider: result.provider,
        ...(segments ? { segments } : {}),
      };

      const elapsed = Date.now() - startTime;
      console.log(
        `[transcribe_audio] ok provider=${result.provider} textLength=${result.text.length} ` +
          `segments=${segments?.length ?? 0} elapsed=${elapsed}ms`,
      );

      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    } catch (err: unknown) {
      if (err instanceof SttError) {
        console.error(
          `[transcribe_audio] error provider=${err.provider} kind=${err.kind}` +
            `${err.status ? ` status=${err.status}` : ''}: ${err.message}`,
        );
        return fail({
          error: err.message,
          provider: err.provider,
          code: err.kind,
          ...(err.status ? { status: err.status } : {}),
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[transcribe_audio] error: ${message}`);
      return fail({ error: message });
    }
  },
};

export default transcribeAudioTool;
module.exports = transcribeAudioTool;
