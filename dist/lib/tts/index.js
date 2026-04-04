"use strict";
/**
 * TTS / Voice Module
 *
 * Server-side text-to-speech and speech-to-text pipeline for voice I/O.
 *
 * Components:
 * - TtsChunker: Splits streaming text into natural segments
 * - synthesize: Calls Kokoro TTS endpoint
 * - transcribe: Calls Whisper STT endpoint
 * - AudioStreamPipeline: Orchestrates chunking + synthesis + publishing
 * - VoiceClient: Unified facade wrapping STT + TTS into a single API
 *
 * @module lib/tts
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.VoiceClient = exports.AudioStreamPipeline = exports.isSttAvailable = exports.transcribe = exports.isTtsAvailable = exports.synthesize = exports.findBreakPoint = exports.TtsChunker = void 0;
var chunker_1 = require("./chunker");
Object.defineProperty(exports, "TtsChunker", { enumerable: true, get: function () { return chunker_1.TtsChunker; } });
Object.defineProperty(exports, "findBreakPoint", { enumerable: true, get: function () { return chunker_1.findBreakPoint; } });
var synthesizer_1 = require("./synthesizer");
Object.defineProperty(exports, "synthesize", { enumerable: true, get: function () { return synthesizer_1.synthesize; } });
Object.defineProperty(exports, "isTtsAvailable", { enumerable: true, get: function () { return synthesizer_1.isTtsAvailable; } });
var transcriber_1 = require("./transcriber");
Object.defineProperty(exports, "transcribe", { enumerable: true, get: function () { return transcriber_1.transcribe; } });
Object.defineProperty(exports, "isSttAvailable", { enumerable: true, get: function () { return transcriber_1.isSttAvailable; } });
var audio_stream_1 = require("./audio-stream");
Object.defineProperty(exports, "AudioStreamPipeline", { enumerable: true, get: function () { return audio_stream_1.AudioStreamPipeline; } });
var voice_client_1 = require("./voice-client");
Object.defineProperty(exports, "VoiceClient", { enumerable: true, get: function () { return voice_client_1.VoiceClient; } });
