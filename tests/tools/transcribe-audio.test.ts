/**
 * Vitest for native tool: transcribe_audio (Voice pack §4.5)
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation error + upstream error.
 *
 * The handler talks to a local Whisper-compatible STT service via global
 * `fetch`. We mock fetch to make these tests offline.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import transcribeAudioTool from '../../src/lib/tools/native/transcribe-audio';

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

const FAKE_AUDIO_B64 = Buffer.from('fake-audio-bytes').toString('base64');

describe('transcribe_audio — schema', () => {
  test('exposes required+optional inputs per spec', () => {
    expect(transcribeAudioTool.description.toLowerCase()).toContain('transcribe audio');
    expect(transcribeAudioTool.inputSchema.required).toContain('mimeType');
    expect(transcribeAudioTool.inputSchema.properties.audioBase64).toBeDefined();
    expect(transcribeAudioTool.inputSchema.properties.audioUrl).toBeDefined();
    expect(transcribeAudioTool.inputSchema.properties.mimeType).toBeDefined();
    expect(transcribeAudioTool.inputSchema.properties.language).toBeDefined();
    expect(transcribeAudioTool.server).toBe('voice');
  });
});

describe('transcribe_audio — happy path', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalSttUrl: string | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalSttUrl = process.env.STT_URL;
    process.env.STT_URL = 'http://test-whisper.local:8787';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalSttUrl === undefined) delete process.env.STT_URL;
    else process.env.STT_URL = originalSttUrl;
    vi.restoreAllMocks();
  });

  test('audioBase64 + verbose JSON response → text + language + segments', async () => {
    const fakeResponse = {
      text: 'Hello world, this is a test transcription.',
      language: 'en',
      segments: [
        { id: 0, start: 0.0, end: 1.5, text: 'Hello world,' },
        { id: 1, start: 1.5, end: 3.0, text: 'this is a test transcription.' },
      ],
    };

    let receivedUrl = '';
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      receivedUrl = typeof input === 'string' ? input : (input as URL).toString();
      return new Response(JSON.stringify(fakeResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioBase64: FAKE_AUDIO_B64,
        mimeType: 'audio/wav',
        language: 'en',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(receivedUrl).toBe(
      'http://test-whisper.local:8787/v1/audio/transcriptions',
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('Hello world, this is a test transcription.');
    expect(body.language).toBe('en');
    expect(Array.isArray(body.segments)).toBe(true);
    expect(body.segments).toHaveLength(2);
    expect(body.segments[0]).toMatchObject({
      start: 0,
      end: 1.5,
      text: 'Hello world,',
    });
  });

  test('plain {text} response → no segments key', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'plain transcription' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioBase64: FAKE_AUDIO_B64,
        mimeType: 'audio/wav',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('plain transcription');
    expect(body.language).toBe('auto'); // language defaulted
    expect(body.segments).toBeUndefined();
  });

  test('language=auto omits language form field', async () => {
    let formKeys: string[] = [];
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      // Inspect FormData: keys() gives us the field list
      const form = init?.body as FormData;
      formKeys = Array.from(form.keys());
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    await transcribeAudioTool.handler(
      { audioBase64: FAKE_AUDIO_B64, mimeType: 'audio/wav' },
      ctx,
    );
    expect(formKeys).toContain('file');
    expect(formKeys).toContain('model');
    expect(formKeys).toContain('response_format');
    expect(formKeys).not.toContain('language');
  });

  test('explicit language=en attaches the language form field', async () => {
    const captured: Array<[string, FormDataEntryValue]> = [];
    globalThis.fetch = vi.fn(async (_input, init?: RequestInit) => {
      const form = init?.body as FormData;
      for (const [k, v] of form.entries()) captured.push([k, v]);
      return new Response(JSON.stringify({ text: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    await transcribeAudioTool.handler(
      { audioBase64: FAKE_AUDIO_B64, mimeType: 'audio/wav', language: 'en' },
      ctx,
    );
    const langEntry = captured.find(([k]) => k === 'language');
    expect(langEntry).toBeDefined();
    expect(langEntry?.[1]).toBe('en');
  });

  test('audioUrl path: fetches the URL then forwards to Whisper', async () => {
    const fakeAudio = Buffer.from('fetched-audio');
    let urlSeq: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const u = typeof input === 'string' ? input : (input as URL).toString();
      urlSeq.push(u);
      if (u === 'https://example.org/audio.wav') {
        return new Response(fakeAudio, {
          status: 200,
          headers: { 'content-type': 'audio/wav' },
        });
      }
      // Whisper endpoint
      return new Response(JSON.stringify({ text: 'from url' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioUrl: 'https://example.org/audio.wav',
        mimeType: 'audio/wav',
      },
      ctx,
    );

    expect(result.isError).toBeFalsy();
    expect(urlSeq[0]).toBe('https://example.org/audio.wav');
    expect(urlSeq[1]).toBe('http://test-whisper.local:8787/v1/audio/transcriptions');
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('from url');
  });

  test('falls back to plain text when content-type is not JSON', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('a plain text transcription', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      { audioBase64: FAKE_AUDIO_B64, mimeType: 'audio/wav' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.text).toBe('a plain text transcription');
  });

  test('strips data: prefix from audioBase64', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ text: 'stripped' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioBase64: `data:audio/wav;base64,${FAKE_AUDIO_B64}`,
        mimeType: 'audio/wav',
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
  });
});

describe('transcribe_audio — validation errors', () => {
  test('missing mimeType returns isError VALIDATION', async () => {
    const ctx = makeMockContext();
    // @ts-expect-error — exercising runtime validation
    const result = await transcribeAudioTool.handler({ audioBase64: FAKE_AUDIO_B64 }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/mimeType is required/i);
  });

  test('missing both audioBase64 and audioUrl returns VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler({ mimeType: 'audio/wav' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });

  test('providing both audioBase64 and audioUrl returns VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioBase64: FAKE_AUDIO_B64,
        audioUrl: 'https://example.org/a.wav',
        mimeType: 'audio/wav',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/exactly one/i);
  });

  test('audioUrl with non-http scheme returns VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioUrl: 'file:///etc/passwd',
        mimeType: 'audio/wav',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/absolute http/i);
  });

  test('empty decoded audioBase64 returns VALIDATION', async () => {
    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioBase64: '',
        mimeType: 'audio/wav',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
  });
});

describe('transcribe_audio — upstream errors', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  test('Whisper non-2xx response surfaces status code', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'overloaded' }), {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      { audioBase64: FAKE_AUDIO_B64, mimeType: 'audio/wav' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/502/);
    expect(body.status).toBe(502);
  });

  test('Whisper fetch rejection surfaces error message', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED whisper');
    }) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      { audioBase64: FAKE_AUDIO_B64, mimeType: 'audio/wav' },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/ECONNREFUSED/);
  });

  test('audioUrl fetch failure returns isError with status', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const result = await transcribeAudioTool.handler(
      {
        audioUrl: 'https://example.org/missing.wav',
        mimeType: 'audio/wav',
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/404/);
    expect(body.status).toBe(404);
  });
});
