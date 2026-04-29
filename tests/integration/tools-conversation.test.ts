/**
 * Integration test for the native conversation pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The redbtn graph compiler depends on MongoDB / Redis / LangGraph plumbing
 * which is not always available in CI. This test exercises the layer a graph
 * node actually calls when it runs a `tool` step, in the canonical lifecycle
 * order:
 *
 *   1. NativeToolRegistry singleton has all 12 conversation-pack tools registered.
 *   2. A simulated multi-step "graph" runs:
 *        create_conversation         → make a fresh conversation
 *        set_conversation_title      → rename it
 *        get_conversation_metadata   → confirm the new title
 *        add_participant             → invite a user
 *        list_participants           → confirm the invite shows up
 *        list_threads                → empty initially
 *        create_thread               → branch a thread
 *        list_threads                → confirm the thread now shows up
 *        get_messages                → read messages on the thread
 *
 * The webapp API is mocked via global fetch with an in-memory backing store
 * that mimics the conversation collection semantics.
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

// Re-import each tool by path. In production, native-registry.ts loads each
// via require('./native/foo.js'); when running TS sources under vitest those
// .js paths don't exist next to the .ts module, so the catch block silently
// swallows the failure. We work around it by importing the TS modules and
// explicitly re-registering them with the singleton.
import createConversationTool from '../../src/lib/tools/native/create-conversation';
import listConversationsTool from '../../src/lib/tools/native/list-conversations';
import getConversationTool from '../../src/lib/tools/native/get-conversation';
import getMessagesTool from '../../src/lib/tools/native/get-messages';
import getConversationMetadataTool from '../../src/lib/tools/native/get-conversation-metadata';
import getConversationSummaryTool from '../../src/lib/tools/native/get-conversation-summary';
import setConversationTitleTool from '../../src/lib/tools/native/set-conversation-title';
import deleteConversationTool from '../../src/lib/tools/native/delete-conversation';
import listThreadsTool from '../../src/lib/tools/native/list-threads';
import createThreadTool from '../../src/lib/tools/native/create-thread';
import listParticipantsTool from '../../src/lib/tools/native/list-participants';
import addParticipantTool from '../../src/lib/tools/native/add-participant';

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

interface MockMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  parentMessageId?: string;
  threadConversationId?: string;
}

interface MockParticipant {
  userId: string;
  role: string;
  joinedAt: string;
  displayName?: string;
  email?: string;
}

interface MockConversation {
  id: string;
  title: string;
  isArchived: boolean;
  isThread: boolean;
  parentConversationId?: string;
  parentMessageId?: string;
  participants: MockParticipant[];
  messages: MockMessage[];
  summary: string | null;
  trailingSummary: string | null;
  createdAt: string;
  lastMessageAt: string | null;
  messageCount: number;
}

/**
 * In-memory mock for the webapp's /api/v1/conversations API.
 *
 * Routes handled:
 *   GET    /api/v1/conversations
 *   POST   /api/v1/conversations
 *   GET    /api/v1/conversations/:id
 *   PATCH  /api/v1/conversations/:id
 *   DELETE /api/v1/conversations/:id
 *   GET    /api/v1/conversations/:id/messages
 *   POST   /api/v1/conversations/:id/messages
 *   GET    /api/v1/conversations/:id/summary
 *   GET    /api/v1/conversations/:id/threads
 *   POST   /api/v1/conversations/:id/threads
 *   GET    /api/v1/conversations/:id/participants
 *   POST   /api/v1/conversations/:id/participants
 */
