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

import { TtsChunker } from './chunker';
import { synthesize, type SynthesizeOptions } from './synthesizer';
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
 * A queued synthesis job
 */
interface SynthesisJob {
  index: number;
  text: string;
  promise: Promise<Buffer | null>;
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
export class AudioStreamPipeline {
  private chunker = new TtsChunker();
  private publisher: RunPublisher;
  private ttsOptions: SynthesizeOptions;
  private jobs: SynthesisJob[] = [];
  private publishedCount = 0;
  private isPublishing = false;
  private flushed = false;

  constructor(options: AudioStreamPipelineOptions) {
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
  push(text: string): void {
    if (this.flushed) return;

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
  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;

    // Flush remaining text from chunker
    const remaining = this.chunker.flush();
    if (remaining) {
      this.enqueueSynthesis(remaining);
    }

    // Wait for all synthesis jobs to complete and publish
    await this.drainQueue();
  }

  /**
   * Get the number of audio chunks published so far.
   */
  get audioChunkCount(): number {
    return this.publishedCount;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /**
   * Start synthesis for a text segment and add to the ordered queue.
   * Synthesis runs immediately in the background.
   */
  private enqueueSynthesis(text: string): void {
    const index = this.jobs.length;

    // Fire synthesis immediately (non-blocking)
    const promise = synthesize(text, this.ttsOptions).catch((error) => {
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
  private async tryPublish(): Promise<void> {
    if (this.isPublishing) return;
    this.isPublishing = true;

    try {
      while (this.publishedCount < this.jobs.length) {
        const job = this.jobs[this.publishedCount];
        const audio = await job.promise;

        if (audio) {
          const isFinal = this.flushed && this.publishedCount === this.jobs.length - 1;
          try {
            await this.publisher.publish({
              type: 'audio_chunk' as any,
              audio: audio.toString('base64'),
              index: job.index,
              isFinal,
              format: 'mp3',
              timestamp: Date.now(),
            });
          } catch (pubError) {
            console.warn(`[AudioStreamPipeline] Failed to publish audio chunk ${job.index}:`, pubError instanceof Error ? pubError.message : pubError);
          }
        } else if (this.flushed && this.publishedCount === this.jobs.length - 1) {
          // Last chunk failed synthesis -- still publish a final marker with empty audio
          try {
            await this.publisher.publish({
              type: 'audio_chunk' as any,
              audio: '',
              index: job.index,
              isFinal: true,
              format: 'mp3',
              timestamp: Date.now(),
            });
          } catch {
            // Best effort
          }
        }

        this.publishedCount++;
      }
    } finally {
      this.isPublishing = false;
    }
  }

  /**
   * Wait for all jobs to be synthesized and published.
   */
  private async drainQueue(): Promise<void> {
    // Wait for all synthesis promises to settle
    await Promise.allSettled(this.jobs.map((j) => j.promise));
    // Publish any remaining
    await this.tryPublish();
  }
}
