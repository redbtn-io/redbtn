/**
 * E2E tests for all 9 native tools in the redbtn engine.
 *
 * Tools that only need network access (fetch_url, ssh_shell, ssh_copy) run
 * full integration tests. Tools that require MongoDB, Redis, or ChromaDB
 * probe connectivity first and skip if the service is unreachable.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import type {
  NativeToolContext,
} from '../../src/lib/tools/native-registry';

// Import all 9 native tools directly.
// The vitest config strips `module.exports = ...` lines from these files
// to avoid ESM/CJS conflict at load time.
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';
import sshShellTool from '../../src/lib/tools/native/ssh-shell';
import sshCopyTool from '../../src/lib/tools/native/ssh-copy';
import invokeFunctionTool from '../../src/lib/tools/native/invoke-function';
import libraryWriteTool from '../../src/lib/tools/native/library-write';
import storeMessageTool from '../../src/lib/tools/native/store-message';
import getContextTool from '../../src/lib/tools/native/get-context';
import searchDocumentsTool from '../../src/lib/tools/native/search-documents';
import addDocumentTool from '../../src/lib/tools/native/add-document';

// ---------------------------------------------------------------------------
// Service availability probes
// ---------------------------------------------------------------------------

const MONGO_URI =
  'mongodb://alpha:redbtnioai@localhost:27017/?authSource=admin';
const REDIS_URL =
  'redis://:lUdJGxwzPskqIF%2B1Hd8CEeMdNr4zbKC2eaGyOXi%2FNkY%3D@localhost:6379';
const CHROMA_URL = 'http://localhost:8024';
const SSH_KEY_PATH = '/home/alpha/s';

// Service flags - set during beforeAll, checked at test runtime via ctx.skip().
const services = {
  mongo: false,
  redis: false,
  chroma: false, // Requires both ChromaDB and Ollama (for embeddings)
};

async function probeService(
  name: string,
  fn: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const ok = await fn();
    console.log(`[probe] ${name}: ${ok ? 'available' : 'unavailable'}`);
    return ok;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[probe] ${name}: unavailable -- ${msg}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Shared mock context
// ---------------------------------------------------------------------------

const logs: Array<{ event: string; data: unknown }> = [];

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: {
      emit: (event: string, data: unknown) => {
        logs.push({ event, data });
      },
      publish: (data: unknown) => {
        logs.push({ event: 'publish', data });
      },
    },
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup & teardown
// ---------------------------------------------------------------------------

let mongooseModule: typeof import('mongoose') | null = null;

beforeAll(async () => {
  // Set env vars that tools rely on
  process.env.REDIS_URL = REDIS_URL;
  process.env.CHROMA_URL = CHROMA_URL;
  process.env.MONGODB_URI = MONGO_URI;
  process.env.MONGODB_DATABASE = 'redbtn-beta';

  // Probe MongoDB
  services.mongo = await probeService('MongoDB', async () => {
    const mongoose = await import('mongoose');
    mongooseModule = mongoose;
    try {
      await mongoose.default.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000,
        dbName: 'redbtn-beta',
      });
      return mongoose.default.connection.readyState === 1;
    } catch {
      return false;
    }
  });

  // Probe Redis
  services.redis = await probeService('Redis', async () => {
    const Redis = (await import('ioredis')).default;
    const client = new Redis(REDIS_URL, { connectTimeout: 3000, lazyConnect: true });
    try {
      await client.connect();
      const pong = await client.ping();
      await client.quit();
      return pong === 'PONG';
    } catch {
      try { await client.quit(); } catch { /* ignore */ }
      return false;
    }
  });

  // Probe ChromaDB (try v2 API first, then v1)
  const chromaUp = await probeService('ChromaDB', async () => {
    for (const path of ['/api/v2/heartbeat', '/api/v1/heartbeat']) {
      const res = await fetch(`${CHROMA_URL}${path}`, {
        signal: AbortSignal.timeout(3000),
      }).catch(() => null);
      if (res?.ok) return true;
    }
    return false;
  });

  // ChromaDB tests also need Ollama for embedding generation
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const ollamaUp = await probeService('Ollama', async () => {
    const res = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    }).catch(() => null);
    return res?.ok ?? false;
  });

  services.chroma = chromaUp && ollamaUp;
}, 30_000);

