/**
 * TTS Synthesizer
 *
 * Calls the Kokoro TTS server to convert text segments into MP3 audio.
 * The server runs on gammaWorker (.6) at port 8880 with an OpenAI-compatible
 * speech endpoint.
 *
 * @module lib/tts/synthesizer
 */
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
export declare function synthesize(text: string, options?: SynthesizeOptions): Promise<Buffer>;
/**
 * Check if the TTS server is reachable.
 * Sends a minimal synthesis request to verify connectivity.
 *
 * @param endpoint - TTS endpoint URL
 * @returns true if the server responds successfully
 */
export declare function isTtsAvailable(endpoint?: string): Promise<boolean>;