function createMockConversationApi(): typeof globalThis.fetch {
  const conversations: Record<string, MockConversation> = {};
  let convCounter = 1;
  let msgCounter = 1;

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : (input as URL).toString();
    const url = new URL(u);
    const method = (init?.method || 'GET').toUpperCase();
    const path = url.pathname;

    // /api/v1/conversations/:id/threads
    let m = path.match(/^\/api\/v1\/conversations\/([^/]+)\/threads$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conv = conversations[id];
      if (!conv) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'GET') {
        const threads = Object.values(conversations).filter(
          c => c.parentConversationId === id,
        );
        return new Response(
          JSON.stringify({
            threads: threads.map(t => ({
              id: t.id,
              parentMessageId: t.parentMessageId,
              replyCount: Math.max(0, t.messageCount - 1),
              lastMessageAt: t.lastMessageAt,
              title: t.title,
            })),
          }),
          { status: 200 },
        );
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const parentMessageId = body.parentMessageId;
        if (!parentMessageId) {
          return new Response(JSON.stringify({ error: 'parentMessageId required' }), {
            status: 400,
          });
        }
        // Idempotent — find existing thread for this parentMessageId
        const existing = Object.values(conversations).find(
          c => c.parentConversationId === id && c.parentMessageId === parentMessageId,
        );
        if (existing) {
          return new Response(
            JSON.stringify({ threadConversationId: existing.id, created: false }),
            { status: 200 },
          );
        }
        const threadId = `thread_${convCounter++}`;
        const now = new Date().toISOString();
        conversations[threadId] = {
          id: threadId,
          title: `Thread off ${parentMessageId}`,
          isArchived: false,
          isThread: true,
          parentConversationId: id,
          parentMessageId,
          participants: [...conv.participants],
          messages: [],
          summary: null,
          trailingSummary: null,
          createdAt: now,
          lastMessageAt: now,
          messageCount: 0,
        };
        return new Response(
          JSON.stringify({ threadConversationId: threadId, created: true }),
          { status: 200 },
        );
      }
    }

    // /api/v1/conversations/:id/participants
    m = path.match(/^\/api\/v1\/conversations\/([^/]+)\/participants$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conv = conversations[id];
      if (!conv) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'GET') {
        return new Response(JSON.stringify({ participants: conv.participants }), {
          status: 200,
        });
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (!body.userId && !body.email) {
          return new Response(JSON.stringify({ error: 'userId or email required' }), {
            status: 400,
          });
        }
        const targetId = body.userId || `synth_${body.email}`;
        if (conv.participants.some(p => p.userId === targetId)) {
          return new Response(JSON.stringify({ error: 'Already a participant' }), {
            status: 409,
          });
        }
        const newP: MockParticipant = {
          userId: targetId,
          role: body.role || 'member',
          joinedAt: new Date().toISOString(),
        };
        conv.participants.push(newP);
        return new Response(JSON.stringify({ participant: newP }), { status: 201 });
      }
    }

    // /api/v1/conversations/:id/messages
    m = path.match(/^\/api\/v1\/conversations\/([^/]+)\/messages$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conv = conversations[id];
      if (!conv) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || '50');
        const before = url.searchParams.get('before')
          ? Number(url.searchParams.get('before'))
          : null;
        let msgs = [...conv.messages];
        if (before !== null) msgs = msgs.filter(x => x.timestamp < before);
        msgs.sort((a, b) => a.timestamp - b.timestamp);
        const hasMore = msgs.length > limit;
        if (hasMore) msgs = msgs.slice(-limit);
        return new Response(
          JSON.stringify({ messages: msgs, hasMore, total: conv.messages.length }),
          { status: 200 },
        );
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        if (!body.content) {
          return new Response(JSON.stringify({ error: 'content required' }), {
            status: 400,
          });
        }
        const now = Date.now();
        const newMsg: MockMessage = {
          id: `msg_${msgCounter++}`,
          role: 'user',
          content: body.content,
          timestamp: now,
          ...(body.parentMessageId ? { parentMessageId: body.parentMessageId } : {}),
        };
        conv.messages.push(newMsg);
        conv.messageCount += 1;
        conv.lastMessageAt = new Date(now).toISOString();
        return new Response(JSON.stringify({ message: newMsg }), { status: 201 });
      }
    }

    // /api/v1/conversations/:id/summary
    m = path.match(/^\/api\/v1\/conversations\/([^/]+)\/summary$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conv = conversations[id];
      if (!conv) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      }
      if (method === 'GET') {
        return new Response(
          JSON.stringify({
            summary: conv.summary,
            executiveSummary: conv.summary,
            trailingSummary: conv.trailingSummary,
            generatedAt: conv.lastMessageAt,
            fromCache: true,
            regenerated: false,
          }),
          { status: 200 },
        );
      }
    }

    // /api/v1/conversations/:id
    m = path.match(/^\/api\/v1\/conversations\/([^/]+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const conv = conversations[id];
      if (method === 'GET') {
        if (!conv) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        return new Response(
          JSON.stringify({
            conversation: {
              id: conv.id,
              title: conv.title,
              isArchived: conv.isArchived,
              messages: conv.messages,
              messageCount: conv.messageCount,
              lastMessageAt: conv.lastMessageAt,
              createdAt: conv.createdAt,
              participants: conv.participants,
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'PATCH') {
        if (!conv) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        const body = JSON.parse(String(init?.body || '{}'));
        if (typeof body.title === 'string') conv.title = body.title;
        if (typeof body.isArchived === 'boolean') conv.isArchived = body.isArchived;
        return new Response(JSON.stringify({ conversation: conv }), { status: 200 });
      }
      if (method === 'DELETE') {
        if (!conv) {
          return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
        delete conversations[id];
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
    }

    // /api/v1/conversations
    if (path === '/api/v1/conversations') {
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        const newId = `conv_${convCounter++}`;
        const now = new Date().toISOString();
        const conv: MockConversation = {
          id: newId,
          title: body.title || 'New Conversation',
          isArchived: false,
          isThread: false,
          participants: [
            { userId: 'caller', role: 'owner', joinedAt: now },
          ],
          messages: [],
          summary: null,
          trailingSummary: null,
          createdAt: now,
          lastMessageAt: now,
          messageCount: 0,
        };
        conversations[newId] = conv;
        return new Response(
          JSON.stringify({
            conversation: {
              id: newId,
              title: conv.title,
              createdAt: now,
              lastMessageAt: now,
              messageCount: 0,
              isArchived: false,
              participants: conv.participants,
              messages: [],
            },
          }),
          { status: 200 },
        );
      }
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit') || '20');
        const offset = Number(url.searchParams.get('offset') || '0');
        const includeArchived = url.searchParams.get('includeArchived') === 'true';
        const all = Object.values(conversations).filter(
          c => (includeArchived || !c.isArchived) && !c.isThread,
        );
        const page = all.slice(offset, offset + limit);
        return new Response(
          JSON.stringify({ conversations: page, total: all.length, limit, offset }),
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

describe('conversation pack integration — registration + chained execution', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebappUrl: string | undefined;

  beforeAll(() => {
    // Re-register all 12 tools against the singleton. In production this is
    // done by `registerBuiltinTools` via require('./native/foo.js'), which
    // doesn't fire when running TS sources under vitest (no .js sibling).
    const registry = getNativeRegistry();
    if (!registry.has('create_conversation'))
      registry.register('create_conversation', createConversationTool);
    if (!registry.has('list_conversations'))
      registry.register('list_conversations', listConversationsTool);
    if (!registry.has('get_conversation'))
      registry.register('get_conversation', getConversationTool);
    if (!registry.has('get_messages'))
      registry.register('get_messages', getMessagesTool);
    if (!registry.has('get_conversation_metadata'))
      registry.register('get_conversation_metadata', getConversationMetadataTool);
    if (!registry.has('get_conversation_summary'))
      registry.register('get_conversation_summary', getConversationSummaryTool);
    if (!registry.has('set_conversation_title'))
      registry.register('set_conversation_title', setConversationTitleTool);
    if (!registry.has('delete_conversation'))
      registry.register('delete_conversation', deleteConversationTool);
    if (!registry.has('list_threads'))
      registry.register('list_threads', listThreadsTool);
    if (!registry.has('create_thread'))
      registry.register('create_thread', createThreadTool);
    if (!registry.has('list_participants'))
      registry.register('list_participants', listParticipantsTool);
    if (!registry.has('add_participant'))
      registry.register('add_participant', addParticipantTool);
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebappUrl = process.env.WEBAPP_URL;
    process.env.WEBAPP_URL = WEBAPP;
    globalThis.fetch = createMockConversationApi();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalWebappUrl === undefined) delete process.env.WEBAPP_URL;
    else process.env.WEBAPP_URL = originalWebappUrl;
    vi.restoreAllMocks();
  });

  test('NativeToolRegistry has all 12 conversation tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'create_conversation',
      'list_conversations',
      'get_conversation',
      'get_messages',
      'get_conversation_metadata',
      'get_conversation_summary',
      'set_conversation_title',
      'delete_conversation',
      'list_threads',
      'create_thread',
      'list_participants',
      'add_participant',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    // All conversation tools share the 'conversation' server tag for UI grouping.
    const conv = registry.get('create_conversation')!;
    expect(conv.server).toBe('conversation');
  });

  test('end-to-end: create → title → metadata → participants → threads → messages', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // 1. create_conversation
    const createResult = await registry.callTool(
      'create_conversation',
      { title: 'Project sync' },
      ctx,
    );
    expect(createResult.isError).toBeFalsy();
    const created = JSON.parse(createResult.content[0].text);
    const conversationId = created.conversationId;
    expect(conversationId).toMatch(/^conv_/);
    expect(created.createdAt).toBeDefined();

    // 2. set_conversation_title
    const renameResult = await registry.callTool(
      'set_conversation_title',
      { conversationId, title: 'Renamed Project Sync' },
      ctx,
    );
    expect(renameResult.isError).toBeFalsy();
    expect(JSON.parse(renameResult.content[0].text)).toEqual({ ok: true });

    // 3. get_conversation_metadata reflects the rename
    const metaResult = await registry.callTool(
      'get_conversation_metadata',
      { conversationId },
      ctx,
    );
    expect(metaResult.isError).toBeFalsy();
    const meta = JSON.parse(metaResult.content[0].text);
    expect(meta.id).toBe(conversationId);
    expect(meta.title).toBe('Renamed Project Sync');
    expect(meta.participants).toHaveLength(1);
    expect(meta.participants[0].role).toBe('owner');

    // 4. add_participant
    const addResult = await registry.callTool(
      'add_participant',
      { conversationId, userId: 'u_invitee', role: 'member' },
      ctx,
    );
    expect(addResult.isError).toBeFalsy();
    expect(JSON.parse(addResult.content[0].text)).toEqual({ ok: true });

    // 5. list_participants now has 2 entries
    const listPResult = await registry.callTool(
      'list_participants',
      { conversationId },
      ctx,
    );
    expect(listPResult.isError).toBeFalsy();
    const listP = JSON.parse(listPResult.content[0].text);
    expect(listP.participants).toHaveLength(2);
    const invitee = listP.participants.find((p: any) => p.userId === 'u_invitee');
    expect(invitee?.role).toBe('member');
    expect(invitee?.addedAt).toBeDefined();

    // 6. list_threads is empty initially
    const threadsBefore = await registry.callTool(
      'list_threads',
      { conversationId },
      ctx,
    );
    expect(threadsBefore.isError).toBeFalsy();
    expect(JSON.parse(threadsBefore.content[0].text).threads).toEqual([]);

    // 7. Post a message into the parent conversation so we have a parentMessageId
    const msgPostResult = await fetch(
      `${WEBAPP}/api/v1/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Anchor message' }),
      },
    );
    expect(msgPostResult.status).toBe(201);
    const anchorMsg = await msgPostResult.json();
    const anchorId = anchorMsg.message.id;

    // 8. create_thread off the anchor message (with firstMessage)
    const threadResult = await registry.callTool(
      'create_thread',
      {
        conversationId,
        parentMessageId: anchorId,
        firstMessage: 'Branching off here.',
      },
      ctx,
    );
    expect(threadResult.isError).toBeFalsy();
    const thread = JSON.parse(threadResult.content[0].text);
    expect(thread.threadId).toMatch(/^thread_/);

    // 9. list_threads now has 1 entry
    const threadsAfter = await registry.callTool(
      'list_threads',
      { conversationId },
      ctx,
    );
    expect(threadsAfter.isError).toBeFalsy();
    const threadsList = JSON.parse(threadsAfter.content[0].text).threads;
    expect(threadsList).toHaveLength(1);
    expect(threadsList[0].threadId).toBe(thread.threadId);
    expect(threadsList[0].parentMessageId).toBe(anchorId);

    // 10. get_messages on the new thread surfaces the firstMessage
    const messagesResult = await registry.callTool(
      'get_messages',
      { conversationId: thread.threadId, limit: 10 },
      ctx,
    );
    expect(messagesResult.isError).toBeFalsy();
    const messagesBody = JSON.parse(messagesResult.content[0].text);
    expect(messagesBody.messages).toHaveLength(1);
    expect(messagesBody.messages[0].content).toBe('Branching off here.');
  });

  test('end-to-end: create_thread is idempotent for the same parent message', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Set up a parent conversation with a message
    const created = JSON.parse(
      (await registry.callTool('create_conversation', { title: 'P' }, ctx)).content[0].text,
    );
    const convId = created.conversationId;

    const msgResp = await fetch(`${WEBAPP}/api/v1/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'anchor' }),
    });
    const msgData = await msgResp.json();

    // Create thread twice — should return the same thread
    const t1 = JSON.parse(
      (await registry.callTool(
        'create_thread',
        { conversationId: convId, parentMessageId: msgData.message.id },
        ctx,
      )).content[0].text,
    );
    const t2 = JSON.parse(
      (await registry.callTool(
        'create_thread',
        { conversationId: convId, parentMessageId: msgData.message.id },
        ctx,
      )).content[0].text,
    );
    expect(t1.threadId).toBe(t2.threadId);
  });

  test('end-to-end: list_conversations and get_conversation reflect created docs', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Create three conversations
    const ids: string[] = [];
    for (const title of ['Alpha', 'Beta', 'Gamma']) {
      const r = await registry.callTool('create_conversation', { title }, ctx);
      ids.push(JSON.parse(r.content[0].text).conversationId);
    }

    // list_conversations
    const list = await registry.callTool('list_conversations', { limit: 50 }, ctx);
    const listBody = JSON.parse(list.content[0].text);
    expect(listBody.conversations.length).toBeGreaterThanOrEqual(3);
    expect(listBody.total).toBeGreaterThanOrEqual(3);

    // search filter (client-side)
    const filtered = await registry.callTool(
      'list_conversations',
      { search: 'beta' },
      ctx,
    );
    const filteredBody = JSON.parse(filtered.content[0].text);
    expect(filteredBody.conversations).toHaveLength(1);
    expect(filteredBody.conversations[0].title).toBe('Beta');

    // get_conversation includes messages when requested
    const gc = await registry.callTool(
      'get_conversation',
      { conversationId: ids[0], includeMessages: true },
      ctx,
    );
    const gcBody = JSON.parse(gc.content[0].text);
    expect(gcBody.conversation.id).toBe(ids[0]);
    expect(Array.isArray(gcBody.conversation.messages)).toBe(true);

    // get_conversation strips messages by default
    const gc2 = await registry.callTool(
      'get_conversation',
      { conversationId: ids[0] },
      ctx,
    );
    const gc2Body = JSON.parse(gc2.content[0].text);
    expect(gc2Body.conversation.messages).toBeUndefined();
  });

  test('end-to-end: delete_conversation archives by default, hard-deletes on archive=false', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    const a = JSON.parse(
      (await registry.callTool('create_conversation', { title: 'Doomed A' }, ctx))
        .content[0].text,
    );
    const b = JSON.parse(
      (await registry.callTool('create_conversation', { title: 'Doomed B' }, ctx))
        .content[0].text,
    );

    // Archive a (default)
    const archA = await registry.callTool(
      'delete_conversation',
      { conversationId: a.conversationId },
      ctx,
    );
    expect(JSON.parse(archA.content[0].text)).toEqual({
      ok: true,
      archived: true,
    });

    // Confirm archived: list with default (no archived) should not include it
    const listAfter = await registry.callTool('list_conversations', {}, ctx);
    const ids = JSON.parse(listAfter.content[0].text).conversations.map(
      (c: any) => c.id,
    );
    expect(ids).not.toContain(a.conversationId);

    // List with archived=true should include it
    const listArch = await registry.callTool(
      'list_conversations',
      { archived: true },
      ctx,
    );
    const archIds = JSON.parse(listArch.content[0].text).conversations.map(
      (c: any) => c.id,
    );
    expect(archIds).toContain(a.conversationId);

    // Hard-delete b
    const delB = await registry.callTool(
      'delete_conversation',
      { conversationId: b.conversationId, archive: false },
      ctx,
    );
    expect(JSON.parse(delB.content[0].text)).toEqual({
      ok: true,
      archived: false,
    });

    // get_conversation on b should now 404
    const gcB = await registry.callTool(
      'get_conversation',
      { conversationId: b.conversationId },
      ctx,
    );
    expect(gcB.isError).toBe(true);
    expect(JSON.parse(gcB.content[0].text).status).toBe(404);
  });

  test('end-to-end: get_conversation_summary returns cached null when nothing is generated', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    const created = JSON.parse(
      (await registry.callTool('create_conversation', { title: 'Sum' }, ctx)).content[0]
        .text,
    );
    const summary = await registry.callTool(
      'get_conversation_summary',
      { conversationId: created.conversationId },
      ctx,
    );
    expect(summary.isError).toBeFalsy();
    const body = JSON.parse(summary.content[0].text);
    expect(body.summary).toBeNull();
    expect(body.fromCache).toBe(true);
    expect(body.regenerated).toBe(false);
  });

  test('end-to-end: chain handles upstream error gracefully without crashing', async () => {
    const registry = getNativeRegistry();
    // Override fetch to fail every call with 500
    globalThis.fetch = vi.fn(async () =>
      new Response('boom', { status: 500, statusText: 'Internal Server Error' }),
    ) as unknown as typeof globalThis.fetch;

    const ctx = makeMockContext();
    const r = await registry.callTool('create_conversation', { title: 'X' }, ctx);
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.status).toBe(500);
  });
});
