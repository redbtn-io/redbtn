"use strict";
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
exports.AudioStreamPipeline = void 0;
const chunker_1 = require("./chunker");
const synthesizer_1 = require("./synthesizer");
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
class AudioStreamPipeline {
    constructor(options) {
        this.chunker = new chunker_1.TtsChunker();
        this.jobs = [];
        this.publishedCount = 0;
        this.isPublishing = false;
        this.flushed = false;
        this.publisher = options.publisher;
        this.ttsOptions = options.ttsOptions || {};
    }
    /**
     * Push a text chunk from the LLM stream.
     * If the chunker emits a segment, synthesis is started immediately
     * in the background and queued for ordered publishing.
     *
     * This method never blocks -- synthesis runs in parallel.
     *
     * @param text - A text chunk from the LLM stream
     */
    push(text) {
        if (this.flushed)
            return;
        const segment = this.chunker.push(text);
        if (segment) {
            this.enqueueSynthesis(segment);
        }
    }
    /**
     * Flush the chunker and wait for all pending audio to be published.
     * Call this when the LLM stream completes.
     *
     * The final audio chunk will have `isFinal: true`.
     */
    flush() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.flushed)
                return;
            this.flushed = true;
            // Flush remaining text from chunker
            const remaining = this.chunker.flush();
            if (remaining) {
                this.enqueueSynthesis(remaining);
            }
            // Wait for all synthesis jobs to complete and publish
            yield this.drainQueue();
        });
    }
    /**
     * Get the number of audio chunks published so far.
     */
    get audioChunkCount() {
        return this.publishedCount;
    }
    // ---------------------------------------------------------------------------
    // Private
    // ---------------------------------------------------------------------------
    /**
     * Start synthesis for a text segment and add to the ordered queue.
     * Synthesis runs immediately in the background.
     */
    enqueueSynthesis(text) {
        const index = this.jobs.length;
        // Fire synthesis immediately (non-blocking)
        const promise = (0, synthesizer_1.synthesize)(text, this.ttsOptions).catch((error) => {
            console.warn(`[AudioStreamPipeline] TTS synthesis failed for chunk ${index}:`, error instanceof Error ? error.message : error);
            return null; // Swallow error -- text stream is unaffected
        });
        this.jobs.push({ index, text, promise });
        // Try to publish any completed jobs in order
        this.tryPublish();
    }
    /**
     * Attempt to publish completed jobs in order.
     * Only one publish loop runs at a time (via isPublishing flag).
     */
    tryPublish() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.isPublishing)
                return;
            this.isPublishing = true;
            try {
                while (this.publishedCount < this.jobs.length) {
                    const job = this.jobs[this.publishedCount];
                    const audio = yield job.promise;
                    if (audio) {
                        const isFinal = this.flushed && this.publishedCount === this.jobs.length - 1;
                        try {
                            yield this.publisher.publish({
                                type: 'audio_chunk',
                                audio: audio.toString('base64'),
                                index: job.index,
                                isFinal,
                                format: 'mp3',
                                timestamp: Date.now(),
                            });
                        }
                        catch (pubError) {
                            console.warn(`[AudioStreamPipeline] Failed to publish audio chunk ${job.index}:`, pubError instanceof Error ? pubError.message : pubError);
                        }
                    }
                    else if (this.flushed && this.publishedCount === this.jobs.length - 1) {
                        // Last chunk failed synthesis -- still publish a final marker with empty audio
                        try {
                            yield this.publisher.publish({
                                type: 'audio_chunk',
                                audio: '',
                                index: job.index,
                                isFinal: true,
                                format: 'mp3',
                                timestamp: Date.now(),
                            });
                        }
                        catch (_a) {
                            // Best effort
                        }
                    }
                    this.publishedCount++;
                }
            }
            finally {
                this.isPublishing = false;
            }
        });
    }
    /**
     * Wait for all jobs to be synthesized and published.
     */
    drainQueue() {
        return __awaiter(this, void 0, void 0, function* () {
            // Wait for all synthesis promises to settle
            yield Promise.allSettled(this.jobs.map((j) => j.promise));
            // Publish any remaining
            yield this.tryPublish();
        });
    }
}
exports.AudioStreamPipeline = AudioStreamPipeline;
