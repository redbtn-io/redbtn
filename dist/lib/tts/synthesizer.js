"use strict";
/**
 * TTS Synthesizer
 *
 * Calls the Kokoro TTS server to convert text segments into MP3 audio.
 * The server runs on gammaWorker (.6) at port 8880 with an OpenAI-compatible
 * speech endpoint.
 *
 * @module lib/tts/synthesizer
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
exports.synthesize = synthesize;
exports.isTtsAvailable = isTtsAvailable;
/** Default Kokoro TTS endpoint */
const DEFAULT_TTS_ENDPOINT = 'http://192.168.1.6:8880/v1/audio/speech';
/** Request timeout in milliseconds */
const TTS_TIMEOUT_MS = 15000;
/**
 * Synthesize text to MP3 audio using Kokoro TTS.
 *
 * @param text - The text to synthesize
 * @param options - Voice, speed, and endpoint configuration
 * @returns Raw MP3 audio buffer
 * @throws Error if synthesis fails or times out
 */
function synthesize(text_1) {
    return __awaiter(this, arguments, void 0, function* (text, options = {}) {
        const { voice = 'af_heart', speed = 1.0, endpoint = process.env.TTS_ENDPOINT || DEFAULT_TTS_ENDPOINT, } = options;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);
        try {
            const response = yield fetch(endpoint, {
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
                const body = yield response.text().catch(() => '');
                throw new Error(`TTS synthesis failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ''}`);
            }
            const arrayBuffer = yield response.arrayBuffer();
            return Buffer.from(arrayBuffer);
        }
        catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`TTS synthesis timed out after ${TTS_TIMEOUT_MS}ms`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    });
}
/**
 * Check if the TTS server is reachable.
 * Sends a minimal synthesis request to verify connectivity.
 *
 * @param endpoint - TTS endpoint URL
 * @returns true if the server responds successfully
 */
function isTtsAvailable() {
    return __awaiter(this, arguments, void 0, function* (endpoint = process.env.TTS_ENDPOINT || DEFAULT_TTS_ENDPOINT) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            try {
                const response = yield fetch(endpoint, {
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
