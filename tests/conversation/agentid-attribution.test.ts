/**
 * agentId Attribution Tests
 *
 * Verifies that multi-agent conversation runs stamp `metadata.agentId` onto the
 * persisted assistant message so the chat UI can attribute it correctly after
 * a page reload. Also verifies that absent agentId never writes the field
 * (backward-compatible / single-agent runs must not be broken).
 *
 * Self-contained Mongo lifecycle: connects to the shared test database
 * (MONGODB_TEST_URI / MONGODB_URI overridable) and cleans up ONLY the
 * conversation docs it creates (conv-agentid-test-*) — it never drops the
 * database, since the monorepo harness shares it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { ConversationPublisher } from '../../src/lib/conversation/conversation-publisher';
import { RunPublisher } from '../../src/lib/run/run-publisher';

const MONGO_URI =
  process.env.MONGODB_TEST_URI ||
  process.env.MONGODB_URI ||
  'mongodb://alpha:redbtnioai@localhost:27017/redbtn_test?authSource=admin';
const MONGO_CONNECT_OPTIONS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  socketTimeoutMS: 5000,
};

const COL = 'user_conversations';
const CONV_PREFIX = 'conv-agentid-test-';

// =============================================================================
// Minimal Redis mock — ConversationPublisher needs Redis for pub/sub, but we
// only care about the MongoDB persistence side here.
// =============================================================================

function createMockRedis() {
  const lists = new Map<string, string[]>();
  return {
    publish: async () => 1,
    rpush: async (key: string, ...values: string[]) => {
      if (!lists.has(key)) lists.set(key, []);
      lists.get(key)!.push(...values);
      return lists.get(key)!.length;
    },
    expire: async () => 1,
    incr: async () => 1,
  };
}

// =============================================================================
// Helpers
// =============================================================================

async function getMessages(conversationId: string): Promise<Array<Record<string, unknown>>> {
  const db = mongoose.connection.db!;
  const doc = await db.collection(COL).findOne({ conversationId });
  return (doc?.messages as Array<Record<string, unknown>>) ?? [];
}

async function createConversation(conversationId: string): Promise<void> {
  const db = mongoose.connection.db!;
  await db.collection(COL).insertOne({
    conversationId,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

function makePublisher(conversationId: string): ConversationPublisher {
  return new ConversationPublisher({
    redis: createMockRedis() as any,
    conversationId,
    userId: 'user-test-1',
  });
}

async function cleanupTestConversations(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) return;
  await db.collection(COL).deleteMany({ conversationId: { $regex: `^${CONV_PREFIX}` } });
}

beforeAll(async () => {
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(MONGO_URI, MONGO_CONNECT_OPTIONS);
  }
  await cleanupTestConversations();
});

afterAll(async () => {
  await cleanupTestConversations();
  await mongoose.disconnect();
});

// =============================================================================
// Tests
// =============================================================================

describe('agentId attribution — ConversationPublisher.persistMessage', () => {
  describe('publishRunComplete with agentId', () => {
    it('stamps metadata.agentId on the $push document (new message row)', async () => {
      const convId = `${CONV_PREFIX}001`;
      await createConversation(convId);

      const publisher = makePublisher(convId);
      const messageId = 'msg_agentid_001';
      const agentId = 'agent-claude-42';

      await publisher.publishRunComplete(
        'run-1',
        messageId,
        'Hello from agent',
        undefined, // tools
        undefined, // graphRun
        agentId,
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata?.agentId).toBe(agentId);
    });

    it('backfills metadata.agentId via in-place $set when the archiver wrote the row first', async () => {
      const convId = `${CONV_PREFIX}002`;
      await createConversation(convId);

      // Simulate: archiver already pushed the message (without agentId)
      const db = mongoose.connection.db!;
      const messageId = 'msg_agentid_002';
      const agentId = 'agent-red-7';
      await db.collection(COL).updateOne(
        { conversationId: convId },
        {
          $push: {
            messages: {
              id: messageId,
              role: 'assistant',
              content: 'Already written by archiver',
              metadata: { runId: 'run-2' }, // no agentId yet
              timestamp: new Date(),
            },
          } as any,
        },
      );

      // publishRunComplete should backfill agentId via the in-place $set
      const publisher = makePublisher(convId);
      await publisher.publishRunComplete(
        'run-2',
        messageId,
        'Already written by archiver',
        undefined,
        undefined,
        agentId,
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata?.agentId).toBe(agentId);
      // Sibling metadata keys must survive the backfill.
      expect(metadata?.runId).toBe('run-2');
    });

    it('does NOT write metadata.agentId when agentId is absent (single-agent)', async () => {
      const convId = `${CONV_PREFIX}003`;
      await createConversation(convId);

      const publisher = makePublisher(convId);
      const messageId = 'msg_agentid_003';

      await publisher.publishRunComplete(
        'run-3',
        messageId,
        'Single-agent response',
        undefined,
        undefined,
        // agentId intentionally omitted
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata).not.toHaveProperty('agentId');
    });
  });

  describe('publishRunError with agentId', () => {
    it('stamps metadata.agentId on the $push document for failed/interrupted runs', async () => {
      const convId = `${CONV_PREFIX}004`;
      await createConversation(convId);

      const publisher = makePublisher(convId);
      const messageId = 'msg_agentid_004';
      const agentId = 'agent-blue-3';

      await publisher.publishRunError(
        'run-4',
        messageId,
        'Something went wrong',
        [{ toolId: 'tool-1', toolName: 'search' }],
        agentId,
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata?.agentId).toBe(agentId);
    });

    it('stamps metadata.agentId even when no tools are present (agentId alone triggers persist)', async () => {
      const convId = `${CONV_PREFIX}005`;
      await createConversation(convId);

      const publisher = makePublisher(convId);
      const messageId = 'msg_agentid_005';
      const agentId = 'agent-green-99';

      await publisher.publishRunError(
        'run-5',
        messageId,
        'Error with no tools',
        [], // empty tools — agentId alone must trigger the persist
        agentId,
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata?.agentId).toBe(agentId);
    });

    it('does NOT write metadata.agentId for single-agent failed runs (backward compat)', async () => {
      const convId = `${CONV_PREFIX}006`;
      await createConversation(convId);

      const publisher = makePublisher(convId);
      const messageId = 'msg_agentid_006';

      await publisher.publishRunError(
        'run-6',
        messageId,
        'Error',
        [{ toolId: 'tool-2', toolName: 'fetch' }],
        // agentId intentionally omitted
      );

      const messages = await getMessages(convId);
      const msg = messages.find((m) => (m as any).id === messageId) as Record<string, unknown> | undefined;
      expect(msg).toBeDefined();
      const metadata = msg?.metadata as Record<string, unknown> | undefined;
      expect(metadata).not.toHaveProperty('agentId');
    });
  });
});

describe('agentId attribution — RunPublisher.agentId option', () => {
  it('RunPublisher accepts agentId in options without throwing', () => {
    const redis = createMockRedis();
    expect(() => {
      new RunPublisher({
        redis: redis as any,
        runId: 'run-agentid-constructor-1',
        userId: 'user-1',
        agentId: 'agent-test-123',
      });
    }).not.toThrow();
  });

  it('RunPublisher without agentId is backward-compatible', () => {
    const redis = createMockRedis();
    expect(() => {
      new RunPublisher({
        redis: redis as any,
        runId: 'run-noagent-constructor-1',
        userId: 'user-1',
        // no agentId
      });
    }).not.toThrow();
  });
});
