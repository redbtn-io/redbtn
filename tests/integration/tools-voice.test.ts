/**
 * Integration test for the native voice pack (TOOL-HANDOFF.md §4.5).
 *
 * Per §6.2 — "one integration test per pack that runs a small graph using
 * the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test exercises the layer a graph
 * node actually calls when it runs a `tool` step:
 *
 *   1. The NativeToolRegistry has both voice tools registered.
 *   2. The legacy `tts_synthesize` alias is also registered.
 *   3. A simulated multi-step "graph" runs `synthesize_speech` (kokoro WAV)
 *      → uses the resulting audioBase64 + mimeType as input to
 *      `transcribe_audio` → asserts the transcription is non-empty.
 *
 * That mirrors the kind of chain a voice agent would use ("speak this, then
 * verify the synthesised output transcribes back to the same words") without
 * needing the LangGraph runtime, real Kokoro, or real Whisper.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run executing the TS sources
// directly, those `.js` paths don't exist next to the .ts module — the catch
// block silently swallows the failure. We work around it by importing the TS
// modules and explicitly re-registering them with the singleton, which is
// exactly what the dist-build path does at runtime.
import synthesizeSpeechTool from '../../src/lib/tools/native/synthesize-speech';
import transcribeAudioTool from '../../src/lib/tools/native/transcribe-audio';
import ttsSynthesizeAliasTool from '../../src/lib/tools/native/tts-synthesize';

/**
 * Build a tiny but RIFF/WAVE-valid buffer that the kokoro mock will return
 * for our synthesis step. The transcribe step then receives this buffer
 * (re-encoded as base64) as input.
 */
