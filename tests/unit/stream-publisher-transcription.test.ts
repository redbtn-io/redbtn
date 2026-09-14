import { describe, it, expect, vi } from 'vitest';
import { StreamEventPublisher } from '../../src/lib/streams/stream-publisher';

describe('StreamEventPublisher - transcription events', () => {
  function makeFakeRedis() {
    return {
      publish: vi.fn().mockResolvedValue(1),
      rpush: vi.fn().mockResolvedValue(1),
      ltrim: vi.fn().mockResolvedValue('OK'),
      expire: vi.fn().mockResolvedValue(1),
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue('OK'),
    } as any;
  }

  it('publishes inputTranscription without audio and with optional suppression', async () => {
    const redis = makeFakeRedis();
    const publisher = new StreamEventPublisher({
      redis,
      sessionId: 'sess-123',
      streamId: 'stream-abc',
      provider: 'test-provider',
    });

    await publisher.inputTranscription('hello world');
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payloadStr] = redis.publish.mock.calls[0];
    expect(channel).toBe('stream:channel:sess-123');
    const event = JSON.parse(payloadStr);
    expect(event.type).toBe('input_transcription');
    expect(event.sessionId).toBe('sess-123');
    expect(event.text).toBe('hello world');
    expect(event.suppressed).toBeUndefined();

    // With suppressed: true
    await publisher.inputTranscription('blind input', { suppressed: true });
    const eventSuppressed = JSON.parse(redis.publish.mock.calls[1][1]);
    expect(eventSuppressed.suppressed).toBe(true);
  });

  it('publishes outputTranscription without audio and with optional suppression', async () => {
    const redis = makeFakeRedis();
    const publisher = new StreamEventPublisher({
      redis,
      sessionId: 'sess-123',
      streamId: 'stream-abc',
      provider: 'test-provider',
    });

    await publisher.outputTranscription('assistant reply');
    expect(redis.publish).toHaveBeenCalledTimes(1);
    const [channel, payloadStr] = redis.publish.mock.calls[0];
    expect(channel).toBe('stream:channel:sess-123');
    const event = JSON.parse(payloadStr);
    expect(event.type).toBe('output_transcription');
    expect(event.sessionId).toBe('sess-123');
    expect(event.text).toBe('assistant reply');
    expect(event.suppressed).toBeUndefined();

    // With suppressed: true
    await publisher.outputTranscription('blind output', { suppressed: true });
    const eventSuppressed = JSON.parse(redis.publish.mock.calls[1][1]);
    expect(eventSuppressed.suppressed).toBe(true);
  });

  it('redacts sensitive API keys and tokens from published transcripts', async () => {
    const redis = makeFakeRedis();
    const publisher = new StreamEventPublisher({
      redis,
      sessionId: 'sess-sensitive',
    });

    await publisher.inputTranscription('My API key is sk-abcdef1234567890abcdef and token Bearer xyz123');
    const event = JSON.parse(redis.publish.mock.calls[0][1]);
    expect(event.text).not.toContain('sk-abcdef1234567890abcdef');
    expect(event.text).toContain('[REDACTED]');
  });

  it('caps oversized transcript text and trims the replay list on Redis', async () => {
    const redis = makeFakeRedis();
    const publisher = new StreamEventPublisher({
      redis,
      sessionId: 'sess-large',
    });

    const oversized = 'A'.repeat(25000);
    await publisher.outputTranscription(oversized);

    const event = JSON.parse(redis.publish.mock.calls[0][1]);
    expect(event.text.length).toBeLessThan(20000);
    expect(event.text).toContain('...[truncated]');

    expect(redis.rpush).toHaveBeenCalledWith('stream:events:sess-large', expect.any(String));
    expect(redis.ltrim).toHaveBeenCalledWith('stream:events:sess-large', -1000, -1);
  });
});
