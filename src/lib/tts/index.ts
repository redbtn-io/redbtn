/**
 * TTS Module
 *
 * Server-side text-to-speech pipeline for streaming audio alongside LLM text.
 *
 * Components:
 * - TtsChunker: Splits streaming text into natural segments
 * - synthesize: Calls Kokoro TTS endpoint
 * - AudioStreamPipeline: Orchestrates chunking + synthesis + publishing
 *
 * @module lib/tts
 */

export { TtsChunker, findBreakPoint } from './chunker';
export { synthesize, isTtsAvailable, type SynthesizeOptions } from './synthesizer';
export { AudioStreamPipeline, type AudioStreamPipelineOptions } from './audio-stream';
