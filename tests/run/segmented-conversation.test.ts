import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunPublisher } from '../../src/lib/run/run-publisher';

/** Mock redis that captures conversation pub/sub events (ConversationPublisher
 *  uses redis.publish/rpush/expire directly). */
function makeRedis() {
  const values = new Map<string, string>();
  const convPublished: any[] = [];
  const redis: any = {
    get: vi.fn(async (k: string) => values.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { values.set(k, v); return 'OK'; }),
    publish: vi.fn(async (_channel: string, message: string) => { convPublished.push(JSON.parse(message)); return 1; }),
    rpush: vi.fn(async () => 1),
    expire: vi.fn(async () => 1),
    pipeline: vi.fn(() => {
      const ops: Array<() => void> = [];
      const p: any = {
        rpush: () => p,
        expire: () => p,
        publish: (_c: string, m: string) => { ops.push(() => convPublished.push(JSON.parse(m))); return p; },
        exec: async () => { ops.forEach((o) => o()); return []; },
      };
      return p;
    }),
  };
  return { redis, convPublished };
}

const starts = (events: any[]) => events.filter((e) => e.type === 'message_start');
const presence = (events: any[]) => events.filter((e) => e.type === 'agent_presence');

describe('RunPublisher turn-by-turn segmentation', () => {
  const orig = process.env.DISABLE_CONVERSATION_SEGMENTATION;
  beforeEach(() => { process.env.ARCHIVE_QUEUE_DISABLED = 'true'; });
  afterEach(() => {
    if (orig === undefined) delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    else process.env.DISABLE_CONVERSATION_SEGMENTATION = orig;
    delete process.env.ARCHIVE_QUEUE_DISABLED;
    vi.restoreAllMocks();
  });

  it('emits a message_start per turn (first turn = base id) + presence working on init', async () => {
    delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-seg', userId: 'u1', agentId: 'agent-x' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');

    // Presence "working" fires on init (decoupled from any message).
    expect(presence(convPublished).map((e) => e.state)).toEqual(['working']);
    expect(presence(convPublished)[0]).toMatchObject({ runId: 'run-seg', agentId: 'agent-x' });

    await p.thinkingChunk('reasoning');               // turn 0 (thinking) → message_start(base)
    await p.chunk('answer');                           // thinking → content → new turn
    await p.toolStart('t1', 'ssh_shell', 'remote');    // content → tool → new turn
    await p.chunk('more');                             // tool → content → new turn

    const ms = starts(convPublished);
    expect(ms.map((m) => m.messageId)).toEqual(['msg_base', 'msg_base-s1', 'msg_base-s2', 'msg_base-s3']);
    expect(ms.map((m) => m.metadata.kind)).toEqual(['thinking', 'content', 'tool', 'content']);
    expect(ms.map((m) => m.metadata.segmentIndex)).toEqual([0, 1, 2, 3]);
    expect(ms.every((m) => m.metadata.runId === 'run-seg' && m.metadata.agentId === 'agent-x')).toBe(true);
  });

  it('a single-turn graph (content only) produces exactly one message_start', async () => {
    delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-seg2', userId: 'u1' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');
    await p.chunk('a'); await p.chunk('b'); await p.chunk('c');   // one content turn → message_start(base)
    expect(starts(convPublished).map((m) => m.messageId)).toEqual(['msg_base']);
  });

  it('segmentation is unconditional — there is no env switch to disable it', async () => {
    // Even with the (removed) kill-switch env set, segmentation stays ON.
    process.env.DISABLE_CONVERSATION_SEGMENTATION = '1';
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-plain', userId: 'u1' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');
    await p.thinkingChunk('reasoning');
    await p.chunk('answer');
    expect(starts(convPublished).map((m) => m.messageId)).toEqual(['msg_base', 'msg_base-s1']);
  });
});
