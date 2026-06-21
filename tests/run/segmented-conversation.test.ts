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

describe('RunPublisher turn-by-turn segmentation', () => {
  const orig = process.env.SEGMENTED_CONVERSATION_GRAPHS;
  beforeEach(() => { process.env.ARCHIVE_QUEUE_DISABLED = 'true'; });
  afterEach(() => {
    if (orig === undefined) delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    else process.env.DISABLE_CONVERSATION_SEGMENTATION = orig;
    delete process.env.ARCHIVE_QUEUE_DISABLED;
    vi.restoreAllMocks();
  });

  it('opens a new message per kind change; first turn reuses the base id (ON by default for any conversation)', async () => {
    delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-seg', userId: 'u1', agentId: 'agent-x' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');

    await p.thinkingChunk('reasoning');               // turn 0 (thinking) → reuses msg_base
    await p.chunk('answer');                           // thinking → content → new segment
    await p.toolStart('t1', 'ssh_shell', 'remote');    // content → tool → new segment
    await p.chunk('more');                             // tool → content → new segment

    const ms = starts(convPublished);
    expect(ms.map((m) => m.messageId)).toEqual(['msg_base-s1', 'msg_base-s2', 'msg_base-s3']);
    expect(ms.map((m) => m.metadata.kind)).toEqual(['content', 'tool', 'content']);
    expect(ms.map((m) => m.metadata.segmentIndex)).toEqual([1, 2, 3]);
    expect(ms.every((m) => m.metadata.runId === 'run-seg' && m.metadata.agentId === 'agent-x')).toBe(true);
  });

  it('a single-turn graph (content only) still produces exactly one message', async () => {
    delete process.env.DISABLE_CONVERSATION_SEGMENTATION;
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-seg2', userId: 'u1' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');
    await p.chunk('a'); await p.chunk('b'); await p.chunk('c');   // all one content turn (reuses base)
    expect(starts(convPublished)).toEqual([]);
  });

  it('global kill-switch DISABLE_CONVERSATION_SEGMENTATION=1 falls back to single message', async () => {
    process.env.DISABLE_CONVERSATION_SEGMENTATION = '1';
    const { redis, convPublished } = makeRedis();
    const p = new RunPublisher({ redis, runId: 'run-plain', userId: 'u1' });
    await p.init('any-graph', 'Any', {}, 'conv-1', undefined, 'msg_base');
    await p.thinkingChunk('reasoning');
    await p.chunk('answer');
    await p.toolStart('t1', 'ssh_shell', 'remote');
    await p.chunk('more');
    expect(starts(convPublished)).toEqual([]);
  });
});
