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

import { synthesize, isTtsAvailable, type SynthesizeOptions } from './synthesizer';
import { transcribe, isSttAvailable, type TranscribeOptions, type TranscribeResult } from './transcriber';
import { AudioStreamPipeline, type AudioStreamPipelineOptions } from './audio-stream';
import type { RunPublisher } from '../run/run-publisher';

/**
 * Configuration for VoiceClient
 */
export interface VoiceClientOptions {
  /** TTS (Kokoro) endpoint URL. Default: env TTS_URL or http://192.168.1.6:8880 */
  ttsUrl?: string;
  /** STT (Whisper) endpoint URL. Default: env STT_URL or http://192.168.1.3:8787 */
  sttUrl?: string;
  /** Default voice for TTS synthesis (default: 'af_heart') */
  voice?: string;
  /** Default speech speed multiplier (default: 1.0) */
  speed?: number;
}

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
export class VoiceClient {
  private readonly ttsUrl: string;
  private readonly sttUrl: string;
  private readonly defaultVoice: string;
  private readonly defaultSpeed: number;

  constructor(options: VoiceClientOptions = {}) {
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
  async transcribe(audio: Buffer, options: TranscribeOptions = {}): Promise<TranscribeResult> {
    return transcribe(audio, {
      ...options,
      endpoint: options.endpoint || this.sttUrl,
    });
  }

  /**
   * Synthesize text to MP3 audio using Kokoro TTS.
   *
   * @param text - The text to synthesize
   * @param options - Voice and speed overrides
   * @returns Raw MP3 audio buffer
   */
  async synthesize(
    text: string,
    options: { voice?: string; speed?: number } = {},
  ): Promise<Buffer> {
    const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
    return synthesize(text, {
      voice: options.voice || this.defaultVoice,
      speed: options.speed || this.defaultSpeed,
      endpoint: ttsEndpoint,
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
  createStreamingTts(
    publisher: RunPublisher,
    options: { voice?: string; speed?: number } = {},
  ): AudioStreamPipeline {
    const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
    const pipelineOptions: AudioStreamPipelineOptions = {
      publisher,
      ttsOptions: {
        voice: options.voice || this.defaultVoice,
        speed: options.speed || this.defaultSpeed,
        endpoint: ttsEndpoint,
      },
    };
    return new AudioStreamPipeline(pipelineOptions);
  }

  /**
   * Check if the TTS (Kokoro) service is reachable.
   *
   * @returns true if the server responds successfully
   */
  async isTtsAvailable(): Promise<boolean> {
    const ttsEndpoint = `${this.ttsUrl.replace(/\/$/, '')}/v1/audio/speech`;
    return isTtsAvailable(ttsEndpoint);
  }

  /**
   * Check if the STT (Whisper) service is reachable.
   *
   * @returns true if the server responds successfully
   */
  async isSttAvailable(): Promise<boolean> {
    return isSttAvailable(this.sttUrl);
  }
}
