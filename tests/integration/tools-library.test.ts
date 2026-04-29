/**
 * Integration test for the native library pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test exercises the layer a graph
 * node actually calls when it runs a `tool` step, in a canonical lifecycle
 * order:
 *
 *   create_library         → make a fresh library
 *   add_document (text)    → ingest some text content
 *   list_documents         → confirm the new document shows up
 *   search_all_libraries   → find the document via cross-library search
 *   get_document (full)    → reconstruct the document content
 *   delete_document        → remove the document
 *   delete_library         → permanently delete the library
 *
 * The webapp library API is mocked via global fetch with an in-memory backing
 * store that mimics the libraries / documents / vector-search semantics.
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

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run executing the TS sources
// directly, those .js paths don't exist next to the .ts module — the catch
// block silently swallows the failure. We work around it by importing the TS
// modules and explicitly re-registering them with the singleton, which is
// exactly what the dist-build path does at runtime.
import addDocumentTool from '../../src/lib/tools/native/add-document';
import searchAllLibrariesTool from '../../src/lib/tools/native/search-all-libraries';
import listLibrariesTool from '../../src/lib/tools/native/list-libraries';
import createLibraryTool from '../../src/lib/tools/native/create-library';
import updateLibraryTool from '../../src/lib/tools/native/update-library';
import deleteLibraryTool from '../../src/lib/tools/native/delete-library';
import listDocumentsTool from '../../src/lib/tools/native/list-documents';
import getDocumentTool from '../../src/lib/tools/native/get-document';
import deleteDocumentTool from '../../src/lib/tools/native/delete-document';
import updateDocumentTool from '../../src/lib/tools/native/update-document';
import reprocessDocumentTool from '../../src/lib/tools/native/reprocess-document';
import uploadToLibraryTool from '../../src/lib/tools/native/upload-to-library';

const WEBAPP = 'http://test-webapp.example';

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

interface MockDoc {
  documentId: string;
  title: string;
  content: string;
  chunkCount: number;
  charCount: number;
  source?: string;
  metadata: Record<string, unknown>;
  addedAt: string;
}

interface MockLibrary {
  libraryId: string;
  name: string;
  description: string;
  documentCount: number;
  totalChunks: number;
  totalSize: number;
  documents: MockDoc[];
  createdAt: string;
  isArchived: boolean;
  isDeleted: boolean;
}

/**
 * In-memory mock for the webapp's /api/v1/libraries API.
 *
 * Supports just enough route shapes for the integration scenario. Routes
 * handled:
 *   GET    /api/v1/libraries
 *   POST   /api/v1/libraries
 *   GET    /api/v1/libraries/:id
 *   PATCH  /api/v1/libraries/:id
 *   DELETE /api/v1/libraries/:id?permanent=true
 *   POST   /api/v1/libraries/:id/documents             (json)
 *   POST   /api/v1/libraries/:id/upload                (multipart)
 *   POST   /api/v1/libraries/:id/search                (json)
 *   GET    /api/v1/libraries/:id/documents/:docId
 *   PATCH  /api/v1/libraries/:id/documents/:docId
 *   DELETE /api/v1/libraries/:id/documents/:docId
 *   GET    /api/v1/libraries/:id/documents/:docId/full
 *   GET    /api/v1/libraries/:id/documents/:docId/chunks
 *   POST   /api/v1/libraries/:id/documents/:docId/process
 */
