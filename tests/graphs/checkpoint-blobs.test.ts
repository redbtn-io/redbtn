import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  BLOB_MARKER_KEY,
  ESCAPE_KEY,
  externalizeBlobs,
  rehydrateBlobs,
  sha256Hex,
  type BlobStore,
} from '../../src/lib/graphs/checkpointBlobs';

class MemStore implements BlobStore {
  data = new Map<string, Buffer>();
  puts = 0;
  async put(id: string, data: Buffer) {
    this.puts++;
    this.data.set(id, Buffer.from(data));
  }
  async get(id: string) {
    return this.data.get(id) ?? null;
  }
}

const MIN = 1000;
const big = (ch: string, n = 5000) => ch.repeat(n);
const roundTripJson = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('externalizeBlobs / rehydrateBlobs', () => {
  test('stores large strings, keeps small ones, and restores byte-identical state', async () => {
    const store = new MemStore();
    const audio = big('A') + 'é漢🎵' + big('B');
    const state = {
      data: { audioBase64: audio, title: 'Briefing', n: 3, ok: true, none: null },
      list: [audio, 'small', { image: big('C') }],
    };
    const before = JSON.stringify(state);

    const { value, blobs } = await externalizeBlobs(state, store, MIN);
    expect(blobs).toBe(2); // audio stored once even though it appears twice
    expect(store.puts).toBe(2);
    expect(JSON.stringify(state)).toBe(before); // input never mutated
    const stored = JSON.stringify(value);
    expect(stored.length).toBeLessThan(1000);
    expect((value as any).data.title).toBe('Briefing');
    expect((value as any).data.audioBase64[BLOB_MARKER_KEY]).toBe(1);

    const restored = await rehydrateBlobs(roundTripJson(value), store);
    expect(restored).toEqual(state);
    expect((restored as any).data.audioBase64).toBe(audio);
  });

  test('shares untouched subtrees and returns the same object when nothing is large', async () => {
    const store = new MemStore();
    const untouched = { a: 1, b: ['x'] };
    const state = { untouched, big: big('Z') };
    const { value } = await externalizeBlobs(state, store, MIN);
    expect((value as any).untouched).toBe(untouched);

    const small = { a: 'hi', nested: { b: [1, 2] } };
    const out = await externalizeBlobs(small, store, MIN);
    expect(out.value).toBe(small);
    expect(out.blobs).toBe(0);
  });

  test('threshold is measured in UTF-8 bytes', async () => {
    const store = new MemStore();
    const multibyte = '漢'.repeat(400); // 400 chars, 1200 bytes
    const { blobs } = await externalizeBlobs({ s: multibyte }, store, MIN);
    expect(blobs).toBe(1);
  });

  test('graph data that looks like a marker survives the round trip unchanged', async () => {
    const store = new MemStore();
    const fake = { [BLOB_MARKER_KEY]: 1, id: 'a'.repeat(64), bytes: 5 };
    const fakeEscape = { [ESCAPE_KEY]: { hello: 'world' } };
    // A marker-looking object that also holds a real large payload.
    const fakeWithPayload = { [BLOB_MARKER_KEY]: 1, id: 'b'.repeat(64), bytes: 1, body: big('P') };
    const state = { fake, fakeEscape, fakeWithPayload, real: big('R') };
    const { value } = await externalizeBlobs(state, store, MIN);
    const restored = await rehydrateBlobs(roundTripJson(value), store);
    expect(restored).toEqual(state);
  });

  test('class instances are left as they are', async () => {
    class Msg {
      constructor(public content: string) {}
    }
    const store = new MemStore();
    const msg = new Msg(big('M'));
    const { value, blobs } = await externalizeBlobs({ messages: [msg] }, store, MIN);
    expect(blobs).toBe(0);
    expect((value as any).messages[0]).toBe(msg);
  });

  test('cycles do not hang', async () => {
    const store = new MemStore();
    const a: any = { payload: big('Y') };
    a.self = a;
    const { blobs } = await externalizeBlobs(a, store, MIN);
    expect(blobs).toBe(1);
  });

  test('a missing or corrupted blob fails loudly instead of handing back a hole', async () => {
    const store = new MemStore();
    const { value } = await externalizeBlobs({ s: big('Q') }, store, MIN);
    const stored = roundTripJson(value);
    const id = stored.s.id;

    store.data.set(id, Buffer.from('tampered'));
    await expect(rehydrateBlobs(roundTripJson(value), store)).rejects.toThrow(/integrity/);

    store.data.delete(id);
    await expect(rehydrateBlobs(roundTripJson(value), store)).rejects.toThrow(/missing/);
  });

  test('a failing store rejects so the caller can fall back to inline', async () => {
    const store: BlobStore = {
      put: async () => {
        throw new Error('mongo down');
      },
      get: async () => null,
    };
    await expect(externalizeBlobs({ s: big('F') }, store, MIN)).rejects.toThrow('mongo down');
  });

  test('ids are sha256 of the UTF-8 bytes', async () => {
    const store = new MemStore();
    const s = big('H');
    const { value } = await externalizeBlobs({ s }, store, MIN);
    expect((value as any).s.id).toBe(sha256Hex(Buffer.from(s, 'utf8')));
  });
});

