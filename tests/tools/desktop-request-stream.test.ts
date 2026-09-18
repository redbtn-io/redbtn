import { describe, it, expect, vi } from 'vitest';

const { getFakePub, getFakeSub, MockRedisConstructor } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const EventEmitter = require('events').EventEmitter;

  class FakePub extends EventEmitter {
    published: Array<{ channel: string; message: string }> = [];
    publish(channel: string, message: string) {
      this.published.push({ channel, message });
      return Promise.resolve(1);
    }
    quit() { return Promise.resolve('OK'); }
  }

  class FakeSub extends EventEmitter {
    subscribed: string[][] = [];
    subscribe(...channels: string[]) {
      this.subscribed.push(channels);
      return Promise.resolve(channels.length);
    }
    unsubscribe() { return Promise.resolve(1); }
    quit() { return Promise.resolve('OK'); }
  }

  let fakePubInstance: any = null;
  let fakeSubInstance: any = null;

  const MockRedisConstructor = vi.fn().mockImplementation(function (...args: any[]) {
    if (args.length === 0) return {};
    const opts = args[1];
    if (opts?.maxRetriesPerRequest === null) {
      fakeSubInstance = new FakeSub();
      return fakeSubInstance;
    }
    fakePubInstance = new FakePub();
    return fakePubInstance;
  });

  return {
    getFakePub: () => fakePubInstance,
    getFakeSub: () => fakeSubInstance,
    MockRedisConstructor,
  };
});

vi.mock('ioredis', () => {
  return {
    default: MockRedisConstructor,
  };
});

import { requestDesktopRaw } from '../../src/lib/tools/native/desktop-request';

describe('requestDesktopRaw streaming and cancellation', () => {
  it('subscribes to stream channel, forwards chunks to onChunk, and publishes exec_cancel on abort', async () => {
    const chunks: any[] = [];
    const abortController = new AbortController();

    const promise = requestDesktopRaw({
      userId: 'u_123',
      installId: 'inst_456',
      kind: 'exec',
      payload: { command: 'test-cmd' },
      onChunk: (c) => chunks.push(c),
      abortSignal: abortController.signal,
    });

    // Wait for sub.subscribe to be called
    await new Promise((r) => setTimeout(r, 50));

    const fakeSub = getFakeSub();
    const fakePub = getFakePub();

    expect(fakeSub).not.toBeNull();
    expect(fakePub).not.toBeNull();

    // Check subscribed channels
    const channels = fakeSub.subscribed[0];
    expect(channels.length).toBe(2);
    const replyChan = channels[0];
    const streamChan = channels[1];
    expect(replyChan).toMatch(/^desktop:reply:/);
    expect(streamChan).toMatch(/^desktop:stream:/);

    // Simulate stream chunks arriving
    const execId = replyChan.replace('desktop:reply:', '');
    fakeSub.emit(
      'message',
      streamChan,
      JSON.stringify({
        kind: 'exec_chunk',
        id: execId,
        stream: 'stdout',
        chunk: 'chunk-1',
        seq: 0,
      }),
    );
    fakeSub.emit(
      'message',
      streamChan,
      JSON.stringify({
        kind: 'exec_chunk',
        id: execId,
        stream: 'stderr',
        chunk: 'err-1',
        seq: 1,
      }),
    );

    expect(chunks).toEqual([
      { stream: 'stdout', chunk: 'chunk-1', seq: 0 },
      { stream: 'stderr', chunk: 'err-1', seq: 1 },
    ]);

    // Simulate abort signal
    abortController.abort();
    expect(fakePub.published.some((p: any) => {
      if (p.channel !== 'desktop:cmd:u_123:inst_456') return false;
      const parsed = JSON.parse(p.message);
      return parsed.kind === 'exec_cancel' && parsed.id === execId;
    })).toBe(true);

    // Simulate reply arriving
    fakeSub.emit(
      'message',
      replyChan,
      JSON.stringify({
        kind: 'exec_result',
        id: execId,
        ok: true,
        result: { stdout: 'chunk-1', stderr: 'err-1', exitCode: 0, durationMs: 15, truncated: false },
      }),
    );

    const res = await promise;
    expect(res.ok).toBe(true);
    expect(res.result.stdout).toBe('chunk-1');
  });
});
