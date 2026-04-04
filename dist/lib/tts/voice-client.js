"use strict";
/**
 * VoiceClient
 *
 * Unified facade for STT (Whisper) and TTS (Kokoro) services.
 * Provides a single configurable class that any Node.js consumer
 * (Discord bot, webapp API, worker) can instantiate for voice I/O
 * without reimplementing HTTP calls.
 *
 * @module lib/tts/voice-client
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
exports.VoiceClient = void 0;
const synthesizer_1 = require("./synthesizer");
const transcriber_1 = require("./transcriber");
const audio_stream_1 = require("./audio-stream");
/** Default TTS base URL (Kokoro on gammaWorker) */
const DEFAULT_TTS_URL = 'http://192.168.1.6:8880';
/** Default STT base URL (Whisper on redServer) */
const DEFAULT_STT_URL = 'http://192.168.1.3:8787';
/**
 * Unified voice client wrapping STT (Whisper) and TTS (Kokoro) services.
 *
 * Usage:
 * ```typescript
 * const voice = new VoiceClient({ voice: 'af_heart', speed: 1.1 });
 *
 * // Transcribe audio
 * const result = await voice.transcribe(audioBuffer);
 * console.log(result.text);
 *
 * // Synthesize text
 * const mp3 = await voice.synthesize('Hello, world!');
 *
 * // Check availability
 * const [tts, stt] = await Promise.all([
 *   voice.isTtsAvailable(),
 *   voice.isSttAvailable(),
 * ]);
 * ```
 */
class VoiceClient {
    constructor(options = {}) {
        this.ttsUrl = options.ttsUrl || process.env.TTS_URL || DEFAULT_TTS_URL;
        this.sttUrl = options.sttUrl || process.env.STT_URL || DEFAULT_STT_URL;
        this.defaultVoice = options.voice || 'af_heart';
        this.defaultSpeed = options.speed || 1.0;
    }
    /**
     * Transcribe audio to text using Whisper STT.
     *
     * @param audio - Raw audio buffer (wav, mp3, webm, etc.)
     * @param options - Language and format hints
     * @returns Transcription result with text and optional metadata
     */
    transcribe(audio_1) {
        return __awaiter(this, arguments, void 0, function* (audio, options = {}) {
            return (0, transcriber_1.transcribe)(audio, Object.assign(Object.assign({}, options), { endpoint: options.endpoint || this.sttUrl }));
        });
    }
    /**
     * Synthesize text to MP3 audio using Kokoro TTS.
     *
     * @param text - The text to synthesize
     * @param options - Voice and speed overrides
     * @returns Raw MP3 audio buffer
     */
    synthesize(text_1) {
        return __awaiter(this, arguments, void 0, function* (text, options = {}) {
            const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
            return (0, synthesizer_1.synthesize)(text, {
                voice: options.voice || this.defaultVoice,
                speed: options.speed || this.defaultSpeed,
                endpoint: ttsEndpoint,
            });
        });
    }
    /**
     * Create a streaming TTS pipeline for progressive audio generation.
     *
     * The pipeline accepts text chunks from an LLM stream, segments them
     * at natural break points, synthesizes audio in parallel, and publishes
     * ordered audio chunks via the provided RunPublisher.
     *
     * @param publisher - RunPublisher for emitting audio_chunk events
     * @param options - Additional TTS options (voice, speed overrides)
     * @returns A new AudioStreamPipeline instance
     */
    createStreamingTts(publisher, options = {}) {
        const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
        const pipelineOptions = {
            publisher,
            ttsOptions: {
                voice: options.voice || this.defaultVoice,
                speed: options.speed || this.defaultSpeed,
                endpoint: ttsEndpoint,
            },
        };
        return new audio_stream_1.AudioStreamPipeline(pipelineOptions);
    }
    /**
     * Check if the TTS (Kokoro) service is reachable.
     *
     * @returns true if the server responds successfully
     */
    isTtsAvailable() {
        return __awaiter(this, void 0, void 0, function* () {
            const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
            return (0, synthesizer_1.isTtsAvailable)(ttsEndpoint);
        });
    }
    /**
     * Check if the STT (Whisper) service is reachable.
     *
     * @returns true if the server responds successfully
     */
    isSttAvailable() {
        return __awaiter(this, void 0, void 0, function* () {
            return (0, transcriber_1.isSttAvailable)(this.sttUrl);
        });
    }
}
exports.VoiceClient = VoiceClient;