describe('MongoCheckpointer with blob offload', () => {
  const docs: any[] = [];
  const writes: any[] = [];
  const config = {
    configurable: { conversation_id: 'c1', thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'p0' },
  };

  beforeEach(() => {
    docs.length = 0;
    writes.length = 0;
    process.env.CHECKPOINT_BLOB_MIN_BYTES = String(MIN);
    (mongoose.models as any).GraphCheckpoint = {
      findOneAndUpdate: async (_q: any, update: any) => {
        docs.push(update.$set);
        return {};
      },
      findOne: () => ({
        sort: () => ({ lean: async () => docs[docs.length - 1] }),
        lean: async () => docs[docs.length - 1],
      }),
    };
    (mongoose.models as any).GraphCheckpointWrite = {
      findOneAndUpdate: async (_q: any, update: any) => {
        writes.push(update.$setOnInsert);
        return {};
      },
      find: () => ({ lean: async () => writes }),
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete (mongoose.models as any).GraphCheckpoint;
    delete (mongoose.models as any).GraphCheckpointWrite;
    delete process.env.CHECKPOINT_BLOB_MIN_BYTES;
    delete process.env.CHECKPOINT_BLOBS;
    vi.restoreAllMocks();
  });

  async function saver(store: BlobStore) {
    const { MongoCheckpointer } = await import('../../src/lib/graphs/MongoCheckpointer');
    return new MongoCheckpointer(undefined, store);
  }

  const audio = big('V', 200_000);
  const checkpoint = () => ({
    v: 1,
    id: 'cp1',
    ts: new Date().toISOString(),
    channel_values: { data: { audioBase64: audio, text: 'hello' } },
    channel_versions: { data: 1 },
    versions_seen: { node: { data: 1 } },
    pending_sends: [],
  });

  test('stores the payload once, writes a small checkpoint, and loads it back identical', async () => {
    const store = new MemStore();
    const s = await saver(store);
    const cp = checkpoint();
    await s.put(config, cp, { source: 'loop', step: 1 });
    await s.put(config, { ...cp, id: 'cp2' }, { source: 'loop', step: 2 });
    await s.putWrites({ configurable: { ...config.configurable, checkpoint_id: 'cp2' } }, [['data', { audioBase64: audio }]], 'task1');

    expect(store.data.size).toBe(1);
    expect(docs[1].checkpoint.length).toBeLessThan(5000);
    expect(writes[0].value.length).toBeLessThan(5000);
    expect(cp.channel_values.data.audioBase64).toBe(audio); // live state untouched

    const tuple = await s.getTuple({ configurable: { conversation_id: 'c1', thread_id: 't1' } });
    expect(tuple.checkpoint.channel_values.data.audioBase64).toBe(audio);
    expect(tuple.checkpoint.channel_values.data.text).toBe('hello');
    expect(tuple.pendingWrites[0][2].audioBase64).toBe(audio);
  });

  test('CHECKPOINT_BLOBS=off writes everything inline', async () => {
    process.env.CHECKPOINT_BLOBS = 'off';
    const store = new MemStore();
    const s = await saver(store);
    await s.put(config, checkpoint(), {});
    expect(store.data.size).toBe(0);
    expect(docs[0].checkpoint.length).toBeGreaterThan(200_000);
  });

  test('if the blob store fails the checkpoint is written inline, never lost', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store: BlobStore = {
      put: async () => {
        throw new Error('store down');
      },
      get: async () => null,
    };
    const s = await saver(store);
    await s.put(config, checkpoint(), {});
    expect(docs).toHaveLength(1);
    expect(docs[0].checkpoint.length).toBeGreaterThan(200_000);
  });

  test('a checkpoint whose blob is gone is not handed to the graph', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = new MemStore();
    const s = await saver(store);
    await s.put(config, checkpoint(), {});
    store.data.clear();
    const tuple = await s.getTuple({ configurable: { conversation_id: 'c1', thread_id: 't1' } });
    expect(tuple).toBeUndefined();
  });
});

