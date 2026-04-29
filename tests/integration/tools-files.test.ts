/**
 * Integration test for the native files pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a small
 * graph using the new tools end-to-end."
 *
 * The two new tools in this pack form a coherent agent flow alongside the
 * existing `upload_attachment`:
 *
 *    download_file   — fetch a remote URL → { contentBase64, mimeType, size }
 *    parse_document  — decode base64 + extract text via DocumentParser
 *
 * The integration scenario chains them as an agent would:
 *
 *    1. download_file (mocked fetch returns a small text payload)
 *    2. parse_document (real parser turns the bytes back into text)
 *    3. download_file with size cap to confirm the cap is enforced
 *    4. parse_document validates a base64 garbage input
 *
 * Validates:
 *   - NativeToolRegistry singleton has both new tools registered (alongside
 *     pre-existing `upload_attachment`).
 *   - Output of one tool is a valid input shape for the next one
 *     (`contentBase64` → `fileBase64`, `mimeType` carried through).
 *   - The shared `system` server label is consistent.
 *   - Errors in one stage don't poison subsequent stages.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// In production, native-registry.ts loads each tool via require('./native/foo.js').
// Under vitest the .js paths don't exist next to the .ts module, so the catch
// block silently swallows the failure. We import the TS modules and explicitly
// re-register them with the singleton.
import downloadFileTool from '../../src/lib/tools/native/download-file';
import parseDocumentTool from '../../src/lib/tools/native/parse-document';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-int', authToken: 'tok-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('files pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('download_file'))
      registry.register('download_file', downloadFileTool);
    if (!registry.has('parse_document'))
      registry.register('parse_document', parseDocumentTool);
  });

  test('NativeToolRegistry has both new files-pack tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of ['download_file', 'parse_document']) {
      expect(registry.has(name)).toBe(true);
    }
    for (const name of ['download_file', 'parse_document']) {
      expect(registry.get(name)?.server).toBe('system');
    }

    const all = registry.listTools().map((t) => t.name);
    expect(all).toEqual(
      expect.arrayContaining(['download_file', 'parse_document']),
    );
  });

  describe('end-to-end: download → parse, with errors in between', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent downloads a remote markdown file and parses it', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      const remoteContent =
        '# Project README\n\n' +
        'This document was **fetched** from a remote URL ' +
        'and parsed by the [files pack](https://docs.example.com/tools).';

      // 1. Mock the network fetch.
      globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
        const u = typeof input === 'string' ? input : (input as URL).toString();
        expect(u).toBe('https://example.com/README.md');
        const bytes = new Uint8Array(Buffer.from(remoteContent, 'utf8'));
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/markdown; charset=utf-8',
            'content-length': String(bytes.byteLength),
          },
        });
      }) as unknown as typeof globalThis.fetch;

      // 2. Run download_file
      const dlResult = await registry.callTool(
        'download_file',
        { url: 'https://example.com/README.md' },
        ctx,
      );
      expect(dlResult.isError).toBeFalsy();
      const downloaded = JSON.parse(dlResult.content[0].text);
      expect(downloaded.mimeType).toBe('text/markdown');
      expect(downloaded.size).toBe(Buffer.byteLength(remoteContent, 'utf8'));
      expect(typeof downloaded.contentBase64).toBe('string');
      expect(
        Buffer.from(downloaded.contentBase64, 'base64').toString('utf8'),
      ).toBe(remoteContent);

      // 3. Run parse_document on the downloaded payload (default markdown).
      const parseResult = await registry.callTool(
        'parse_document',
        {
          fileBase64: downloaded.contentBase64,
          mimeType: downloaded.mimeType,
        },
        ctx,
      );
      expect(parseResult.isError).toBeFalsy();
      const parsed = JSON.parse(parseResult.content[0].text);
      expect(parsed.text).toContain('# Project README');
      expect(parsed.text).toContain('**fetched**');
      expect(parsed.wordCount).toBeGreaterThan(0);
      expect(parsed.pageCount).toBeUndefined(); // markdown is not paginated

      // 4. Re-parse the same payload with format: 'text' — should drop the
      //    leading markdown heading marker.
      const parsePlainResult = await registry.callTool(
        'parse_document',
        {
          fileBase64: downloaded.contentBase64,
          mimeType: downloaded.mimeType,
          format: 'text',
        },
        ctx,
      );
      expect(parsePlainResult.isError).toBeFalsy();
      const parsedPlain = JSON.parse(parsePlainResult.content[0].text);
      expect(parsedPlain.text).toContain('Project README');
      expect(parsedPlain.text).not.toMatch(/^#/m);
    });

    test('agent enforces size cap on download but recovers on next call', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // First mock — server lies about a tiny content-length, then streams
      // way more bytes.
      const big = Buffer.alloc(8 * 1024, 0x41); // 8 KB of 'A'
      globalThis.fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Push in two halves so the over-limit detection fires mid-stream.
            controller.enqueue(new Uint8Array(big.subarray(0, 4096)));
            controller.enqueue(new Uint8Array(big.subarray(4096)));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          // Intentionally omit content-length so the over-limit check fires
          // mid-stream instead of up front.
          headers: { 'content-type': 'application/octet-stream' },
        });
      }) as unknown as typeof globalThis.fetch;

      const tooBig = await registry.callTool(
        'download_file',
        {
          url: 'https://example.com/sneaky.bin',
          maxSizeBytes: 1024, // 1 KB cap, body is 8 KB
        },
        ctx,
      );
      expect(tooBig.isError).toBe(true);
      const tooBigBody = JSON.parse(tooBig.content[0].text);
      expect(tooBigBody.code).toBe('TOO_LARGE');

      // Now switch the mock back to a sane response and confirm the next
      // call still works (failure isolation).
      const ok = Buffer.from('payload after recovery', 'utf8');
      globalThis.fetch = vi.fn(async () => {
        const bytes = new Uint8Array(ok);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(bytes.byteLength),
          },
        });
      }) as unknown as typeof globalThis.fetch;

      const okResult = await registry.callTool(
        'download_file',
        { url: 'https://example.com/ok.txt' },
        ctx,
      );
      expect(okResult.isError).toBeFalsy();
      const okBody = JSON.parse(okResult.content[0].text);
      expect(okBody.size).toBe(ok.length);
    });

    test('parse_document rejects garbage base64 without crashing the chain', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // Bad input first.
      const badParse = await registry.callTool(
        'parse_document',
        { fileBase64: '@@@not-base64!!!', mimeType: 'text/plain' },
        ctx,
      );
      expect(badParse.isError).toBe(true);
      expect(JSON.parse(badParse.content[0].text).code).toBe('VALIDATION');

      // Then a clean call succeeds.
      const goodParse = await registry.callTool(
        'parse_document',
        {
          fileBase64: Buffer.from('clean text', 'utf8').toString('base64'),
          mimeType: 'text/plain',
        },
        ctx,
      );
      expect(goodParse.isError).toBeFalsy();
      const goodBody = JSON.parse(goodParse.content[0].text);
      expect(goodBody.text).toBe('clean text');
      expect(goodBody.wordCount).toBe(2);
    });

    test('upstream HTTP error from download_file does not affect next call', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      // First request: 500.
      globalThis.fetch = vi.fn(async () =>
        new Response('boom', {
          status: 500,
          statusText: 'Internal Server Error',
        }),
      ) as unknown as typeof globalThis.fetch;

      const errResult = await registry.callTool(
        'download_file',
        { url: 'https://example.com/down.bin' },
        ctx,
      );
      expect(errResult.isError).toBe(true);
      expect(JSON.parse(errResult.content[0].text).status).toBe(500);

      // Second request: success.
      const recovery = Buffer.from('recovered', 'utf8');
      globalThis.fetch = vi.fn(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(recovery));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }) as unknown as typeof globalThis.fetch;

      const okResult = await registry.callTool(
        'download_file',
        { url: 'https://example.com/back.txt' },
        ctx,
      );
      expect(okResult.isError).toBeFalsy();
      expect(
        Buffer.from(
          JSON.parse(okResult.content[0].text).contentBase64,
          'base64',
        ).toString('utf8'),
      ).toBe('recovered');
    });
  });
});
