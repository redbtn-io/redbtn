/**
 * Vitest for the conversation-access authz gap in `store_message` and
 * `get_context_history`.
 *
 * Both tools call MemoryManager directly against `user_conversations`
 * (bypassing the webapp API's ownership check that `get_messages` relies
 * on), so — before this fix — any caller supplying a guessed/known
 * conversationId could read or write another user's conversation.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

interface CollectionFixture {
  conversation: Record<string, unknown> | null;
}

const mockState: CollectionFixture = {
  conversation: null,
};

const mocks = vi.hoisted(() => ({
  userConversationsCollection: vi.fn(),
}));

vi.mock('mongoose', () => {
  const fake = {
    Types: {
      ObjectId: class {
        constructor(public id: string) {}
        static isValid(id: string) {
          return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id);
        }
      },
    },
    connection: {
      db: {
        collection(name: string) {
          if (name === 'user_conversations') return mocks.userConversationsCollection();
          return { findOne: vi.fn(async () => null) };
        },
      },
    },
  };
  return { default: fake, ...fake };
});

// Both tools reach MemoryManager only *after* the access check passes.
// Stub it out so an "allowed" test doesn't need a real Redis/Mongo.
const memoryManagerMocks = vi.hoisted(() => ({
  addMessage: vi.fn(async () => undefined),
  getContextForConversation: vi.fn(async () => []),
  getTrailingSummary: vi.fn(async () => null),
  getExecutiveSummary: vi.fn(async () => null),
}));

vi.mock('../../src/lib/memory/memory', () => ({
  MemoryManager: class {
    addMessage = memoryManagerMocks.addMessage;
    getContextForConversation = memoryManagerMocks.getContextForConversation;
    getTrailingSummary = memoryManagerMocks.getTrailingSummary;
    getExecutiveSummary = memoryManagerMocks.getExecutiveSummary;
  },
}));

import storeMessageTool from '../../src/lib/tools/native/store-message';
import getContextTool from '../../src/lib/tools/native/get-context';

const OWNED_CONVERSATION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

function setConversation(doc: Record<string, unknown> | null) {
  mockState.conversation = doc;
  mocks.userConversationsCollection.mockReturnValue({
    findOne: vi.fn(async () => mockState.conversation),
  });
}

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

describe('conversation-memory tools — access control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConversation({ _id: OWNED_CONVERSATION_ID, userId: 'convo-owner', participants: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('store_message', () => {
    test('rejects a caller that does not own or participate in the conversation', async () => {
      const r = await storeMessageTool.handler(
        { conversationId: OWNED_CONVERSATION_ID, role: 'user', content: 'hi' },
        makeMockContext({ state: { userId: 'attacker' } }),
      );

      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/Forbidden/);
      expect(memoryManagerMocks.addMessage).not.toHaveBeenCalled();
    });

    test('prefers trusted publisher identity over spoofable state.userId', async () => {
      const r = await storeMessageTool.handler(
        { conversationId: OWNED_CONVERSATION_ID, role: 'user', content: 'hi' },
        makeMockContext({
          publisher: { user: 'attacker' } as NativeToolContext['publisher'],
          state: { userId: 'convo-owner' },
        }),
      );

      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.error).toMatch(/Forbidden/);
      expect(memoryManagerMocks.addMessage).not.toHaveBeenCalled();
    });

    test('rejects a viewer participant (read-only role, cannot post)', async () => {
      setConversation({
        _id: OWNED_CONVERSATION_ID,
        userId: 'convo-owner',
        participants: [{ userId: 'viewer-user', role: 'viewer' }],
      });

      const r = await storeMessageTool.handler(
        { conversationId: OWNED_CONVERSATION_ID, role: 'user', content: 'hi' },
        makeMockContext({ state: { userId: 'viewer-user' } }),
      );

      expect(r.isError).toBe(true);
      expect(memoryManagerMocks.addMessage).not.toHaveBeenCalled();
    });

    test('allows the conversation owner to store a message', async () => {
      const r = await storeMessageTool.handler(
        { conversationId: OWNED_CONVERSATION_ID, role: 'user', content: 'hi' },
        makeMockContext({ state: { userId: 'convo-owner' } }),
      );

      expect(r.isError).toBeFalsy();
      expect(memoryManagerMocks.addMessage).toHaveBeenCalledTimes(1);
      expect(memoryManagerMocks.addMessage).toHaveBeenCalledWith(
        OWNED_CONVERSATION_ID,
        expect.objectContaining({ role: 'user', content: 'hi' }),
      );
    });

    test('allows a member participant to store a message', async () => {
      setConversation({
        _id: OWNED_CONVERSATION_ID,
        userId: 'convo-owner',
        participants: [{ userId: 'member-user', role: 'member' }],
      });

      const r = await storeMessageTool.handler(
        { conversationId: OWNED_CONVERSATION_ID, role: 'user', content: 'hi' },
        makeMockContext({ state: { userId: 'member-user' } }),
      );

      expect(r.isError).toBeFalsy();
      expect(memoryManagerMocks.addMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('get_context_history', () => {
    test('rejects a caller that does not own or participate in the conversation', async () => {
      const r = await getContextTool.handler(
        { conversationId: OWNED_CONVERSATION_ID },
        makeMockContext({ state: { userId: 'attacker' } }),
      );

      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/Forbidden/);
      expect(memoryManagerMocks.getContextForConversation).not.toHaveBeenCalled();
    });

    test('allows a viewer participant to read context', async () => {
      setConversation({
        _id: OWNED_CONVERSATION_ID,
        userId: 'convo-owner',
        participants: [{ userId: 'viewer-user', role: 'viewer' }],
      });

      const r = await getContextTool.handler(
        { conversationId: OWNED_CONVERSATION_ID },
        makeMockContext({ state: { userId: 'viewer-user' } }),
      );

      expect(r.isError).toBeFalsy();
      expect(memoryManagerMocks.getContextForConversation).toHaveBeenCalledTimes(1);
    });

    test('rejects when the conversation does not exist', async () => {
      setConversation(null);

      const r = await getContextTool.handler(
        { conversationId: OWNED_CONVERSATION_ID },
        makeMockContext({ state: { userId: 'anyone' } }),
      );

      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/not found/);
    });

    test('rejects when no userId is available on context', async () => {
      const r = await getContextTool.handler(
        { conversationId: OWNED_CONVERSATION_ID },
        makeMockContext({ state: {} }),
      );

      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/No userId available/);
    });
  });
});
