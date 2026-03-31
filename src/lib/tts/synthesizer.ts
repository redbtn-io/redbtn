/**
 * TTS Synthesizer
 *
 * Calls the Kokoro TTS server to convert text segments into MP3 audio.
 * The server runs on gammaWorker (.6) at port 8880 with an OpenAI-compatible
 * speech endpoint.
 *
 * @module lib/tts/synthesizer
 */

/** Default Kokoro TTS endpoint */
const DEFAULT_TTS_ENDPOINT = 'http://192.168.1.6:8880/v1/audio/speech';

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
  /** TTS endpoint URL (default: Kokoro on .6:8880) */
  endpoint?: string;
}

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
    voice = 'af_heart',
    speed = 1.0,
    endpoint = process.env.TTS_ENDPOINT || DEFAULT_TTS_ENDPOINT,
  } = options;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice,
        speed,
        response_format: 'mp3',
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
      throw new Error(`TTS synthesis timed out after ${TTS_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
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
  endpoint: string = process.env.TTS_ENDPOINT || DEFAULT_TTS_ENDPOINT,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'kokoro',
          input: 'test',
          voice: 'af_heart',
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
