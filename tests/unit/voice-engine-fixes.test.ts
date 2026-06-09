/**
 * Tests for voice engine fixes (fix/voice-engine-v1):
 *
 *   Fix 1 — audio_chunk events forwarded to conversation stream
 *   Fix 4 — AudioStreamPipeline.cancel() aborts in-flight synthesis
 *
 * Both tests are fully offline — no Redis, no MongoDB, no Kokoro server.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioStreamPipeline } from '../../src/lib/tts/audio-stream';
import { synthesize } from '../../src/lib/tts/synthesizer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal RunPublisher mock that records publish() calls. */
function makePublisherMock() {
  const published: Array<Record<string, unknown>> = [];
  return {
    published,
    // publish() is what AudioStreamPipeline calls directly
    async publish(event: Record<string, unknown>) {
      published.push(event);
    },
    // Named methods used by RunPublisher — not called by AudioStreamPipeline directly
    publishAudioChunk: vi.fn(),
  };
}

/** Build a minimal ConversationPublisher mock. */
function makeConvPublisherMock() {
  const audioChunkCalls: Array<{ messageId: string; data: string; mimeType: string }> = [];
  return {
    audioChunkCalls,
    async publishAudioChunk(messageId: string, data: string, mimeType: string) {
      audioChunkCalls.push({ messageId, data, mimeType });
    },
  };
}

// ---------------------------------------------------------------------------
// Fix 1: audio_chunk forwarded to conversation stream via RunPublisher.publish()
// ---------------------------------------------------------------------------