describe('crash-resume through a real LangGraph graph', () => {
  // Minimal in-memory stand-ins for the two mongoose models, enough for
  // LangGraph's put / putWrites / getTuple calls.
  function memModels() {
    const cps: any[] = [];
    const wr: any[] = [];
    const match = (d: any, q: any) => Object.entries(q).every(([k, v]) => d[k] === v);
    (mongoose.models as any).GraphCheckpoint = {
      findOneAndUpdate: async (q: any, u: any) => {
        const i = cps.findIndex((d) => match(d, q));
        if (i >= 0) cps[i] = { ...cps[i], ...u.$set };
        else cps.push({ ...u.$set });
        return {};
      },
      findOne: (q: any) => {
        const hits = () => cps.filter((d) => match(d, q)).sort((a, b) => (a.checkpointId < b.checkpointId ? 1 : -1));
        return { sort: () => ({ lean: async () => hits()[0] }), lean: async () => hits()[0] };
      },
    };
    (mongoose.models as any).GraphCheckpointWrite = {
      findOneAndUpdate: async (q: any, u: any) => {
        if (!wr.some((d) => match(d, q))) wr.push({ ...u.$setOnInsert });
        return {};
      },
      find: (q: any) => ({ lean: async () => wr.filter((d) => match(d, q)) }),
    };
    return { cps, wr };
  }

  afterEach(() => {
    delete (mongoose.models as any).GraphCheckpoint;
    delete (mongoose.models as any).GraphCheckpointWrite;
    delete process.env.CHECKPOINT_BLOB_MIN_BYTES;
    vi.restoreAllMocks();
  });

  test('a step after resume receives the exact payload, not a reference', async () => {
    process.env.CHECKPOINT_BLOB_MIN_BYTES = '1000';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { StateGraph, Annotation, START, END } = await import('@langchain/langgraph');
    const { MongoCheckpointer } = await import('../../src/lib/graphs/MongoCheckpointer');
    const { cps } = memModels();
    const store = new MemStore();
    const saver = new MongoCheckpointer(undefined, store);

    const audio = 'UklGR' + 'x'.repeat(300_000);
    let crash = true;
    let seen: unknown;
    const S = Annotation.Root({ data: Annotation<any>({ reducer: (_a: any, b: any) => b, default: () => ({}) }) });
    const graph = new StateGraph(S)
      .addNode('speak', async () => ({ data: { audioBase64: audio, text: 'hi' } }))
      .addNode('post', async (s: any) => {
        if (crash) throw new Error('worker died');
        seen = s.data.audioBase64;
        return { data: { ...s.data, posted: true } };
      })
      .addEdge(START, 'speak')
      .addEdge('speak', 'post')
      .addEdge('post', END)
      .compile({ checkpointer: saver as any });

    const cfg = { configurable: { thread_id: 'run-1', conversation_id: 'conv-1' } };
    await expect(graph.invoke({ data: {} }, cfg)).rejects.toThrow('worker died');

    // Everything persisted is small; the payload lives in the blob store once.
    expect(store.data.size).toBe(1);
    for (const d of cps) expect(d.checkpoint.length).toBeLessThan(20_000);

    crash = false;
    const out: any = await graph.invoke(null, cfg);
    expect(seen).toBe(audio);
    expect(out.data.audioBase64).toBe(audio);
    expect(out.data.posted).toBe(true);
  });
});
