/**
 * Speech RECOGNITION for the hub — one provider list, one entry point.
 *
 * "Recognition" is how Red HEARS. It is not a "speech engine": speech is what
 * Red says (see ./tts-engines.ts). Everything in this file turns audio bytes
 * into a transcript.
 *
 * # The three callers
 *
 * Every transcription the platform performs goes through `transcribe()`:
 *
 *   1. `POST /api/voice/transcribe` (webapp)   — the desktop's transcribing-wake
 *                                                path, a one-shot HTTP upload.
 *   2. `transcribeBase64()` (webapp)           — in-process, on the live WS,
 *                                                using the stream's resolved
 *                                                `voiceEngines.stt`.
 *   3. `transcribe_audio` in THIS repo         — a graph-callable native tool
 *                                                (lib/tools/native/).
 *
 * THIS FILE IS A MIRROR. The original lives in the webapp repo at the same
 * relative path (`src/lib/voice/stt-request.ts`) and the two are kept
 * byte-identical apart from this paragraph, so a `diff` between them is the
 * review. Change one, change the other — a provider that behaves differently
 * depending on whether a graph or the hub asked is worse than no provider.
 *
 * Adding a provider is meant to be one edit: append to `STT_PROVIDERS`, add its
 * adapter to the switch in `transcribe()`. The `SttProvider` union, the stream
 * `SttEngine` union, the API validators, their 400 messages and the Mongoose
 * enum are all DERIVED from the array, so none of them needs a second edit.
 *
 * # Failure is an error, never a silent downgrade
 *
 * If the selected provider fails, `transcribe()` throws `SttError`. It does NOT
 * quietly retry on a different provider: a server-side fallback would hide a
 * dead credential or an exhausted quota behind slightly-worse transcripts, and
 * the desktop client already falls back to hub-Whisper on its own when a call
 * comes back non-2xx. The one exception is INSIDE the Gemini adapter, which may
 * retry the same request on the non-lite model — same vendor, same credential,
 * same billing, purely a capability retry.
 *
 * Quota exhaustion gets its own `kind` because of a known failure mode: the
 * platform Google key has been silenced by a spending cap before, and a 429
 * that surfaced as an empty transcript would look exactly like "nobody spoke".
 */

/**
 * Every engine the HUB itself can transcribe with — the same menu the base /
 * utterance STT path offers, because they are the same capability used at two
 * moments (a one-shot utterance vs. a live session).
 *
 * `'whisper'` is the OpenAI-compatible `/v1/audio/transcriptions` shape pointed
 * at by `STT_URL` (the faster-whisper container on the LAN by default).
 * `'gemini'` and `'openai'` are cloud recognition, off-LAN, billed.
 *
 * This is hub-side STT only. What a stream's realtime PROVIDER does natively
 * is the separate `'provider'` value (the webapp's lib/streams/voice-config.ts),
 * and what the desktop app transcribes on-device is a client choice that never
 * reaches stream config at all.
 */
export const STT_PROVIDERS = ['whisper', 'gemini', 'openai'] as const;

/** One hub-side transcription engine. Widen `STT_PROVIDERS`, not this type. */
export type SttProvider = (typeof STT_PROVIDERS)[number];

/** Membership test for the canonical list, usable on untrusted input. */
export function isSttProvider(value: unknown): value is SttProvider {
  return (STT_PROVIDERS as readonly string[]).includes(value as string);
}

let warnedAboutProvider = false;

/**
 * Which provider a caller gets when it does not name one. Deliberately
 * `'whisper'`: the default keeps room audio on the LAN, and opting into a
 * cloud recogniser is an explicit act. An unrecognised `STT_PROVIDER` is
 * reported once and ignored rather than crashing the process.
 *
 * Every environment read in this module is a FUNCTION, not a module-level
 * const. A const snapshots whatever was set when the module first loaded,
 * which is wrong for a long-lived server whose config can be reloaded and
 * wrong for any test that sets an env var in `beforeEach`.
 */