describe('Fix 1 — audio_chunk conversation forward', () => {
  /**
   * Simulate what RunPublisher.publish() does when it receives an audio_chunk
   * event: it should call convPublisher.publishAudioChunk() with the correct
   * messageId, base64 data, and mimeType derived from the format field.
   *
   * We test the logic extracted from run-publisher.ts directly (no Redis
   * dependency) by replicating the conditional block inline.
   */
  function applyAudioChunkForward(
    event: Record<string, unknown>,
    convPublisher: ReturnType<typeof makeConvPublisherMock> | null,
    convMessageId: string | null,
  ) {
    if (event.type === 'audio_chunk' && convPublisher && convMessageId) {
      const audioEvent = event as any;
      const mimeType =
        audioEvent.format === 'mp3'
          ? 'audio/mpeg'
          : `audio/${audioEvent.format ?? 'mpeg'}`;
      // Fire-and-forget (match the pattern in run-publisher.ts)
      convPublisher
        .publishAudioChunk(convMessageId, audioEvent.audio ?? '', mimeType)
        .catch(() => {});
    }
  }

  test('forwards mp3 audio_chunk to conv stream with audio/mpeg mimeType', async () => {
    const conv = makeConvPublisherMock();
    const event = {
      type: 'audio_chunk',
      audio: 'dGVzdGF1ZGlv', // base64 "testaudio"
      index: 0,
      isFinal: false,
      format: 'mp3',
      timestamp: Date.now(),
    };

    applyAudioChunkForward(event, conv, 'msg-abc123');
    // Give the fire-and-forget a tick to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(conv.audioChunkCalls).toHaveLength(1);
    expect(conv.audioChunkCalls[0].messageId).toBe('msg-abc123');
    expect(conv.audioChunkCalls[0].data).toBe('dGVzdGF1ZGlv');
    expect(conv.audioChunkCalls[0].mimeType).toBe('audio/mpeg');
  });

  test('forwards chunk with unknown format using audio/<format> mimeType', async () => {
    const conv = makeConvPublisherMock();
    const event = {
      type: 'audio_chunk',
      audio: 'YWJj',
      index: 1,
      isFinal: true,
      format: 'ogg',
      timestamp: Date.now(),
    };

    applyAudioChunkForward(event, conv, 'msg-xyz');
    await new Promise((r) => setTimeout(r, 0));

    expect(conv.audioChunkCalls[0].mimeType).toBe('audio/ogg');
  });

  test('does NOT forward when convPublisher is null', async () => {
    const event = {
      type: 'audio_chunk',
      audio: 'abc',
      index: 0,
      isFinal: false,
      format: 'mp3',
      timestamp: Date.now(),
    };
    // No throw expected; nothing to assert beyond no errors
    applyAudioChunkForward(event, null, 'msg-123');
    // Pass
  });

  test('does NOT forward when convMessageId is null', async () => {
    const conv = makeConvPublisherMock();
    const event = {
      type: 'audio_chunk',
      audio: 'abc',
      index: 0,
      isFinal: false,
      format: 'mp3',
      timestamp: Date.now(),
    };
    applyAudioChunkForward(event, conv, null);
    await new Promise((r) => setTimeout(r, 0));
    expect(conv.audioChunkCalls).toHaveLength(0);
  });

  test('does NOT forward for non-audio_chunk event types', async () => {
    const conv = makeConvPublisherMock();
    const event = { type: 'chunk', content: 'hello', timestamp: Date.now() };
    applyAudioChunkForward(event, conv, 'msg-123');
    await new Promise((r) => setTimeout(r, 0));
    expect(conv.audioChunkCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: AudioStreamPipeline.cancel() — aborts in-flight synthesis
// ---------------------------------------------------------------------------

describe('Fix 4 — AudioStreamPipeline cancel()', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalTtsUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalTtsUrl = process.env.TTS_URL;
    process.env.TTS_URL = 'http://test-kokoro.local:8880';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalTtsUrl === undefined) delete process.env.TTS_URL;
    else process.env.TTS_URL = originalTtsUrl;
    vi.restoreAllMocks();
  });

  test('cancel() before push() prevents any synthesis', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const publisher = makePublisherMock();
    const pipeline = new AudioStreamPipeline({ publisher: publisher as any });

    pipeline.cancel();
    pipeline.push('Hello world, this is some text');
    await pipeline.flush(); // should resolve immediately

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(publisher.published).toHaveLength(0);
  });

  test('cancel() during pending synthesis resolves flush() immediately', async () => {
    // Set up a fetch that hangs indefinitely until the abort signal fires
    let abortReceived = false;
    globalThis.fetch = vi.fn((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal | undefined = (init as any)?.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            abortReceived = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
        // Never resolves on its own — only via abort
      });
    }) as any;

    const publisher = makePublisherMock();
    const pipeline = new AudioStreamPipeline({ publisher: publisher as any });

    // Push enough text with a sentence break to make the chunker emit a segment.
    // The chunker needs >= 30 chars and a natural break point.
    pipeline.push('This is a complete sentence that is long enough. Cancel now.');

    // Yield a tick so synthesize() can reach its fetch() call before we cancel.
    await new Promise((r) => setTimeout(r, 0));

    // Cancel after synthesis is in-flight
    pipeline.cancel();

    // flush() should resolve quickly (flushed flag already set by cancel)
    const flushStart = Date.now();
    await pipeline.flush();
    const elapsed = Date.now() - flushStart;

    // Should resolve in well under 1s (not wait for the 15s timeout)
    expect(elapsed).toBeLessThan(500);
    // The abort signal should have fired into the hanging fetch.
    // Give enough macrotask ticks for the two-hop abort chain
    // (pipeline.controller → synthesizer callerSignal listener → fetch signal)
    // to settle fully.
    await new Promise((r) => setTimeout(r, 50));
    expect(abortReceived).toBe(true);
    // No audio events should have been published
    expect(publisher.published).toHaveLength(0);
  });

  test('cancel() via external AbortSignal aborts synthesis', async () => {
    let abortReceived = false;
    globalThis.fetch = vi.fn((_url, init) => {
      return new Promise((_resolve, reject) => {
        const sig: AbortSignal | undefined = (init as any)?.signal;
        if (sig) {
          sig.addEventListener('abort', () => {
            abortReceived = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }
      });
    }) as any;

    const publisher = makePublisherMock();
    const externalController = new AbortController();
    const pipeline = new AudioStreamPipeline({
      publisher: publisher as any,
      signal: externalController.signal,
    });

    // Push enough text with a sentence break to trigger the chunker
    pipeline.push('This is a complete sentence that is long enough. Abort now.');

    // Yield a tick so synthesize() reaches its fetch() call
    await new Promise((r) => setTimeout(r, 0));

    // Abort via the external signal (simulates run abort)
    externalController.abort();

    const flushStart = Date.now();
    await pipeline.flush();
    const elapsed = Date.now() - flushStart;

    expect(elapsed).toBeLessThan(500);
    // Allow time for the abort chain to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(abortReceived).toBe(true);
    expect(publisher.published).toHaveLength(0);
  });

  test('cancel() is idempotent — safe to call multiple times', () => {
    const publisher = makePublisherMock();
    const pipeline = new AudioStreamPipeline({ publisher: publisher as any });
    // Should not throw
    pipeline.cancel();
    pipeline.cancel();
    pipeline.cancel();
  });

  test('successful synthesis still publishes audio when NOT cancelled', async () => {
    const fakeAudio = Buffer.from('fakemp3data');
    globalThis.fetch = vi.fn(async () =>
      new Response(fakeAudio, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      }),
    ) as any;

    const publisher = makePublisherMock();
    const pipeline = new AudioStreamPipeline({ publisher: publisher as any });

    pipeline.push('Hello. This sentence is long enough to flush the chunker naturally.');
    await pipeline.flush();

    // Should have published at least the isFinal audio chunk
    const audioEvents = publisher.published.filter((e) => e.type === 'audio_chunk');
    expect(audioEvents.length).toBeGreaterThan(0);
    const lastChunk = audioEvents[audioEvents.length - 1] as any;
    expect(lastChunk.isFinal).toBe(true);
  });
});
