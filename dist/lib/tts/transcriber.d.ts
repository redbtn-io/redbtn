/**
 * STT Transcriber
 *
 * Calls a Whisper-compatible STT server to transcribe audio into text.
 * The server runs on redServer (.3) at port 8787 with an OpenAI-compatible
 * audio transcription endpoint.
 *
 * @module lib/tts/transcriber
 */
/**
 * Options for audio transcription
 */
export interface TranscribeOptions {
    /** Language hint (e.g., 'en', 'es') */
    language?: string;
    /** Audio format hint (e.g., 'wav', 'mp3', 'webm') */
    format?: string;
    /** STT endpoint base URL (default: Whisper on .3:8787) */
    endpoint?: string;
}
/**
 * Result of audio transcription
 */
export interface TranscribeResult {
    /** The transcribed text */
    text: string;
    /** Detected language (if returned by the server) */
    language?: string;
    /** Audio duration in seconds (if returned by the server) */
    duration?: number;
}
/**
 * Transcribe audio to text using a Whisper-compatible STT server.
 *
 * Sends the audio as multipart/form-data to the OpenAI-compatible
 * `/v1/audio/transcriptions` endpoint.
 *
 * @param audio - Raw audio buffer (any format the server supports: wav, mp3, webm, etc.)
 * @param options - Language, format, and endpoint configuration
 * @returns Transcription result with text and optional metadata
 * @throws Error if transcription fails or times out
 */
export declare function transcribe(audio: Buffer, options?: TranscribeOptions): Promise<TranscribeResult>;
/**
 * Check if the STT server is reachable.
 *
 * Attempts a lightweight request to verify connectivity. Does not send
 * actual audio -- just checks that the server responds.
 *
 * @param endpoint - STT endpoint base URL
 * @returns true if the server is reachable
 */
export declare function isSttAvailable(endpoint?: string): Promise<boolean>;