afterAll(async () => {
  if (mongooseModule) {
    try {
      await mongooseModule.default.disconnect();
    } catch { /* ignore */ }
  }
});

// ==========================================================================
// 1. fetch_url
// ==========================================================================

describe('fetch_url', () => {
  const tool = fetchUrlTool;

  test('schema has required url field', () => {
    expect(tool.description).toContain('HTTP');
    expect(tool.inputSchema.required).toContain('url');
    expect(tool.inputSchema.properties.url).toBeDefined();
    expect(tool.inputSchema.properties.method).toBeDefined();
    expect(tool.inputSchema.properties.headers).toBeDefined();
    expect(tool.inputSchema.properties.body).toBeDefined();
    expect(tool.inputSchema.properties.timeout).toBeDefined();
  });

  test('GET request returns status and body', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler({ url: 'https://httpbin.org/get' }, ctx);
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(200);
    expect(body.headers).toBeDefined();
    expect(body.body).toBeDefined();
  });

  test('POST request sends body', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        url: 'https://httpbin.org/post',
        method: 'POST',
        body: JSON.stringify({ test: true, source: 'native-tool-e2e' }),
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(200);
    // httpbin echoes the posted data
    const responseBody = JSON.parse(body.body);
    expect(responseBody.json).toEqual({ test: true, source: 'native-tool-e2e' });
  });

  test('HEAD request returns headers only', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      { url: 'https://httpbin.org/get', method: 'HEAD' },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(200);
    expect(body.headers).toBeDefined();
    // HEAD response body is empty string
    expect(body.body).toBe('');
  });

  test('timeout produces isError result', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      { url: 'https://httpbin.org/delay/10', timeout: 2000 },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/timed out|abort/i);
  });

  test('missing URL returns error', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler({ url: '' }, ctx);
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toMatch(/no url/i);
  });

  test('PUT request works', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        url: 'https://httpbin.org/put',
        method: 'PUT',
        body: JSON.stringify({ updated: true }),
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.status).toBe(200);
  });

  test('custom headers are sent', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        url: 'https://httpbin.org/headers',
        headers: { 'X-Custom-Test': 'redbtn-native-e2e' },
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    const responseBody = JSON.parse(body.body);
    expect(responseBody.headers['X-Custom-Test']).toBe('redbtn-native-e2e');
  });
});

// ==========================================================================
// 2. ssh_shell
// ==========================================================================

describe('ssh_shell', () => {
  const tool = sshShellTool;

  test('schema has required host and command fields', () => {
    expect(tool.description).toContain('SSH');
    expect(tool.inputSchema.required).toContain('host');
    expect(tool.inputSchema.required).toContain('command');
    expect(tool.inputSchema.properties.port).toBeDefined();
    expect(tool.inputSchema.properties.user).toBeDefined();
    expect(tool.inputSchema.properties.sshKeyPath).toBeDefined();
    expect(tool.inputSchema.properties.timeout).toBeDefined();
  });

  test('execute echo command on localhost', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'echo hello-from-native-test',
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.stdout).toContain('hello-from-native-test');
    expect(body.exitCode).toBe(0);
    expect(body.success).toBe(true);
  });

  test('captures stderr and non-zero exit code', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'echo error-output >&2; exit 42',
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    const body = JSON.parse(result.content[0].text);
    expect(body.exitCode).toBe(42);
    expect(body.stderr).toContain('error-output');
    expect(body.success).toBe(false);
  });

  test('workingDir changes directory', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'pwd',
        sshKeyPath: SSH_KEY_PATH,
        workingDir: '/tmp',
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.stdout.trim()).toBe('/tmp');
    expect(body.exitCode).toBe(0);
  });

  test('env vars are exported', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'echo $TEST_VAR_NATIVE',
        sshKeyPath: SSH_KEY_PATH,
        env: { TEST_VAR_NATIVE: 'native-tool-e2e-val' },
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.stdout).toContain('native-tool-e2e-val');
  });

  test('timeout triggers error', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'sleep 30',
        sshKeyPath: SSH_KEY_PATH,
        timeout: 2000,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('timed out');
  });

  test('multiline output is captured', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        command: 'echo line1; echo line2; echo line3',
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.stdout).toContain('line1');
    expect(body.stdout).toContain('line2');
    expect(body.stdout).toContain('line3');
  });
});

