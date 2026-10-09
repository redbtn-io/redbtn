/**
 * Regression tests for the 2026-10-09 conversation-less run incident.
 *
 * Scheduled automation runs have no conversation: the system `context` node
 * called `get_context_history` with `conversationId` rendered to JS
 * `undefined`, which then (a) matched an arbitrary `user_conversations` doc
 * via `{ conversationId: undefined }` → null, and (b) read/wrote Redis keys
 * `conversations:undefined:*`.
 *
 * These tests pin the guards: unusable ids are refused BEFORE any Redis key
 * is built or any Mongo filter is issued; `get_context_history` instead
 * returns a successful empty context so automation runs continue normally.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const mocks = vi.hoisted(() => ({
  findOne: vi.fn(async () => null),
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
          if (name === 'user_conversations') return { findOne: mocks.findOne };
          return { findOne: vi.fn(async () => null) };
        },
      },
    },
  };
  return { default: fake, ...fake };
});

// Tools reach MemoryManager only after validation + access checks.
// Stub it so refusal tests prove storage was never touched.
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

import {
  InvalidConversationIdError,
  assertUsableConversationId,
  isUsableConversationId,
} from '../../src/lib/conversation/conversation-id';
import { ConversationKeys } from '../../src/lib/conversation/types';
import { ConversationPublisher } from '../../src/lib/conversation/conversation-publisher';
import { RunKeys } from '../../src/lib/run/types';
import { RunLock } from '../../src/lib/run/run-lock';
import {
  checkConversationAccess,
} from '../../src/lib/tools/native/_conversation-access';
import { resolveScopeNamespace } from '../../src/lib/tools/native/_task-helpers';
import { getDataToolRule } from '../../src/lib/permissions/tool-map';
import storeMessageTool from '../../src/lib/tools/native/store-message';
import getContextTool from '../../src/lib/tools/native/get-context';
import getMessagesTool from '../../src/lib/tools/native/get-messages';
import getConversationTool from '../../src/lib/tools/native/get-conversation';
import pushMessageTool from '../../src/lib/tools/native/push-message';

const VALID_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BAD_IDS: Array<{ label: string; value: unknown }> = [
  { label: 'undefined', value: undefined },
  { label: 'null', value: null },
  { label: 'empty string', value: '' },
  { label: 'whitespace', value: '   ' },
  { label: '"undefined" string', value: 'undefined' },
  { label: '"UNDEFINED" string', value: 'UNDEFINED' },
  { label: '"null" string', value: 'null' },
  { label: '"NaN" string', value: 'NaN' },
  { label: 'unrendered template', value: '{{state.data.options.conversationId}}' },
  { label: 'number', value: 12345 },
];

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'some-user' },
    runId: 'test-run',
    nodeId: 'test-node',
    toolId: 'test-tool',
    abortSignal: null,
    ...overrides,
  };
}

describe('isUsableConversationId', () => {
  test('accepts real ids', () => {
    expect(isUsableConversationId(VALID_ID)).toBe(true);
    expect(isUsableConversationId('conv_abc123def456')).toBe(true);
    expect(isUsableConversationId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  test.each(BAD_IDS)('rejects $label', ({ value }) => {
    expect(isUsableConversationId(value)).toBe(false);
  });

  test('rejects over-long and whitespace-containing ids', () => {
    expect(isUsableConversationId('a'.repeat(129))).toBe(false);
    expect(isUsableConversationId('abc def')).toBe(false);
  });

  test('assertUsableConversationId throws a typed error', () => {
    for (const { value } of BAD_IDS) {
      let err: unknown = null;
      try {
        assertUsableConversationId(value, 'test-context');
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InvalidConversationIdError);
      expect((err as InvalidConversationIdError).code).toBe('INVALID_CONVERSATION_ID');
    }
  });
});

describe('Redis key builders never emit undefined keys', () => {
  test.each(BAD_IDS)('ConversationKeys.stream refuses $label', ({ value }) => {
    expect(() => ConversationKeys.stream(value as string)).toThrow(InvalidConversationIdError);
  });

  test.each(BAD_IDS)('ConversationKeys.events refuses $label', ({ value }) => {
    expect(() => ConversationKeys.events(value as string)).toThrow(InvalidConversationIdError);
  });

  test.each(BAD_IDS)('RunKeys.lock refuses $label', ({ value }) => {
    expect(() => RunKeys.lock(value as string)).toThrow(InvalidConversationIdError);
  });

  test.each(BAD_IDS)('RunKeys.conversationRun refuses $label', ({ value }) => {
    expect(() => RunKeys.conversationRun(value as string)).toThrow(InvalidConversationIdError);
  });

  test('ConversationPublisher constructor refuses unusable ids', () => {
    expect(
      () =>
        new ConversationPublisher({ redis: {} as never, conversationId: undefined as never }),
    ).toThrow(InvalidConversationIdError);
    expect(
      () =>
        new ConversationPublisher({ redis: {} as never, conversationId: 'undefined' }),
    ).toThrow(InvalidConversationIdError);
  });

  test('RunLock.acquire refuses unusable ids without touching Redis', async () => {
    const redis = { set: vi.fn() };
    const lock = new RunLock(redis as never);
    await expect(lock.acquire(undefined as never)).rejects.toThrow(InvalidConversationIdError);
    expect(redis.set).not.toHaveBeenCalled();
  });
});

describe('checkConversationAccess refuses without querying', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test.each(BAD_IDS)('refuses $label', async ({ value }) => {
    const r = await checkConversationAccess(value as string, 'some-user');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid conversationId/);
    // No Mongo filter was ever issued.
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});

describe('get_context_history returns successful empty context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each(BAD_IDS)('empty success for $label (llm format)', async ({ value }) => {
    const r = await getContextTool.handler(
      { conversationId: value, format: 'llm' },
      // No userId at all: the no-conversation fast path must not require one.
      makeMockContext({ state: {} }),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.messages).toEqual([]);
    expect(body.metadata.noConversation).toBe(true);
    expect(memoryManagerMocks.getContextForConversation).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
  });

  test('empty success for raw and formatted variants', async () => {
    const raw = await getContextTool.handler(
      { conversationId: undefined, format: 'raw' },
      makeMockContext({ state: {} }),
    );
    expect(raw.isError).toBeFalsy();
    const rawBody = JSON.parse(raw.content[0].text);
    expect(rawBody.messages).toEqual([]);
    expect(rawBody.noConversation).toBe(true);

    const formatted = await getContextTool.handler(
      { conversationId: '{{state.data.options.conversationId}}', format: 'formatted' },
      makeMockContext({ state: {} }),
    );
    expect(formatted.isError).toBeFalsy();
    expect(formatted.content[0].text).toMatch(/no conversation/i);
  });
});

describe('store_message refuses without touching storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test.each(BAD_IDS)('refuses $label', async ({ value }) => {
    const r = await storeMessageTool.handler(
      { conversationId: value, role: 'user', content: 'hi' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION');
    expect(memoryManagerMocks.addMessage).not.toHaveBeenCalled();
    expect(mocks.findOne).not.toHaveBeenCalled();
  });
});

describe('proxy tools refuse unusable ids before any fetch', () => {
  test.each([
    ['get_messages', getMessagesTool],
    ['get_conversation', getConversationTool],
  ])('%s refuses "undefined" and undefined', async (_name, tool) => {
    for (const value of [undefined, 'undefined', '', '{{state.data.options.conversationId}}']) {
      const r = await tool.handler({ conversationId: value }, makeMockContext());
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.code).toBe('VALIDATION');
    }
  });

  test('push_message refuses unusable resolved ids', async () => {
    const r = await pushMessageTool.handler({ content: 'hi' }, makeMockContext({ state: {} }));
    expect(r.isError).toBe(true);
  });
});

describe('task scope + permission extractors', () => {
  test('conversation task scope refuses unusable ids', () => {
    const r = resolveScopeNamespace(
      'conversation',
      makeMockContext({ state: { conversationId: 'undefined' } }),
    );
    expect(r.ok).toBe(false);
  });

  test('permission extractor treats unusable ids as unscoped', () => {
    const rule = getDataToolRule('get_context_history');
    expect(rule).toBeDefined();
    expect(rule!.extract({ conversationId: undefined })).toEqual({
      addresses: [],
      unscoped: true,
    });
    expect(rule!.extract({ conversationId: 'undefined' })).toEqual({
      addresses: [],
      unscoped: true,
    });
    expect(rule!.extract({ conversationId: VALID_ID })).toEqual({
      addresses: [VALID_ID],
    });
  });
});