function makeFakeWavBuffer(samples = 12000, sampleRate = 24000): Buffer {
  const pcm = Buffer.alloc(samples * 2);
  // Plant some non-zero data so durationMs computations look real.
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(((i * 17) % 1000) - 500, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('voice pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalTtsUrl: string | undefined;
  let originalSttUrl: string | undefined;

  beforeAll(() => {
    // Re-register the voice-pack tools against the singleton. In production
    // this is done by `registerBuiltinTools` via require('./native/foo.js'),
    // which doesn't fire when running TS sources under vitest (no .js sibling).
    const registry = getNativeRegistry();
    if (!registry.has('synthesize_speech'))
      registry.register('synthesize_speech', synthesizeSpeechTool);
    if (!registry.has('transcribe_audio'))
      registry.register('transcribe_audio', transcribeAudioTool);
    if (!registry.has('tts_synthesize'))
      registry.register('tts_synthesize', ttsSynthesizeAliasTool);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalTtsUrl = process.env.TTS_URL;
    originalSttUrl = process.env.STT_URL;
    process.env.TTS_URL = 'http://test-kokoro.local:8880';
    process.env.STT_URL = 'http://test-whisper.local:8787';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalTtsUrl === undefined) delete process.env.TTS_URL;
    else process.env.TTS_URL = originalTtsUrl;
    if (originalSttUrl === undefined) delete process.env.STT_URL;
    else process.env.STT_URL = originalSttUrl;
    vi.restoreAllMocks();
  });

  test('NativeToolRegistry has all three voice-pack entries registered', () => {
    const registry = getNativeRegistry();
    expect(registry.has('synthesize_speech')).toBe(true);
    expect(registry.has('transcribe_audio')).toBe(true);
    // tts_synthesize alias preserved for one engine version (back-compat)
    expect(registry.has('tts_synthesize')).toBe(true);

    const tools = registry.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('synthesize_speech');
    expect(names).toContain('transcribe_audio');
    expect(names).toContain('tts_synthesize');

    const synth = tools.find((t) => t.name === 'synthesize_speech');
    const trans = tools.find((t) => t.name === 'transcribe_audio');
    expect(synth?.server).toBe('voice');
    expect(trans?.server).toBe('voice');
    expect(synth?.inputSchema.required).toContain('text');
    expect(trans?.inputSchema.required).toContain('mimeType');
  });

  test('end-to-end: synthesize_speech (kokoro) → transcribe_audio chain', async () => {
    const registry = getNativeRegistry();
    const fakeWav = makeFakeWavBuffer(48000, 24000); // 2 seconds

    const fetchCalls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      fetchCalls.push(u);

      if (u.endsWith('/v1/audio/speech')) {
        // Validate that we asked for kokoro WAV with our text.
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.model).toBe('kokoro');
        expect(body.response_format).toBe('wav');
        expect(typeof body.input).toBe('string');
        return new Response(fakeWav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }

      if (u.endsWith('/v1/audio/transcriptions')) {
        // Validate the file payload landed in the form (size > some bytes).
        const form = init?.body as FormData;
        const file = form.get('file') as Blob | null;
        expect(file).not.toBeNull();
        expect(file?.size).toBe(fakeWav.length);
        // Echo back the original text the agent requested.
        return new Response(
          JSON.stringify({
            text: 'redbtn voice pack roundtrip',
            language: 'en',
            segments: [
              { start: 0, end: 1.2, text: 'redbtn voice pack' },
              { start: 1.2, end: 2.0, text: 'roundtrip' },
            ],
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      }

      return new Response('not found', { status: 404 });
    }) as unknown as typeof globalThis.fetch;

    // Step 1: synthesise via dispatcher (this is what `tool` step type does)
    const ctx1 = makeMockContext();
    const synthResult = await registry.callTool(
      'synthesize_speech',
      { text: 'redbtn voice pack roundtrip' },
      ctx1,
    );
    expect(synthResult.isError).toBeFalsy();
    const synthBody = JSON.parse(synthResult.content[0].text);
    expect(synthBody.provider).toBe('kokoro');
    expect(synthBody.format).toBe('wav');
    expect(synthBody.mimeType).toBe('audio/wav');
    expect(typeof synthBody.audioBase64).toBe('string');
    expect(synthBody.audioBase64.length).toBeGreaterThan(0);
    expect(synthBody.durationMs).toBeGreaterThan(0);

    // Simulated graph state would now have something like:
    //   state.tts = { audioBase64: ..., mimeType: ... }
    // and the next tool step would template both fields into transcribe_audio.

    // Step 2: transcribe via the dispatcher
    const ctx2 = makeMockContext();
    const transResult = await registry.callTool(
      'transcribe_audio',
      {
        audioBase64: synthBody.audioBase64,
        mimeType: synthBody.mimeType,
        language: 'en',
      },
      ctx2,
    );
    expect(transResult.isError).toBeFalsy();
    const transBody = JSON.parse(transResult.content[0].text);
    expect(typeof transBody.text).toBe('string');
    expect(transBody.text.length).toBeGreaterThan(0);
    expect(transBody.text).toBe('redbtn voice pack roundtrip');
    expect(transBody.language).toBe('en');
    expect(Array.isArray(transBody.segments)).toBe(true);
    expect(transBody.segments).toHaveLength(2);

    // Verify the dispatcher actually drove both upstream calls in order
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[0]).toContain('/v1/audio/speech');
    expect(fetchCalls[1]).toContain('/v1/audio/transcriptions');
  });

  test('legacy tts_synthesize alias preserves the historical PCM output shape', async () => {
    const registry = getNativeRegistry();

    // The alias defaults provider=gemini → patch require.cache for @google/genai.
    // (vi.doMock targets ESM imports; the tool uses dynamic require(), so cache
    // patching is the only reliable interception layer.)
    process.env.GOOGLE_API_KEY = 'integration-fake-key';
    const fakePcm = Buffer.alloc(48000 * 2).toString('base64'); // 2 seconds PCM
    let mockedPath: string | null = null;
    let originalCacheEntry: any = undefined;

    try {
      mockedPath = require.resolve('@google/genai');
      originalCacheEntry = require.cache[mockedPath];
      const fakeModule = {
        GoogleGenAI: class {
          models = {
            generateContent: vi.fn(async () => ({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        inlineData: { mimeType: 'audio/pcm', data: fakePcm },
                      },
                    ],
                  },
                },
              ],
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        exports: fakeModule as any,
      } as any;

      const ctx = makeMockContext();
      const result = await registry.callTool(
        'tts_synthesize',
        { text: 'legacy roundtrip' },
        ctx,
      );
      expect(result.isError).toBeFalsy();
      const body = JSON.parse(result.content[0].text);
      // Historical schema fields preserved
      expect(body.audioData).toBeDefined();
      expect(typeof body.audioData).toBe('string');
      expect(body.mimeType).toBe('audio/pcm');
      expect(body.sampleRate).toBe(24000);
      expect(body.channels).toBe(1);
      expect(body.bitDepth).toBe(16);
      expect(body.voice).toBe('Kore');
      expect(body.durationMs).toBe(2000);
    } finally {
      if (mockedPath) {
        if (originalCacheEntry) require.cache[mockedPath] = originalCacheEntry;
        else delete require.cache[mockedPath];
      }
      delete process.env.GOOGLE_API_KEY;
    }
  });

  test('end-to-end: chain handles upstream error from transcribe gracefully', async () => {
    const registry = getNativeRegistry();
    const fakeWav = makeFakeWavBuffer();

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      if (u.endsWith('/v1/audio/speech')) {
        return new Response(fakeWav, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      // Whisper fails
      return new Response('overloaded', { status: 503 });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const synthResult = await registry.callTool(
      'synthesize_speech',
      { text: 'broken downstream' },
      ctx,
    );
    expect(synthResult.isError).toBeFalsy();
    const synthBody = JSON.parse(synthResult.content[0].text);

    const transResult = await registry.callTool(
      'transcribe_audio',
      { audioBase64: synthBody.audioBase64, mimeType: synthBody.mimeType },
      ctx,
    );
    expect(transResult.isError).toBe(true);
    const transBody = JSON.parse(transResult.content[0].text);
    expect(transBody.error).toMatch(/503/);
    expect(transBody.status).toBe(503);
  });
});
