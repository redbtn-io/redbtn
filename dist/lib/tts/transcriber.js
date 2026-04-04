"use strict";
/**
 * STT Transcriber
 *
 * Calls a Whisper-compatible STT server to transcribe audio into text.
 * The server runs on redServer (.3) at port 8787 with an OpenAI-compatible
 * audio transcription endpoint.
 *
 * @module lib/tts/transcriber
 */
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.transcribe = transcribe;
exports.isSttAvailable = isSttAvailable;
/** Default Whisper STT endpoint */
const DEFAULT_STT_ENDPOINT = 'http://192.168.1.3:8787';
/** Request timeout in milliseconds */
const STT_TIMEOUT_MS = 30000;
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
function transcribe(audio_1) {
    return __awaiter(this, arguments, void 0, function* (audio, options = {}) {
        const { language, format, endpoint = process.env.STT_URL || DEFAULT_STT_ENDPOINT, } = options;
        const url = `${endpoint.replace(/\/$/, '')}/v1/audio/transcriptions`;
        // Determine a reasonable filename extension for the audio
        const ext = format || 'wav';
        const filename = `audio.${ext}`;
        // Build multipart form data using Node.js built-in FormData
        const formData = new FormData();
        // Copy into a plain ArrayBuffer to satisfy TypeScript's strict Blob typing
        const arrayBuffer = audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength);
        const blob = new Blob([arrayBuffer], { type: `audio/${ext}` });
        formData.append('file', blob, filename);
        formData.append('model', 'whisper-1');
        if (language) {
            formData.append('language', language);
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), STT_TIMEOUT_MS);
        try {
            const response = yield fetch(url, {
                method: 'POST',
                body: formData,
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = yield response.text().catch(() => '');
                throw new Error(`STT transcription failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
            }
            const data = yield response.json();
            return {
                text: data.text || '',
                language: data.language,
                duration: data.duration,
            };
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`STT transcription timed out after ${STT_TIMEOUT_MS}ms`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    });
}
/**
 * Check if the STT server is reachable.
 *
 * Attempts a lightweight request to verify connectivity. Does not send
 * actual audio -- just checks that the server responds.
 *
 * @param endpoint - STT endpoint base URL
 * @returns true if the server is reachable
 */
function isSttAvailable() {
    return __awaiter(this, arguments, void 0, function* (endpoint = process.env.STT_URL || DEFAULT_STT_ENDPOINT) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                // Send a minimal transcription request with a tiny silent WAV
                // (44 bytes = smallest valid WAV header with no samples)
                const silentWav = Buffer.alloc(44);
                // RIFF header
                silentWav.write('RIFF', 0);
                silentWav.writeUInt32LE(36, 4); // file size - 8
                silentWav.write('WAVE', 8);
                // fmt chunk
                silentWav.write('fmt ', 12);
                silentWav.writeUInt32LE(16, 16); // chunk size
                silentWav.writeUInt16LE(1, 20); // PCM format
                silentWav.writeUInt16LE(1, 22); // mono
                silentWav.writeUInt32LE(16000, 24); // sample rate
                silentWav.writeUInt32LE(32000, 28); // byte rate
                silentWav.writeUInt16LE(2, 32); // block align
                silentWav.writeUInt16LE(16, 34); // bits per sample
                // data chunk
                silentWav.write('data', 36);
                silentWav.writeUInt32LE(0, 40); // data size (0 samples)
                const formData = new FormData();
                const wavBuffer = silentWav.buffer.slice(silentWav.byteOffset, silentWav.byteOffset + silentWav.byteLength);
                const blob = new Blob([wavBuffer], { type: 'audio/wav' });
                formData.append('file', blob, 'test.wav');
                formData.append('model', 'whisper-1');
                const url = `${endpoint.replace(/\/$/, '')}/v1/audio/transcriptions`;
                const response = yield fetch(url, {
                    method: 'POST',
                    body: formData,
                    signal: controller.signal,
                });
                // Any response (even 400 for empty audio) means the server is up
                return response.status < 500;
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (_a) {
            return false;
        }
    });
}
