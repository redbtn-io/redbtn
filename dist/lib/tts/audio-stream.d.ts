/**
 * Audio Stream Pipeline
 *
 * Orchestrates the TTS pipeline during streaming LLM responses:
 * 1. Receives text chunks from the LLM stream
 * 2. Splits text into TTS-ready segments via TtsChunker
 * 3. Synthesizes audio in parallel via ordered queue
 * 4. Publishes audio chunks via RunPublisher (never blocks text streaming)
 *
 * The pipeline ensures:
 * - Audio chunks are published in order (matching text order)
 * - TTS synthesis runs in parallel with text streaming
 * - Failures are swallowed gracefully (text stream unaffected)
 * - All pending synthesis completes before isFinal is sent
 *
 * @module lib/tts/audio-stream
 */
import { type SynthesizeOptions } from './synthesizer';
import type { RunPublisher } from '../run/run-publisher';
/**
 * Options for creating an AudioStreamPipeline
 */
export interface AudioStreamPipelineOptions {
    /** RunPublisher to emit audio_chunk events */
    publisher: RunPublisher;
    /** TTS synthesis options (voice, speed, endpoint) */
    ttsOptions?: SynthesizeOptions;
}
/**
 * AudioStreamPipeline
 *
 * Manages the lifecycle of TTS audio generation alongside LLM text streaming.
 * Text chunks flow in via `push()`, audio chunks flow out via RunPublisher.
 *
 * Usage:
 * ```typescript
 * const pipeline = new AudioStreamPipeline({ publisher, ttsOptions: { voice: 'af_heart' } });
 * // In the LLM streaming loop:
 * for (const textChunk of llmStream) {
 *   pipeline.push(textChunk);
 * }
 * // After stream completes:
 * await pipeline.flush();
 * ```
 */
export declare class AudioStreamPipeline {
    private chunker;
    private publisher;
    private ttsOptions;
    private jobs;
    private publishedCount;
    private isPublishing;
    private flushed;
    constructor(options: AudioStreamPipelineOptions);
    /**
     * Push a text chunk from the LLM stream.
     * If the chunker emits a segment, synthesis is started immediately
     * in the background and queued for ordered publishing.
     *
     * This method never blocks -- synthesis runs in parallel.
     *
     * @param text - A text chunk from the LLM stream
     */
    push(text: string): void;
    /**
     * Flush the chunker and wait for all pending audio to be published.
     * Call this when the LLM stream completes.
     *
     * The final audio chunk will have `isFinal: true`.
     */
    flush(): Promise<void>;
    /**
     * Get the number of audio chunks published so far.
     */
    get audioChunkCount(): number;
    /**
     * Start synthesis for a text segment and add to the ordered queue.
     * Synthesis runs immediately in the background.
     */
    private enqueueSynthesis;
    /**
     * Attempt to publish completed jobs in order.
     * Only one publish loop runs at a time (via isPublishing flag).
     */
    private tryPublish;
    /**
     * Wait for all jobs to be synthesized and published.
     */
    private drainQueue;
}
