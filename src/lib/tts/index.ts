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

export { TtsChunker, findBreakPoint } from './chunker';
export { synthesize, isTtsAvailable, type SynthesizeOptions } from './synthesizer';
export { transcribe, isSttAvailable, type TranscribeOptions, type TranscribeResult } from './transcriber';
export { AudioStreamPipeline, type AudioStreamPipelineOptions } from './audio-stream';
export { VoiceClient, type VoiceClientOptions } from './voice-client';