// ==========================================================================
// 3. ssh_copy
// ==========================================================================

describe('ssh_copy', () => {
  const tool = sshCopyTool;

  test('schema has required host and remotePath fields', () => {
    expect(tool.description).toContain('SSH');
    expect(tool.description).toContain('SFTP');
    expect(tool.inputSchema.required).toContain('host');
    expect(tool.inputSchema.required).toContain('remotePath');
    expect(tool.inputSchema.properties.content).toBeDefined();
    expect(tool.inputSchema.properties.sourceUrl).toBeDefined();
    expect(tool.inputSchema.properties.libraryId).toBeDefined();
  });

  test('copy inline content to remote file', async () => {
    const ctx = makeMockContext();
    const testContent = `test content from native-tools e2e -- ${Date.now()}`;
    const remotePath = `/tmp/native-test-${Date.now()}.txt`;

    const result = await tool.handler(
      {
        host: 'localhost',
        remotePath,
        content: testContent,
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.filesTransferred).toBe(1);
    expect(body.totalBytes).toBeGreaterThan(0);

    // Verify the file was written by reading it back via SSH
    const { execSync } = await import('child_process');
    const readBack = execSync(
      `ssh -o StrictHostKeyChecking=no -i ${SSH_KEY_PATH} alpha@localhost cat ${remotePath}`,
    ).toString();
    expect(readBack).toBe(testContent);

    // Clean up
    execSync(
      `ssh -o StrictHostKeyChecking=no -i ${SSH_KEY_PATH} alpha@localhost rm -f ${remotePath}`,
    );
  });

  test('copy base64 content', async () => {
    const ctx = makeMockContext();
    const originalContent = 'binary-safe content test';
    const b64 = Buffer.from(originalContent).toString('base64');
    const remotePath = `/tmp/native-test-b64-${Date.now()}.txt`;

    const result = await tool.handler(
      {
        host: 'localhost',
        remotePath,
        content: b64,
        contentBase64: true,
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);

    // Verify
    const { execSync } = await import('child_process');
    const readBack = execSync(
      `ssh -o StrictHostKeyChecking=no -i ${SSH_KEY_PATH} alpha@localhost cat ${remotePath}`,
    ).toString();
    expect(readBack).toBe(originalContent);

    // Clean up
    execSync(
      `ssh -o StrictHostKeyChecking=no -i ${SSH_KEY_PATH} alpha@localhost rm -f ${remotePath}`,
    );
  });

  test('error when no content source provided', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler(
      {
        host: 'localhost',
        remotePath: '/tmp/no-source.txt',
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('No content source');
  });

  test('creates intermediate directories', async () => {
    const ctx = makeMockContext();
    const dirName = `native-test-dir-${Date.now()}`;
    const remotePath = `/tmp/${dirName}/subdir/file.txt`;

    const result = await tool.handler(
      {
        host: 'localhost',
        remotePath,
        content: 'nested dir test',
        sshKeyPath: SSH_KEY_PATH,
      },
      ctx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);

    // Clean up
    const { execSync } = await import('child_process');
    execSync(
      `ssh -o StrictHostKeyChecking=no -i ${SSH_KEY_PATH} alpha@localhost rm -rf /tmp/${dirName}`,
    );
  });
});

// ==========================================================================
// 4. invoke_function
// ==========================================================================

describe('invoke_function', () => {
  const tool = invokeFunctionTool;

  test('schema has required fields', () => {
    expect(tool.description).toContain('RedRun');
    expect(tool.inputSchema.required).toContain('url');
    expect(tool.inputSchema.required).toContain('functionName');
    expect(tool.inputSchema.required).toContain('body');
    expect(tool.inputSchema.properties.apiKey).toBeDefined();
    expect(tool.inputSchema.properties.timeout).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('returns error or throws for unreachable URL', async () => {
    const ctx = makeMockContext();
    // The handler does not catch fetch connection errors (throws TypeError),
    // so we expect either an isError result or a thrown error.
    try {
      const result = await tool.handler(
        {
          url: 'http://127.0.0.1:19999',
          functionName: 'nonexistent',
          body: {},
        },
        ctx,
      );
      // If it returns instead of throwing, it should be an error result
      expect(result.isError).toBe(true);
    } catch (err: unknown) {
      // fetch connection refused throws TypeError -- acceptable behavior
      expect(err).toBeInstanceOf(TypeError);
    }
  });
});

// ==========================================================================
// 5. library_write
// ==========================================================================

describe('library_write', () => {
  const tool = libraryWriteTool;

  test('schema has required fields', () => {
    expect(tool.description).toContain('Knowledge Library');
    expect(tool.inputSchema.required).toContain('libraryId');
    expect(tool.inputSchema.required).toContain('title');
    expect(tool.inputSchema.required).toContain('content');
    expect(tool.inputSchema.properties.filename).toBeDefined();
    expect(tool.inputSchema.properties.mimeType).toBeDefined();
    expect(tool.inputSchema.properties.sourceType).toBeDefined();
    expect(tool.inputSchema.properties.metadata).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('returns error for nonexistent library (requires MongoDB)', async (ctx) => {
    if (!services.mongo) {
      ctx.skip();
      return;
    }
    const mockCtx = makeMockContext();
    const result = await tool.handler(
      {
        libraryId: 'nonexistent-lib-' + Date.now(),
        title: 'Test Document',
        content: 'Test content for library write',
      },
      mockCtx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.error).toContain('not found');
  });
});

// ==========================================================================
// 6. store_message
// ==========================================================================

describe('store_message', () => {
  const tool = storeMessageTool;

  test('schema has required fields', () => {
    expect(tool.description).toContain('message');
    expect(tool.inputSchema.required).toContain('conversationId');
    expect(tool.inputSchema.required).toContain('role');
    expect(tool.inputSchema.required).toContain('content');
    expect(tool.inputSchema.properties.messageId).toBeDefined();
    expect(tool.inputSchema.properties.metadata).toBeDefined();
    expect(tool.inputSchema.properties.toolExecutions).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('role enum includes system, user, assistant', () => {
    expect(tool.inputSchema.properties.role.enum).toEqual([
      'system',
      'user',
      'assistant',
    ]);
  });

  test('stores a message successfully (requires Redis)', async (ctx) => {
    if (!services.redis) {
      ctx.skip();
      return;
    }
    const mockCtx = makeMockContext();
    const convId = `test-conv-${Date.now()}`;
    const result = await tool.handler(
      {
        conversationId: convId,
        role: 'user',
        content: 'Hello from native tool e2e test',
      },
      mockCtx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.success).toBe(true);
    expect(body.conversationId).toBe(convId);
    expect(body.messageId).toBeDefined();
    expect(body.timestamp).toBeDefined();

    // Clean up: remove the test conversation from Redis
    const Redis = (await import('ioredis')).default;
    const client = new Redis(REDIS_URL);
    const keys = await client.keys(`conv:${convId}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });
});

// ==========================================================================
// 7. get_context_history
// ==========================================================================

describe('get_context_history', () => {
  const tool = getContextTool;

  test('schema has required conversationId field', () => {
    expect(tool.description).toContain('context');
    expect(tool.inputSchema.required).toContain('conversationId');
    expect(tool.inputSchema.properties.maxTokens).toBeDefined();
    expect(tool.inputSchema.properties.format).toBeDefined();
    expect(tool.inputSchema.properties.includeSystemPrompt).toBeDefined();
    expect(tool.inputSchema.properties.includeSummary).toBeDefined();
    expect(tool.inputSchema.properties.summaryType).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('format enum includes raw, formatted, llm', () => {
    expect(tool.inputSchema.properties.format.enum).toEqual([
      'raw',
      'formatted',
      'llm',
    ]);
  });

  test('returns empty context for nonexistent conversation (requires Redis)', async (ctx) => {
    if (!services.redis) {
      ctx.skip();
      return;
    }
    const mockCtx = makeMockContext();
    const result = await tool.handler(
      {
        conversationId: 'nonexistent-conv-' + Date.now(),
        format: 'raw',
      },
      mockCtx,
    );
    // Should succeed but return empty messages
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.messages).toBeDefined();
    expect(body.messages.length).toBe(0);
  });

  test('round-trip: store then retrieve message (requires Redis)', async (ctx) => {
    if (!services.redis) {
      ctx.skip();
      return;
    }
    const mockCtx = makeMockContext();
    const convId = `test-roundtrip-${Date.now()}`;

    // Store a message
    await storeMessageTool.handler(
      {
        conversationId: convId,
        role: 'user',
        content: 'round-trip test message',
      },
      mockCtx,
    );

    // Retrieve context
    const result = await tool.handler(
      { conversationId: convId, format: 'raw' },
      mockCtx,
    );
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(result.content[0].text);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);

    const found = body.messages.some(
      (m: { content: string }) => m.content === 'round-trip test message',
    );
    expect(found).toBe(true);

    // Clean up
    const Redis = (await import('ioredis')).default;
    const client = new Redis(REDIS_URL);
    const keys = await client.keys(`conv:${convId}:*`);
    if (keys.length > 0) await client.del(...keys);
    await client.quit();
  });
});

// ==========================================================================
// 8. search_documents
// ==========================================================================

describe('search_documents', () => {
  const tool = searchDocumentsTool;

  test('schema has required query field', () => {
    expect(tool.description).toContain('vector');
    expect(tool.inputSchema.required).toContain('query');
    expect(tool.inputSchema.properties.collection).toBeDefined();
    expect(tool.inputSchema.properties.topK).toBeDefined();
    expect(tool.inputSchema.properties.threshold).toBeDefined();
    expect(tool.inputSchema.properties.filter).toBeDefined();
    expect(tool.inputSchema.properties.mergeChunks).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('returns error for empty query', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler({ query: '' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No query');
  });

  test('searches a collection without error (requires ChromaDB)', async (ctx) => {
    if (!services.chroma) {
      ctx.skip();
      return;
    }
    const mockCtx = makeMockContext();
    const result = await tool.handler(
      {
        query: 'test query for native tool e2e',
        collection: 'test_native_e2e',
        topK: 3,
      },
      mockCtx,
    );
    // May return no results (empty collection), but should not error
    expect(result.isError).toBeFalsy();
  });
});

// ==========================================================================
// 9. add_document
// ==========================================================================

describe('add_document', () => {
  const tool = addDocumentTool;

  test('schema has required text field', () => {
    expect(tool.description).toContain('vector');
    expect(tool.inputSchema.required).toContain('text');
    expect(tool.inputSchema.properties.collection).toBeDefined();
    expect(tool.inputSchema.properties.source).toBeDefined();
    expect(tool.inputSchema.properties.metadata).toBeDefined();
    expect(tool.inputSchema.properties.chunkSize).toBeDefined();
    expect(tool.inputSchema.properties.chunkOverlap).toBeDefined();
  });

  test('handler is a function', () => {
    expect(typeof tool.handler).toBe('function');
  });

  test('returns error for empty text', async () => {
    const ctx = makeMockContext();
    const result = await tool.handler({ text: '' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No text');
  });

  test('round-trip: add then search document (requires ChromaDB)', async (ctx) => {
    if (!services.chroma) {
      ctx.skip();
      return;
    }
    const addTool = tool;
    const searchTool = searchDocumentsTool;
    const mockCtx = makeMockContext();
    const collectionName = `test_native_e2e_${Date.now()}`;
    const uniquePhrase = `unique-phrase-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Add a document
    const addResult = await addTool.handler(
      {
        text: `This is a test document containing the phrase: ${uniquePhrase}. It was created by the native tool e2e test suite to verify add_document and search_documents work correctly.`,
        collection: collectionName,
        source: 'native-tool-e2e-test',
        metadata: { test: true },
      },
      mockCtx,
    );
    expect(addResult.isError).toBeFalsy();
    expect(addResult.content[0].text).toContain('Successfully added');

    // Search for it
    const searchResult = await searchTool.handler(
      {
        query: uniquePhrase,
        collection: collectionName,
        topK: 5,
        threshold: 0.3,
      },
      mockCtx,
    );
    expect(searchResult.isError).toBeFalsy();
    expect(searchResult.content[0].text).toContain(uniquePhrase);

    // Clean up: delete collection
    try {
      const { ChromaClient } = await import('chromadb');
      const chroma = new ChromaClient({ path: CHROMA_URL });
      await chroma.deleteCollection({ name: collectionName });
    } catch { /* best-effort cleanup */ }
  });
});
