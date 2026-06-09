/**
 * TTS Synthesizer
 *
 * Calls the Kokoro TTS server to convert text segments into MP3 audio.
 * The server runs on gammaWorker (.6) at port 8880 with an OpenAI-compatible
 * speech endpoint.
 *
 * @module lib/tts/synthesizer
 */

/** Default Kokoro TTS base URL */
const DEFAULT_TTS_BASE = 'http://192.168.1.6:8880';

/**
 * Canonical default voice for all Kokoro TTS calls.
 * Import this constant in every consumer to keep a single source of truth.
 */
export const KOKORO_DEFAULT_VOICE = 'af_heart';

/** TTS path on the Kokoro endpoint (OpenAI-compatible) */
const TTS_SPEECH_PATH = '/v1/audio/speech';

/**
 * Resolve the TTS endpoint URL.
 *
 * Priority order:
 * 1. Caller-supplied `endpoint` option (explicit override, full URL)
 * 2. `TTS_URL` env var (base URL — path appended by this function)
 * 3. `TTS_ENDPOINT` env var (legacy — treated as full URL, no path appended)
 * 4. Hard-coded default base + path
 */
function resolveTtsEndpoint(endpoint?: string): string {
  if (endpoint) return endpoint;
  if (process.env.TTS_URL) {
    return process.env.TTS_URL.replace(/\/$/, '') + TTS_SPEECH_PATH;
  }
  if (process.env.TTS_ENDPOINT) {
    // Legacy: already includes the full path
    return process.env.TTS_ENDPOINT;
  }
  return DEFAULT_TTS_BASE + TTS_SPEECH_PATH;
}

/** Request timeout in milliseconds */
const TTS_TIMEOUT_MS = 15000;

/**
 * Options for TTS synthesis
 */
export interface SynthesizeOptions {
  /** Voice to use (default: 'af_heart') */
  voice?: string;
  /** Speech speed multiplier (default: 1.0) */
  speed?: number;
  /** TTS endpoint URL (full URL — overrides TTS_URL / TTS_ENDPOINT env vars) */
  endpoint?: string;
  /** Optional AbortSignal to cancel an in-flight synthesis request */
  signal?: AbortSignal;
  /**
   * Output format (default: 'mp3').
   *
   * 'pcm' = raw 16-bit little-endian mono PCM at 24 kHz (Kokoro's native
   * rate — verified empirically). The STREAMING pipeline must use 'pcm':
   * the chat client's AudioPlaybackQueue decodes raw PCM16 chunks (it has
   * no MP3 demuxer, and MP3 frames don't survive arbitrary chunk-boundary
   * splits anyway). 'mp3' remains the default for whole-utterance callers
   * (the synthesize_speech tool, file output).
   */
  format?: 'mp3' | 'pcm';
}

/** Sample rate of Kokoro's raw PCM output (16-bit LE mono). */
export const KOKORO_PCM_SAMPLE_RATE = 24000;

/**
 * Synthesize text to MP3 audio using Kokoro TTS.
 *
 * @param text - The text to synthesize
 * @param options - Voice, speed, and endpoint configuration
 * @returns Raw MP3 audio buffer
 * @throws Error if synthesis fails or times out
 */
export async function synthesize(
  text: string,
  options: SynthesizeOptions = {},
): Promise<Buffer> {
  const {
    voice = KOKORO_DEFAULT_VOICE,
    speed = 1.0,
    endpoint,
    signal: callerSignal,
    format = 'mp3',
  } = options;
  const resolvedEndpoint = resolveTtsEndpoint(endpoint);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  // Also abort when the caller's signal fires (e.g. run cancelled)
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      throw new Error('TTS synthesis aborted');
    }
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const response = await fetch(resolvedEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice,
        speed,
        response_format: format,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`TTS synthesis failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Distinguish a caller-initiated cancel from a timeout
      if (callerSignal?.aborted) {
        throw new Error('TTS synthesis cancelled');
      }
      throw new Error(`TTS synthesis timed out after ${TTS_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (callerSignal) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Check if the TTS server is reachable.
 * Sends a minimal synthesis request to verify connectivity.
 *
 * @param endpoint - TTS endpoint URL
 * @returns true if the server responds successfully
 */
export async function isTtsAvailable(
  endpoint?: string,
): Promise<boolean> {
  const resolvedEndpoint = resolveTtsEndpoint(endpoint);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          input: 'test',
          voice: KOKORO_DEFAULT_VOICE,
          speed: 1.0,
          response_format: 'mp3',
        }),
        signal: controller.signal,
      });
      return response.ok;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}