export function defaultSttProvider(): SttProvider {
  const configured = process.env.STT_PROVIDER;
  if (!configured) return 'whisper';
  if (isSttProvider(configured)) return configured;
  if (!warnedAboutProvider) {
    warnedAboutProvider = true;
    console.error(
      `[voice/stt] STT_PROVIDER=${configured} is not one of ${STT_PROVIDERS.join(', ')} — using 'whisper'`,
    );
  }
  return 'whisper';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a transcription failed, in the shape a caller can act on:
 *
 *   unconfigured     — no credential for this provider on this deployment.
 *                      A 501: the operator must fix it, retrying will not.
 *   quota            — rate limited or out of quota (429 / RESOURCE_EXHAUSTED).
 *                      Its own kind so a spending cap can never be mistaken
 *                      for silence. A 429: retry later, or pick another engine.
 *   unsupported-media— the provider will not accept this container/codec.
 *                      A 415: re-encode, do not retry.
 *   upstream         — the provider answered, unhappily. A 502.
 *   network          — the provider could not be reached at all. A 502.
 */
export type SttFailureKind =
  | 'unconfigured'
  | 'quota'
  | 'unsupported-media'
  | 'upstream'
  | 'network';

/** A transcription that did not happen. Carries enough to map to a status. */
export class SttError extends Error {
  readonly provider: SttProvider;
  readonly kind: SttFailureKind;
  /** Upstream HTTP status, when there was one. */
  readonly status?: number;

  constructor(
    provider: SttProvider,
    kind: SttFailureKind,
    message: string,
    status?: number,
  ) {
    super(message);
    this.name = 'SttError';
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

/** HTTP status a route should answer with for a given failure. */
export function sttErrorStatus(err: SttError): number {
  switch (err.kind) {
    case 'unconfigured':
      return 501;
    case 'quota':
      return 429;
    case 'unsupported-media':
      return 415;
    default:
      return 502;
  }
}

// ---------------------------------------------------------------------------
// Whisper (OpenAI-compatible /v1/audio/transcriptions)
// ---------------------------------------------------------------------------

/**
 * Model for the `'whisper'` provider. `base` by default. `small` was
 * benchmarked on redServer on the same clips and recognised no more of them
 * (5/8 "hey Red" either way) while taking 2.44 s per 2 s clip against base's
 * 0.87 s — past the round trip a live voice turn tolerates. `medium` took
 * 7.66 s and hallucinated "Thank you very much." on silence. `STT_MODEL`
 * overrides this without a code change if that trade-off shifts.
 */
export function sttModel(): string {
  return process.env.STT_MODEL || 'base';
}

/**
 * Where the OpenAI-compatible `/v1/audio/transcriptions` endpoint lives for the
 * `'whisper'` provider. The fleet default is the faster-whisper container on
 * redServer. Any host that speaks the same API works — including
 * `https://api.openai.com`, though the `'openai'` provider below is the
 * supported way to reach that one.
 */
export const DEFAULT_STT_URL = 'http://192.168.1.3:8787';

export function sttUrl(): string {
  return process.env.STT_URL || DEFAULT_STT_URL;
}

/**
 * Request headers for the `'whisper'` call. Cloud endpoints need a bearer
 * token; the LAN container ignores one. Never log the value.
 */
export function whisperHeaders(): Record<string, string> {
  const key = process.env.STT_API_KEY;
  return key ? { Authorization: `Bearer ${key}` } : {};
}

/**
 * Append the model and the anti-hallucination decode settings to a
 * faster-whisper multipart body. The caller appends `file` itself; `language`
 * is passed here because it is per-request (null means "auto-detect").
 *
 * `vad_filter` is the important one. Silero VAD runs before decoding and drops
 * segments with no voice activity, which is the difference between "You" and
 * "" on a silent clip. Benchmarked on redServer, three all-zero PCM clips plus
 * a 5 s white-noise clip, model=base:
 *
 *     vad_filter off → "You", "You", "You", ""      1.28 s mean on real speech
 *     vad_filter on  → "",    "",    "",    ""      0.87 s mean on real speech
 *
 * VAD is also *faster*, because skipped segments are never decoded (0.12 s on
 * silence vs 0.84 s).
 *
 * `temperature=0` disables faster-whisper's temperature fallback. On a failed
 * decode the default schedule re-runs at 0.2 … 1.0, and the high-temperature
 * passes are where the free-associated text comes from.
 *
 * `vad_filter` is a faster-whisper extension, NOT part of the OpenAI API — it
 * is deliberately absent from the `'openai'` adapter below.
 */
export function appendWhisperParams(form: FormData, language: string | null): void {
  form.append('model', sttModel());
  form.append('vad_filter', 'true');
  form.append('temperature', '0');
  if (language) {
    form.append('language', language);
  }
}

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

/** Base URL for the `'openai'` provider. Overridable for a compatible proxy. */
export function openaiSttUrl(): string {
  return process.env.OPENAI_STT_URL || 'https://api.openai.com';
}

/**
 * Transcription model for the `'openai'` provider. `whisper-1` is what the
 * platform already asks for everywhere it speaks this API (the engine's
 * `transcribe_audio` tool sends exactly that), so it stays the default;
 * `OPENAI_STT_MODEL=gpt-4o-mini-transcribe` switches without a code change.
 */
export function openaiSttModel(): string {
  return process.env.OPENAI_STT_MODEL || 'whisper-1';
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Gemini recognition model. Lite first — this runs on every utterance of a live
 * conversation, so cost and latency dominate. If a lite model ever refuses
 * audio input, the adapter retries once on `GEMINI_STT_FALLBACK_MODEL`.
 */
export function geminiSttModel(): string {
  return process.env.GEMINI_STT_MODEL || 'gemini-2.5-flash-lite';
}
export function geminiSttFallbackModel(): string {
  return process.env.GEMINI_STT_FALLBACK_MODEL || 'gemini-2.5-flash';
}

/**
 * The system instruction. A general model asked for a transcript will happily
 * answer the audio, describe it, apologise for it, or wrap it in quotes — all
 * of which reach the user as though somebody had said them. Every clause here
 * closes one of those doors, and the empty-string clause is what makes silence
 * expressible at all (a chat model has no "no speech" return value).
 */
export const GEMINI_STT_INSTRUCTION = [
  'You are a speech recognition engine, not an assistant.',
  'Transcribe the attached audio verbatim.',
  'Output ONLY the transcript text: no commentary, no explanation, no apology,',
  'no speaker labels, no timestamps, no surrounding quotation marks, no markdown.',
  'Never answer, summarise, translate or respond to what is said — only write it down.',
  'Do not guess at words you cannot hear, and do not add punctuation beyond what is',
  'actually spoken.',
  'If the audio contains no intelligible speech, output an empty string and nothing else.',
].join(' ');

/**
 * What Gemini says instead of an empty string when it hears nothing, despite
 * being told to say nothing.
 *
 * A chat model cannot help itself: asked to transcribe silence it narrates the
 * silence. These are compared against a normalized form (lowercased, wrapping
 * brackets/parens/asterisks and trailing punctuation stripped), so `[silence]`,
 * `(no speech)`, `*inaudible*` and `No speech detected.` all collapse to the
 * same key. Anything matching becomes `''` — the adapter's own normalization,
 * so the caller sees "no speech" rather than a caption.
 *
 * This is NOT the hallucination filter in ./transcript-filter.ts. That one
 * catches Whisper's training-set boilerplate for every provider; this one
 * turns a Gemini-specific non-answer into the empty string the API contract
 * promises.
 */
export const GEMINI_SILENCE_MARKERS: readonly string[] = [
  '',
  'silence',
  'silent',
  'no speech',
  'no speech detected',
  'no audible speech',
  'no intelligible speech',
  'no transcript',
  'inaudible',
  'unintelligible',
  'blank audio',
  'blank',
  'empty',
  'empty string',
  'background noise',
  'noise',
  'music',
  'n a',
];

const GEMINI_SILENCE_SET = new Set(GEMINI_SILENCE_MARKERS);

/**
 * Reduce a candidate transcript to a comparison key: strip wrapping brackets,
 * parentheses, asterisks and quotes, lowercase, drop punctuation, collapse
 * whitespace. `"[ Silence ]"` and `'silence.'` both become `silence`.
 */
function silenceKey(text: string): string {
  return text
    .trim()
    .replace(/^[\s[\](){}*"'“”‘’<>-]+/, '')
    .replace(/[\s[\](){}*"'“”‘’<>.!?-]+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when Gemini narrated the silence instead of returning nothing. */
export function isGeminiSilence(text: string): boolean {
  return GEMINI_SILENCE_SET.has(silenceKey(text));
}

// ---------------------------------------------------------------------------
// Audio plumbing
// ---------------------------------------------------------------------------

/**
 * Filename extension for a MIME type. faster-whisper and the OpenAI API both
 * sniff the upload's extension before its bytes, so a wrong one costs a decode.
 * `webm` is the default because that is what a browser MediaRecorder produces
 * and what every current caller sent before this module existed.
 */
export function extensionFor(mimeType: string | undefined): string {
  const lower = (mimeType || '').toLowerCase();
  if (lower.includes('wav')) return 'wav';
  if (lower.includes('ogg') || lower.includes('opus')) return 'ogg';
  if (lower.includes('mp3') || lower.includes('mpeg')) return 'mp3';
  if (lower.includes('m4a') || lower.includes('mp4') || lower.includes('aac')) return 'm4a';
  if (lower.includes('flac')) return 'flac';
  if (lower.includes('pcm') || lower.includes('l16')) return 'pcm';
  return 'webm';
}

/** True for headerless linear PCM, which only the Whisper path can decode raw. */
function isRawPcm(mimeType: string | undefined): boolean {
  const lower = (mimeType || '').toLowerCase();
  return lower.includes('pcm') || lower.includes('l16');
}

/** Sample rate declared on a PCM MIME type (`audio/pcm;rate=16000`), or 16 kHz. */
function pcmSampleRate(mimeType: string | undefined): number {
  const match = /(?:^|;)\s*(?:rate|sample_rate|sampleRate)\s*=\s*(\d+)/i.exec(mimeType || '');
  const parsed = match ? Number(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 16000;
}

/**
 * Wrap raw 16-bit little-endian mono PCM in a RIFF/WAVE header.
 *
 * Gemini's inline audio accepts containers, not headerless PCM — the live hub
 * path forwards `audio/pcm` straight off the wire, so without this every live
 * Gemini transcription would 400. Mirrors the header construction already used
 * for Gemini TTS output in session-manager.ts.
 */
function pcm16ToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const out = new Uint8Array(44 + pcm.length);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

async function toBytes(audio: Uint8Array | Blob): Promise<Uint8Array> {
  if (audio instanceof Uint8Array) return audio;
  return new Uint8Array(await audio.arrayBuffer());
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export interface TranscribeInput {
  /** Audio bytes. A `Blob`'s own `type` is used when `mimeType` is omitted. */
  audio: Uint8Array | Blob;
  /** Which engine transcribes. Defaults to `defaultSttProvider()`. */
  provider?: SttProvider;
  /** Container/codec of `audio`, e.g. `audio/wav`, `audio/pcm;rate=16000`. */
  mimeType?: string;
  /** BCP-47 code, or null to let the provider detect. */
  language?: string | null;
  /**
   * Ask for the verbose transcription response — per-segment timestamps and
   * the detected language, surfaced on `raw`. Honoured by the OpenAI-shaped
   * adapters only (`whisper`, `openai`, and only on models that support
   * `verbose_json` — `whisper-1` does, `gpt-4o-*-transcribe` do not). Gemini
   * returns plain text either way.
   */
  verbose?: boolean;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface TranscribeResult {
  /** The transcript. `''` means "no speech", never "it failed". */
  text: string;
  /** Which engine produced it (the resolved provider, not the requested one). */
  provider: SttProvider;
  /** The provider's parsed response body, for callers that want more. */
  raw?: unknown;
}

/**
 * Transcribe audio with one of `STT_PROVIDERS`.
 *
 * Resolves with `text: ''` when the audio held no speech. Rejects with
 * `SttError` when the provider could not be reached, refused the request, or
 * is not configured on this deployment — never a fallback, never a silent
 * empty string standing in for a failure.
 */
export async function transcribe(input: TranscribeInput): Promise<TranscribeResult> {
  const provider = input.provider ?? defaultSttProvider();
  const mimeType =
    input.mimeType ||
    (typeof Blob !== 'undefined' && input.audio instanceof Blob ? input.audio.type : '') ||
    'audio/webm';
  const language = input.language === undefined ? 'en' : input.language;
  const doFetch = input.fetchImpl ?? fetch;

  const verbose = input.verbose === true;

  switch (provider) {
    case 'whisper':
      return transcribeWhisper(input.audio, mimeType, language, verbose, doFetch, input.signal);
    case 'openai':
      return transcribeOpenAI(input.audio, mimeType, language, verbose, doFetch, input.signal);
    case 'gemini':
      return transcribeGemini(input.audio, mimeType, language, doFetch, input.signal);
    default: {
      // Unreachable while the switch covers STT_PROVIDERS; kept so adding a
      // provider to the array without an adapter fails loudly instead of
      // transcribing with the wrong engine.
      const unknown: never = provider;
      throw new SttError(
        'whisper',
        'unconfigured',
        `No adapter for STT provider '${String(unknown)}'`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Build the multipart body both OpenAI-shaped providers post. */
async function audioForm(audio: Uint8Array | Blob, mimeType: string): Promise<FormData> {
  const form = new FormData();
  const blob =
    typeof Blob !== 'undefined' && audio instanceof Blob
      ? audio
      : // Re-wrap so TS sees a Uint8Array<ArrayBuffer> (a plain Uint8Array is
        // typed over ArrayBufferLike, which BlobPart does not accept).
        new Blob([new Uint8Array(await toBytes(audio))], { type: mimeType });
  form.append('file', blob, `audio.${extensionFor(mimeType)}`);
  return form;
}

async function transcribeWhisper(
  audio: Uint8Array | Blob,
  mimeType: string,
  language: string | null,
  verbose: boolean,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const form = await audioForm(audio, mimeType);
  appendWhisperParams(form, language);
  if (verbose) form.append('response_format', 'verbose_json');

  let res: Response;
  try {
    res = await doFetch(`${sttUrl().replace(/\/$/, '')}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: whisperHeaders(),
      body: form,
      signal,
    });
  } catch (err) {
    throw new SttError('whisper', 'network', `whisper unreachable: ${errText(err)}`);
  }
  if (!res.ok) {
    throw new SttError(
      'whisper',
      res.status === 429 ? 'quota' : 'upstream',
      `whisper HTTP ${res.status}`,
      res.status,
    );
  }
  const json = await readTranscription(res);
  return { text: (json.text ?? '').trim(), provider: 'whisper', raw: json };
}

async function transcribeOpenAI(
  audio: Uint8Array | Blob,
  mimeType: string,
  language: string | null,
  verbose: boolean,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new SttError('openai', 'unconfigured', 'OPENAI_API_KEY is not set on this deployment');
  }

  const form = await audioForm(audio, mimeType);
  // The OpenAI API's own fields only. `vad_filter` is a faster-whisper
  // extension and is deliberately not sent here.
  form.append('model', openaiSttModel());
  form.append('temperature', '0');
  if (language) form.append('language', language);
  if (verbose) form.append('response_format', 'verbose_json');

  let res: Response;
  try {
    res = await doFetch(`${openaiSttUrl().replace(/\/$/, '')}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal,
    });
  } catch (err) {
    throw new SttError('openai', 'network', `openai unreachable: ${errText(err)}`);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = body.error?.message ?? `HTTP ${res.status}`;
    throw new SttError(
      'openai',
      res.status === 429 ? 'quota' : res.status === 415 ? 'unsupported-media' : 'upstream',
      `openai transcription failed: ${message}`,
      res.status,
    );
  }
  const json = await readTranscription(res);
  return { text: (json.text ?? '').trim(), provider: 'openai', raw: json };
}

/**
 * Read a transcription response. An OpenAI-compatible server may answer with
 * JSON or with bare text depending on `response_format`, and faster-whisper in
 * particular will happily send `text/plain` — parsing that as JSON would turn a
 * perfectly good transcript into an empty string.
 */
async function readTranscription(
  res: Response,
): Promise<{ text?: string; language?: string; segments?: unknown[] }> {
  const contentType = res.headers?.get?.('content-type') ?? '';
  if (contentType && !contentType.includes('json')) {
    return { text: await res.text().catch(() => '') };
  }
  return (await res.json().catch(() => ({}))) as { text?: string };
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string; code?: number };
}

async function transcribeGemini(
  audio: Uint8Array | Blob,
  mimeType: string,
  language: string | null,
  doFetch: typeof fetch,
  signal?: AbortSignal,
): Promise<TranscribeResult> {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new SttError(
      'gemini',
      'unconfigured',
      'GOOGLE_API_KEY is not set on this deployment',
    );
  }

  // Gemini takes containers, not headerless PCM. The live hub path forwards
  // raw `audio/pcm` off the WS, so wrap it before it ever leaves the process.
  let bytes = await toBytes(audio);
  let sendMime = mimeType;
  if (isRawPcm(mimeType)) {
    bytes = pcm16ToWav(bytes, pcmSampleRate(mimeType));
    sendMime = 'audio/wav';
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: GEMINI_STT_INSTRUCTION }] },
    contents: [
      {
        role: 'user',
        parts: [
          ...(language ? [{ text: `The speech is in ${language}.` }] : []),
          { inlineData: { mimeType: sendMime.split(';')[0].trim(), data: base64(bytes) } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: 'text/plain' },
  });

  const call = async (model: string) => {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
      `:generateContent?key=${encodeURIComponent(key)}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      throw new SttError('gemini', 'network', `gemini unreachable: ${errText(err)}`);
    }
    const json = (await res.json().catch(() => ({}))) as GeminiResponse;
    return { res, json };
  };

  let { res, json } = await call(geminiSttModel());

  // A lite model that will not take audio is a capability problem, not a
  // failure: retry once on the fuller model. Same vendor, same credential —
  // this is NOT the cross-provider fallback the module refuses to do.
  if (!res.ok && res.status === 400 && looksLikeAudioRefusal(json.error?.message)) {
    console.warn(
      `[voice/stt] gemini model ${geminiSttModel()} refused audio input; ` +
        `retrying on ${geminiSttFallbackModel()}`,
    );
    ({ res, json } = await call(geminiSttFallbackModel()));
  }

  if (!res.ok) {
    const message = json.error?.message ?? `HTTP ${res.status}`;
    const status = json.error?.status ?? '';
    // A spending cap or a rate limit must never reach a caller as an empty
    // transcript — that reads as "nobody spoke" and hides an outage.
    const quota = res.status === 429 || status === 'RESOURCE_EXHAUSTED';
    const media =
      res.status === 400 && /mime|unsupported|not supported|invalid argument/i.test(message);
    throw new SttError(
      'gemini',
      quota ? 'quota' : media ? 'unsupported-media' : 'upstream',
      `gemini transcription failed: ${message}`,
      res.status,
    );
  }

  if (json.promptFeedback?.blockReason) {
    throw new SttError(
      'gemini',
      'upstream',
      `gemini blocked the audio: ${json.promptFeedback.blockReason}`,
      res.status,
    );
  }

  const text = (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();

  return {
    text: isGeminiSilence(text) ? '' : text,
    provider: 'gemini',
    raw: json,
  };
}

/**
 * Does this 400 mean "this MODEL cannot take audio" rather than "your REQUEST
 * is wrong"? Only then is retrying on the fuller model worth a second call.
 *
 * Deliberately narrow. Matching the bare word "audio" would fire on
 * `Unsupported MIME type: audio/webm`, which the fuller model rejects just as
 * hard — a wasted round trip on every bad upload. So: a refusal phrasing, about
 * a modality, and NOT about the container format.
 */
function looksLikeAudioRefusal(message: string | undefined): boolean {
  if (!message) return false;
  const refusal = /(does ?n[o']?t support|not supported|unsupported|cannot accept)/i.test(message);
  const modality = /(audio|inline_?data|inlineData|modalit|multimodal)/i.test(message);
  const aboutContainer = /mime|codec|format/i.test(message);
  return refusal && modality && !aboutContainer;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
