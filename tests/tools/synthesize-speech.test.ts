/**
 * Vitest for native tool: synthesize_speech (Voice pack §4.5)
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler talks to either Kokoro (via global `fetch`) or Gemini (via the
 * `@google/genai` SDK). We mock both transports so the tests are offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import synthesizeSpeechTool from '../../src/lib/tools/native/synthesize-speech';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

/**
 * Build a minimal valid PCM16 buffer (a short ramp at 24 kHz mono) so the
 * legacy Gemini-shaped path produces a non-zero durationMs.
 */
function makeFakePcmBase64(samples = 24000): string {
  const buf = Buffer.alloc(samples * 2); // 16-bit = 2 bytes/sample
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(((i % 1000) - 500) * 32, i * 2);
  }
  return buf.toString('base64');
}

/**
 * Build a minimal valid WAV buffer (RIFF/WAVE header + a small PCM payload).
 * Used for the kokoro-format=wav happy-path test so durationMs > 0.
 */
function makeFakeWavBuffer(samples = 24000, sampleRate = 24000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe('synthesize_speech — schema', () => {
  test('exposes required+optional inputs per spec', () => {
    expect(synthesizeSpeechTool.description.toLowerCase()).toContain('synthesize speech');
    expect(synthesizeSpeechTool.inputSchema.required).toContain('text');
    expect(synthesizeSpeechTool.inputSchema.properties.text).toBeDefined();
    expect(synthesizeSpeechTool.inputSchema.properties.voice).toBeDefined();
    expect(synthesizeSpeechTool.inputSchema.properties.provider).toBeDefined();
    expect(synthesizeSpeechTool.inputSchema.properties.format).toBeDefined();
    expect(synthesizeSpeechTool.inputSchema.properties.provider.enum).toEqual([
      'kokoro',
      'gemini',
    ]);
    expect(synthesizeSpeechTool.inputSchema.properties.format.enum).toEqual(['wav', 'pcm']);
    expect(synthesizeSpeechTool.server).toBe('voice');
  });
});

describe('synthesize_speech — kokoro happy path', () => {
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

  test('default provider=kokoro, default voice=af_bella, returns WAV with durationMs', async () => {
    const wavBuffer = makeFakeWavBuffer(48000, 24000); // 2 seconds
    let receivedBody: any = null;
    let receivedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      receivedUrl = typeof input === 'string' ? input : (input as URL).toString();
      receivedBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(wavBuffer, {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler({ text: 'Hello world' }, ctx);

    expect(result.isError).toBeFalsy();
    expect(receivedUrl).toBe('http://test-kokoro.local:8880/v1/audio/speech');
    expect(receivedBody.input).toBe('Hello world');
    expect(receivedBody.voice).toBe('af_bella');
    expect(receivedBody.response_format).toBe('wav');
    expect(receivedBody.model).toBe('kokoro');

    const body = JSON.parse(result.content[0].text);
    expect(body.provider).toBe('kokoro');
    expect(body.voice).toBe('af_bella');
    expect(body.format).toBe('wav');
    expect(body.mimeType).toBe('audio/wav');
    expect(typeof body.audioBase64).toBe('string');
    expect(body.audioBase64.length).toBeGreaterThan(0);
    // 48000 samples / 24000 Hz = 2000 ms
    expect(body.durationMs).toBe(2000);
    expect(body.textLength).toBe(11);
  });

  test('format=pcm passes response_format=pcm, returns audio/pcm with durationMs', async () => {
    const pcmBuffer = Buffer.alloc(48000 * 2); // 2 seconds @ 24kHz mono 16-bit
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      expect(body.response_format).toBe('pcm');
      return new Response(pcmBuffer, {
        status: 200,
        headers: { 'content-type': 'audio/pcm' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler(
      { text: 'pcm test', format: 'pcm' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.format).toBe('pcm');
    expect(body.mimeType).toBe('audio/pcm');
    // 96000 bytes / 2 / 24000 = 2000 ms
    expect(body.durationMs).toBe(2000);
  });

  test('respects custom voice override', async () => {
    let receivedVoice = '';
    globalThis.fetch = vi.fn(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      receivedVoice = body.voice;
      return new Response(makeFakeWavBuffer(), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    await synthesizeSpeechTool.handler(
      { text: 'voice test', voice: 'am_adam' },
      ctx,
    );
    expect(receivedVoice).toBe('am_adam');
  });

  test('uses default TTS_URL when env var unset', async () => {
    delete process.env.TTS_URL;
    let receivedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      receivedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(makeFakeWavBuffer(), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    await synthesizeSpeechTool.handler({ text: 'default url' }, ctx);
    expect(receivedUrl).toBe('http://192.168.1.6:8880/v1/audio/speech');
  });
});

describe('synthesize_speech — gemini happy path', () => {
  let originalApiKey: string | undefined;
  // Track calls we expect to see on the mocked SDK
  let lastConfig: any = null;
  // The tool uses `require('@google/genai')` (CJS), so vi.doMock (ESM-only)
  // doesn't intercept it. We replace the entry directly in `require.cache`.
  let originalRequireCache: any = undefined;
  let geminiModulePath: string | null = null;

  beforeEach(() => {
    originalApiKey = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = 'fake-gemini-key';

    // Resolve the real path of @google/genai and replace its require cache
    // entry with a fake module that produces our deterministic PCM payload.
    try {
      geminiModulePath = require.resolve('@google/genai');
      originalRequireCache = require.cache[geminiModulePath];
      const fakePcm = makeFakePcmBase64(48000); // 2 seconds @ 24kHz
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeModule: any = {
        GoogleGenAI: class {
          models = {
            generateContent: vi.fn(async (config: any) => {
              lastConfig = config;
              return {
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          inlineData: {
                            mimeType: 'audio/pcm',
                            data: fakePcm,
                          },
                        },
                      ],
                    },
                  },
                ],
              };
            }),
          };
          constructor(_args: any) {
            void _args;
          }
        },
      };
      require.cache[geminiModulePath] = {
        id: geminiModulePath,
        filename: geminiModulePath,
        loaded: true,
        children: [],
        paths: [],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exports: fakeModule,
      } as any;
    } catch {
      // @google/genai isn't installed — these tests will simply not be able
      // to run. Mark via geminiModulePath = null and let assertions fail.
      geminiModulePath = null;
    }
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    if (geminiModulePath) {
      if (originalRequireCache) {
        require.cache[geminiModulePath] = originalRequireCache;
      } else {
        delete require.cache[geminiModulePath];
      }
    }
    vi.restoreAllMocks();
    lastConfig = null;
  });

  test('provider=gemini, default voice=Kore, format=wav wraps PCM in WAV', async () => {
    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler(
      { text: 'gemini hello', provider: 'gemini' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(lastConfig?.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      'Kore',
    );

    const body = JSON.parse(result.content[0].text);
    expect(body.provider).toBe('gemini');
    expect(body.voice).toBe('Kore');
    expect(body.format).toBe('wav');
    expect(body.mimeType).toBe('audio/wav');
    expect(body.durationMs).toBe(2000);

    // Decoded base64 should start with the RIFF/WAVE header
    const decoded = Buffer.from(body.audioBase64, 'base64');
    expect(decoded.toString('ascii', 0, 4)).toBe('RIFF');
    expect(decoded.toString('ascii', 8, 12)).toBe('WAVE');
  });

  test('provider=gemini, format=pcm returns audio/pcm directly', async () => {
    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler(
      { text: 'pcm gemini', provider: 'gemini', format: 'pcm' },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.format).toBe('pcm');
    expect(body.mimeType).toBe('audio/pcm');
    expect(body.durationMs).toBe(2000);
  });

  test('respects custom Gemini voice override', async () => {
    const ctx = makeMockContext();
    await synthesizeSpeechTool.handler(
      { text: 'custom voice', provider: 'gemini', voice: 'Charon' },
      ctx,
    );
    expect(lastConfig?.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe(
      'Charon',
    );
  });
});

describe('synthesize_speech — validation errors', () => {
  test('empty text returns isError VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler({ text: '' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/text is required/i);
  });

  test('whitespace-only text returns isError VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler({ text: '   \n\t ' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('missing text returns isError VALIDATION', async () => {
    const ctx = makeMockContext();
    // @ts-expect-error — exercising runtime validation
    const result = await synthesizeSpeechTool.handler({}, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('unknown provider falls back to kokoro', async () => {
    let receivedUrl = '';
    const originalFetch = globalThis.fetch;
    process.env.TTS_URL = 'http://fallback-test.local:8880';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      receivedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(makeFakeWavBuffer(), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    // @ts-expect-error — exercising runtime fallback
    const result = await synthesizeSpeechTool.handler({ text: 'fallback', provider: 'bogus' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(receivedUrl).toContain('fallback-test.local');
    const body = JSON.parse(result.content[0].text);
    expect(body.provider).toBe('kokoro');
    globalThis.fetch = originalFetch;
    delete process.env.TTS_URL;
  });
});

describe('synthesize_speech — upstream errors', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalApiKey = process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.GOOGLE_API_KEY;
    else process.env.GOOGLE_API_KEY = originalApiKey;
    vi.doUnmock('@google/genai');
    vi.restoreAllMocks();
  });

  test('kokoro: non-2xx surfaces status code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('upstream busy', {
        status: 503,
        statusText: 'Service Unavailable',
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler({ text: 'fail' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/503/);
    expect(body.status).toBe(503);
  });

  test('kokoro: fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED kokoro');
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler({ text: 'connection-fail' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  test('gemini: missing GOOGLE_API_KEY returns CONFIGURATION error', async () => {
    delete process.env.GOOGLE_API_KEY;
    const ctx = makeMockContext();
    const result = await synthesizeSpeechTool.handler(
      { text: 'no-key', provider: 'gemini' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('CONFIGURATION');
    expect(body.error).toMatch(/GOOGLE_API_KEY/i);
  });

  test('gemini: empty audio response surfaces a meaningful error', async () => {
    process.env.GOOGLE_API_KEY = 'fake';
    let mockedPath: string | null = null;
    let originalCacheEntry: any = undefined;
    try {
      mockedPath = require.resolve('@google/genai');
      originalCacheEntry = require.cache[mockedPath];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeModule: any = {
        GoogleGenAI: class {
          models = {
            generateContent: vi.fn(async () => ({
              candidates: [{ content: { parts: [] } }],
            })),
          };
          constructor(_args: any) {
            void _args;
          }
        },
      };
      require.cache[mockedPath] = {
        id: mockedPath,
        filename: mockedPath,
        loaded: true,
        children: [],
        paths: [],
        exports: fakeModule,
      } as any;

      const ctx = makeMockContext();
      const result = await synthesizeSpeechTool.handler(
        { text: 'no-audio', provider: 'gemini' },
        ctx,
      );
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.error).toMatch(/no audio data/i);
    } finally {
      if (mockedPath) {
        if (originalCacheEntry) require.cache[mockedPath] = originalCacheEntry;
        else delete require.cache[mockedPath];
      }
    }
  });
});