function createMockLibrariesApi(): typeof globalThis.fetch {
  const libraries: Record<string, MockLibrary> = {};
  let libCounter = 1;
  let docCounter = 1;

  const chunkCount = (text: string) => Math.max(1, Math.ceil(text.length / 50));

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    // ── /api/v1/libraries/:id/documents/:docId/full ──
    let m = path.match(
      /^\/api\/v1\/libraries\/([^/]+)\/documents\/([^/]+)\/full$/,
    );
    if (m) {
      const id = decodeURIComponent(m[1]);
      const docId = decodeURIComponent(m[2]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const doc = lib.documents.find((d) => d.documentId === docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          documentId: doc.documentId,
          title: doc.title,
          content: doc.content,
          format: 'text',
          chunkCount: doc.chunkCount,
          charCount: doc.charCount,
        }),
        { status: 200 },
      );
    }

    // ── /api/v1/libraries/:id/documents/:docId/chunks ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)\/documents\/([^/]+)\/chunks$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const docId = decodeURIComponent(m[2]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const doc = lib.documents.find((d) => d.documentId === docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
      }
      // Slice the content into chunkCount segments
      const len = doc.content.length;
      const stride = Math.max(1, Math.floor(len / Math.max(1, doc.chunkCount)));
      const chunks = [];
      for (let i = 0; i < doc.chunkCount; i++) {
        chunks.push({
          id: `${docId}_chunk_${i}`,
          text: doc.content.slice(i * stride, (i + 1) * stride),
          chunkIndex: i,
          metadata: { documentId: docId },
        });
      }
      return new Response(
        JSON.stringify({
          documentId: doc.documentId,
          title: doc.title,
          chunks,
          count: chunks.length,
        }),
        { status: 200 },
      );
    }

    // ── /api/v1/libraries/:id/documents/:docId/process ──
    m = path.match(
      /^\/api\/v1\/libraries\/([^/]+)\/documents\/([^/]+)\/process$/,
    );
    if (m) {
      const id = decodeURIComponent(m[1]);
      const docId = decodeURIComponent(m[2]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const doc = lib.documents.find((d) => d.documentId === docId);
      if (!doc) {
        return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
      }
      if (method === 'POST') {
        // Simulate re-chunking — no actual change to content.
        return new Response(
          JSON.stringify({
            success: true,
            chunkCount: doc.chunkCount,
          }),
          { status: 200 },
        );
      }
    }

    // ── /api/v1/libraries/:id/documents/:docId  (REST per-id) ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)\/documents\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const docId = decodeURIComponent(m[2]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      const doc = lib.documents.find((d) => d.documentId === docId);

      if (method === 'GET') {
        if (!doc) {
          return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            documentId: doc.documentId,
            title: doc.title,
            chunkCount: doc.chunkCount,
            charCount: doc.charCount,
            metadata: doc.metadata,
            libraryId: id,
            addedAt: doc.addedAt,
          }),
          { status: 200 },
        );
      }
      if (method === 'PATCH') {
        if (!doc) {
          return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
        }
        const body = JSON.parse(String(init?.body || '{}'));
        let reprocessed = false;
        if (typeof body.title === 'string') doc.title = body.title;
        if (body.metadata && typeof body.metadata === 'object') {
          doc.metadata = { ...doc.metadata, ...body.metadata };
        }
        if (typeof body.content === 'string') {
          const oldChunks = doc.chunkCount;
          doc.content = body.content;
          doc.charCount = body.content.length;
          doc.chunkCount = chunkCount(body.content);
          lib.totalChunks += doc.chunkCount - oldChunks;
          lib.totalSize += body.content.length - (doc.charCount - body.content.length);
          reprocessed = true;
        }
        return new Response(
          JSON.stringify({ success: true, reprocessed }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        if (!doc) {
          return new Response(JSON.stringify({ error: 'Doc not found' }), { status: 404 });
        }
        lib.documents = lib.documents.filter((d) => d.documentId !== docId);
        lib.documentCount -= 1;
        lib.totalChunks -= doc.chunkCount;
        return new Response(
          JSON.stringify({ success: true, deleted: docId }),
          { status: 200 },
        );
      }
    }

    // ── /api/v1/libraries/:id/documents (collection) ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)\/documents$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (!body.title || !body.content || !body.sourceType) {
          return new Response(
            JSON.stringify({ error: 'title, content, sourceType required' }),
            { status: 400 },
          );
        }
        const docId = `doc_${docCounter++}`;
        const cc = chunkCount(body.content);
        const newDoc: MockDoc = {
          documentId: docId,
          title: body.title,
          content: body.content,
          chunkCount: cc,
          charCount: body.content.length,
          source: body.source,
          metadata: body.metadata || {},
          addedAt: new Date().toISOString(),
        };
        lib.documents.push(newDoc);
        lib.documentCount += 1;
        lib.totalChunks += cc;
        lib.totalSize += body.content.length;
        return new Response(
          JSON.stringify({
            success: true,
            document: {
              documentId: docId,
              title: newDoc.title,
              chunkCount: cc,
              charCount: newDoc.charCount,
              addedAt: newDoc.addedAt,
            },
          }),
          { status: 201 },
        );
      }
    }

    // ── /api/v1/libraries/:id/upload (multipart) ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)\/upload$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'POST') {
        // The mock fetch can't actually parse multipart easily — simulate a
        // successful upload of a small fake document.
        const docId = `doc_${docCounter++}`;
        const newDoc: MockDoc = {
          documentId: docId,
          title: 'uploaded',
          content: 'binary content placeholder',
          chunkCount: 1,
          charCount: 32,
          source: 'upload.bin',
          metadata: {},
          addedAt: new Date().toISOString(),
        };
        lib.documents.push(newDoc);
        lib.documentCount += 1;
        lib.totalChunks += 1;
        lib.totalSize += 32;
        return new Response(
          JSON.stringify({
            success: true,
            document: {
              documentId: docId,
              title: newDoc.title,
              chunkCount: 1,
              charCount: 32,
              addedAt: newDoc.addedAt,
            },
          }),
          { status: 201 },
        );
      }
    }

    // ── /api/v1/libraries/:id/search ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)\/search$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const lib = libraries[id];
      if (!lib || lib.isDeleted) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const q = String(body.query || '').toLowerCase();
        // Score = ratio of substring hits in title/content
        const results = lib.documents
          .map((d) => {
            const text = (d.title + ' ' + d.content).toLowerCase();
            const hits = q ? text.split(q).length - 1 : 0;
            const score = hits > 0 ? Math.min(0.99, 0.5 + 0.1 * hits) : 0;
            return {
              id: d.documentId,
              text: d.content,
              score,
              metadata: { documentId: d.documentId, title: d.title },
            };
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);
        return new Response(
          JSON.stringify({
            query: body.query,
            results,
            count: results.length,
            libraryId: id,
          }),
          { status: 200 },
        );
      }
    }

    // ── /api/v1/libraries/:id ──
    m = path.match(/^\/api\/v1\/libraries\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const lib = libraries[id];
      if (method === 'GET') {
        if (!lib || lib.isDeleted) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        const limit = Number(url.searchParams.get('limit') || '50');
        const page = Number(url.searchParams.get('page') || '1');
        const offset = (page - 1) * limit;
        const sliced = lib.documents
          .slice()
          .sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1))
          .slice(offset, offset + limit)
          .map((d) => ({
            documentId: d.documentId,
            title: d.title,
            sourceType: 'text',
            source: d.source,
            chunkCount: d.chunkCount,
            charCount: d.charCount,
            addedAt: d.addedAt,
          }));
        return new Response(
          JSON.stringify({
            libraryId: lib.libraryId,
            name: lib.name,
            description: lib.description,
            documents: sliced,
            documentCount: lib.documentCount,
            totalChunks: lib.totalChunks,
            totalSize: lib.totalSize,
            pagination: {
              total: lib.documents.length,
              page,
              limit,
              totalPages: Math.ceil(lib.documents.length / limit),
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PATCH') {
        if (!lib || lib.isDeleted) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        const body = JSON.parse(String(init?.body || '{}'));
        if (typeof body.name === 'string') lib.name = body.name;
        if (typeof body.description === 'string') lib.description = body.description;
        return new Response(
          JSON.stringify({ success: true, updated: Object.keys(body) }),
          { status: 200 },
        );
      }
      if (method === 'DELETE') {
        if (!lib || lib.isDeleted) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        const permanent = url.searchParams.get('permanent') === 'true';
        if (permanent) {
          lib.isDeleted = true;
          return new Response(
            JSON.stringify({ success: true, deleted: true }),
            { status: 200 },
          );
        }
        lib.isArchived = true;
        return new Response(
          JSON.stringify({ success: true, archived: true }),
          { status: 200 },
        );
      }
    }

    // ── /api/v1/libraries (collection) ──
    if (path === '/api/v1/libraries') {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (!body.name) {
          return new Response(JSON.stringify({ error: 'name required' }), {
            status: 400,
          });
        }
        const libId = `lib_${libCounter++}`;
        const now = new Date().toISOString();
        const newLib: MockLibrary = {
          libraryId: libId,
          name: body.name,
          description: body.description || '',
          documentCount: 0,
          totalChunks: 0,
          totalSize: 0,
          documents: [],
          createdAt: now,
          isArchived: false,
          isDeleted: false,
        };
        libraries[libId] = newLib;
        return new Response(
          JSON.stringify({
            success: true,
            library: {
              libraryId: libId,
              name: body.name,
              description: newLib.description,
              createdAt: now,
            },
          }),
          { status: 201 },
        );
      }
      if (method === 'GET') {
        const all = Object.values(libraries).filter((l) => !l.isDeleted && !l.isArchived);
        return new Response(
          JSON.stringify({
            libraries: all.map((l) => ({
              libraryId: l.libraryId,
              name: l.name,
              description: l.description,
              documentCount: l.documentCount,
              totalChunks: l.totalChunks,
              totalSize: l.totalSize,
              createdAt: l.createdAt,
              isArchived: l.isArchived,
              isOwned: true,
            })),
          }),
          { status: 200 },
        );
      }
    }

    return new Response(
      JSON.stringify({ error: `Mock not implemented: ${method} ${path}` }),
      { status: 501 },
    );
  }) as unknown as typeof globalThis.fetch;
}

describe('library pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeAll(() => {
    // Re-register all 13 tools (12 new + the existing search_documents stays;
    // add_document is the consolidated replacement for library_write).
    const registry = getNativeRegistry();
    if (!registry.has('add_document') ||
        // Force re-register so the consolidated impl beats whatever was loaded
        // from dist (or stale require) into the singleton during prior runs.
        true) {
      registry.register('add_document', addDocumentTool);
    }
    if (!registry.has('search_all_libraries'))
      registry.register('search_all_libraries', searchAllLibrariesTool);
    if (!registry.has('list_libraries'))
      registry.register('list_libraries', listLibrariesTool);
    if (!registry.has('create_library'))
      registry.register('create_library', createLibraryTool);
    if (!registry.has('update_library'))
      registry.register('update_library', updateLibraryTool);
    if (!registry.has('delete_library'))
      registry.register('delete_library', deleteLibraryTool);
    if (!registry.has('list_documents'))
      registry.register('list_documents', listDocumentsTool);
    if (!registry.has('get_document'))
      registry.register('get_document', getDocumentTool);
    if (!registry.has('delete_document'))
      registry.register('delete_document', deleteDocumentTool);
    if (!registry.has('update_document'))
      registry.register('update_document', updateDocumentTool);
    if (!registry.has('reprocess_document'))
      registry.register('reprocess_document', reprocessDocumentTool);
    if (!registry.has('upload_to_library'))
      registry.register('upload_to_library', uploadToLibraryTool);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = WEBAPP;
    globalThis.fetch = createMockLibrariesApi();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('NativeToolRegistry has all 13 library tools registered (12 new + add_document)', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'add_document',
      'search_all_libraries',
      'list_libraries',
      'create_library',
      'update_library',
      'delete_library',
      'list_documents',
      'get_document',
      'delete_document',
      'update_document',
      'reprocess_document',
      'upload_to_library',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    // library_write must be GONE (consolidated into add_document).
    expect(registry.has('library_write')).toBe(false);

    // All library tools share the 'library' server tag for UI grouping.
    const ld = registry.get('list_libraries')!;
    expect(ld.server).toBe('library');
  });

  test('end-to-end: create_library → add_document → list_documents → search_all → get_document → delete_document → delete_library', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // 1. create_library
    const createResult = await registry.callTool(
      'create_library',
      { name: 'Project Notes' },
      ctx,
    );
    expect(createResult.isError).toBeFalsy();
    const created = JSON.parse(createResult.content[0].text);
    const libraryId = created.libraryId;
    expect(libraryId).toMatch(/^lib_/);

    // 2. add_document (text path)
    const addResult = await registry.callTool(
      'add_document',
      {
        libraryId,
        content: 'The quick brown fox jumps over the lazy dog. Engineering notes inside.',
        title: 'Animals & engineering',
        filename: 'note.md',
      },
      ctx,
    );
    expect(addResult.isError).toBeFalsy();
    const added = JSON.parse(addResult.content[0].text);
    const documentId = added.documentId;
    expect(documentId).toMatch(/^doc_/);
    expect(added.chunks).toBeGreaterThan(0);

    // 3. list_documents reflects the new document
    const listResult = await registry.callTool(
      'list_documents',
      { libraryId },
      ctx,
    );
    expect(listResult.isError).toBeFalsy();
    const listBody = JSON.parse(listResult.content[0].text);
    expect(listBody.total).toBe(1);
    expect(listBody.documents[0].id).toBe(documentId);

    // 4. search_all_libraries finds the document via cross-library fan-out
    const searchResult = await registry.callTool(
      'search_all_libraries',
      { query: 'engineering', limit: 5 },
      ctx,
    );
    expect(searchResult.isError).toBeFalsy();
    const searchBody = JSON.parse(searchResult.content[0].text);
    expect(searchBody.results.length).toBeGreaterThan(0);
    const hit = searchBody.results.find(
      (r: any) => r.documentId === documentId,
    );
    expect(hit).toBeDefined();
    expect(hit.libraryId).toBe(libraryId);

    // 5. get_document (full) returns reconstructed content
    const getResult = await registry.callTool(
      'get_document',
      { libraryId, documentId, format: 'full' },
      ctx,
    );
    expect(getResult.isError).toBeFalsy();
    const getBody = JSON.parse(getResult.content[0].text);
    expect(getBody.content).toContain('quick brown fox');

    // 6. delete_document
    const deleteDocResult = await registry.callTool(
      'delete_document',
      { libraryId, documentId },
      ctx,
    );
    expect(deleteDocResult.isError).toBeFalsy();
    expect(JSON.parse(deleteDocResult.content[0].text)).toEqual({ ok: true });

    // 7. list_documents now shows total = 0
    const listAfter = await registry.callTool(
      'list_documents',
      { libraryId },
      ctx,
    );
    expect(JSON.parse(listAfter.content[0].text).total).toBe(0);

    // 8. delete_library (permanent)
    const deleteLibResult = await registry.callTool(
      'delete_library',
      { libraryId },
      ctx,
    );
    expect(deleteLibResult.isError).toBeFalsy();
    const delLibBody = JSON.parse(deleteLibResult.content[0].text);
    expect(delLibBody.ok).toBe(true);
    expect(delLibBody.deletedDocuments).toBe(0);

    // 9. list_libraries no longer shows the deleted library
    const listLibsResult = await registry.callTool(
      'list_libraries',
      {},
      ctx,
    );
    const libsBody = JSON.parse(listLibsResult.content[0].text);
    const stillThere = libsBody.libraries.find(
      (l: any) => l.id === libraryId,
    );
    expect(stillThere).toBeUndefined();
  });

  test('end-to-end: update_library + update_document + reprocess_document + upload_to_library', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Create library
    const lib = JSON.parse(
      (await registry.callTool('create_library', { name: 'Editable lib' }, ctx))
        .content[0].text,
    );
    const libraryId = lib.libraryId;

    // update_library
    const upLibResult = await registry.callTool(
      'update_library',
      { libraryId, name: 'Renamed', description: 'd' },
      ctx,
    );
    expect(upLibResult.isError).toBeFalsy();
    expect(JSON.parse(upLibResult.content[0].text)).toEqual({ ok: true });

    // Add a document
    const doc = JSON.parse(
      (await registry.callTool(
        'add_document',
        {
          libraryId,
          content: 'original content',
          title: 'orig',
          filename: 'orig.md',
        },
        ctx,
      )).content[0].text,
    );
    const docId = doc.documentId;

    // update_document with content → reprocessed: true
    const updDocResult = await registry.callTool(
      'update_document',
      {
        libraryId,
        documentId: docId,
        content: 'edited content with more text inside the body now',
        title: 'edited',
      },
      ctx,
    );
    expect(updDocResult.isError).toBeFalsy();
    expect(JSON.parse(updDocResult.content[0].text)).toEqual({
      ok: true,
      reprocessed: true,
    });

    // reprocess_document
    const reproc = await registry.callTool(
      'reprocess_document',
      { libraryId, documentId: docId },
      ctx,
    );
    expect(reproc.isError).toBeFalsy();
    const reprocBody = JSON.parse(reproc.content[0].text);
    expect(reprocBody.ok).toBe(true);
    expect(reprocBody.chunks).toBeGreaterThan(0);

    // upload_to_library (binary path via base64)
    const fileBase64 = Buffer.from('binary blob').toString('base64');
    const upResult = await registry.callTool(
      'upload_to_library',
      {
        libraryId,
        fileBase64,
        filename: 'attach.bin',
        mimeType: 'application/octet-stream',
      },
      ctx,
    );
    expect(upResult.isError).toBeFalsy();
    const upBody = JSON.parse(upResult.content[0].text);
    expect(upBody.documentId).toMatch(/^doc_/);
    expect(upBody.chunks).toBeGreaterThan(0);

    // list_documents should now have 2 docs (the edited one + the upload)
    const listResult = await registry.callTool(
      'list_documents',
      { libraryId },
      ctx,
    );
    const listBody = JSON.parse(listResult.content[0].text);
    expect(listBody.total).toBe(2);
  });

  test('end-to-end: chain handles upstream error gracefully without crashing', async () => {
    const registry = getNativeRegistry();

    // Override fetch to fail every call with 500
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const r = await registry.callTool(
      'create_library',
      { name: 'will-fail' },
      ctx,
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });
});
