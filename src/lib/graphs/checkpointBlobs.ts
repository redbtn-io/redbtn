/**
 * Checkpoint blob offload.
 *
 * Graph state can carry big payloads: base64 audio from speech synthesis,
 * chart images, documents, video. MongoCheckpointer used to write the whole
 * state, payloads included, after EVERY node. A 5MB clip held for ten nodes
 * meant ~50MB of checkpoint writes, and anything past ~14MB was skipped
 * entirely (no crash-resume for that run).
 *
 * This module only changes what is STORED, never what a graph sees:
 *
 *   - `externalizeBlobs()` runs on the copy about to be serialized. Every
 *     string at or above the size threshold is stored once, content-addressed
 *     by sha256, and replaced in the STORED copy by a small marker. The live
 *     state the graph is running on is never touched.
 *   - `rehydrateBlobs()` runs on every checkpoint load and puts the exact
 *     original strings back before LangGraph sees the state. A resumed run
 *     gets byte-identical data.
 *
 * Because the store is content-addressed, a payload that stays in state across
 * many nodes is written once; later checkpoints just reference it.
 *
 * Only plain objects and arrays are walked. Class instances (LangChain
 * messages and the like) are left exactly as they are so their serialization
 * is unchanged.
 *
 * Env:
 *   CHECKPOINT_BLOBS=off            disable (store everything inline, old behaviour)
 *   CHECKPOINT_BLOB_MIN_BYTES=n     size threshold in UTF-8 bytes (default 256KB)
 */

import { createHash } from 'crypto';

/** Key that marks a stored-blob reference inside a serialized checkpoint. */
export const BLOB_MARKER_KEY = '__redbtnCheckpointBlob';
/**
 * Key used to wrap a user object that happens to contain BLOB_MARKER_KEY, so
 * graph data can never be mistaken for a marker on load.
 */
export const ESCAPE_KEY = '__redbtnCheckpointEscaped';

export interface BlobMarker {
  [BLOB_MARKER_KEY]: 1;
  id: string;
  bytes: number;
}

export interface BlobStore {
  /** Persist `data` under `id` (sha256 hex). Must be idempotent. */
  put(id: string, data: Buffer): Promise<void>;
  /** Return the bytes stored under `id`, or null when missing. */
  get(id: string): Promise<Buffer | null>;
}

export function checkpointBlobsEnabled(): boolean {
  const v = (process.env.CHECKPOINT_BLOBS ?? '').trim().toLowerCase();
  return !(v === 'off' || v === 'false' || v === '0' || v === 'disabled');
}

export function blobMinBytes(): number {
  const raw = Number(process.env.CHECKPOINT_BLOB_MIN_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 256 * 1024;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function isMarker(v: unknown): v is BlobMarker {
  return (
    isPlainObject(v) &&
    v[BLOB_MARKER_KEY] === 1 &&
    typeof v.id === 'string' &&
    /^[0-9a-f]{64}$/.test(v.id)
  );
}

function isEscaped(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && Object.keys(v).length === 1 && Object.prototype.hasOwnProperty.call(v, ESCAPE_KEY);
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Return a copy of `value` in which every large string is replaced by a blob
 * marker, storing each distinct payload once in `store`. Unchanged subtrees
 * are shared with the input, and the input is never mutated.
 *
 * Throws if the store fails, so the caller can fall back to inline storage.
 */
export async function externalizeBlobs(
  value: unknown,
  store: BlobStore,
  minBytes: number = blobMinBytes(),
): Promise<{ value: unknown; blobs: number; bytes: number }> {
  // Quick pre-check on string length: UTF-8 bytes >= UTF-16 code units, so a
  // string shorter than minBytes/3 code units can never reach the threshold.
  const minChars = Math.max(1, Math.floor(minBytes / 3));
  const pending = new Map<string, Promise<void>>();
  const memo = new WeakMap<object, unknown>();
  let blobs = 0;
  let bytes = 0;

  const visit = (v: unknown): unknown => {
    if (typeof v === 'string') {
      if (v.length < minChars) return v;
      const buf = Buffer.from(v, 'utf8');
      if (buf.length < minBytes) return v;
      const id = sha256Hex(buf);
      if (!pending.has(id)) {
        pending.set(id, store.put(id, buf));
        blobs++;
        bytes += buf.length;
      }
      const marker: BlobMarker = { [BLOB_MARKER_KEY]: 1, id, bytes: buf.length };
      return marker;
    }
    if (v === null || typeof v !== 'object') return v;
    if (memo.has(v)) return memo.get(v);

    if (Array.isArray(v)) {
      // Seed the memo so a cycle resolves to the input (the serializer
      // handles cycles exactly as it did before).
      memo.set(v, v);
      let out: unknown[] | null = null;
      for (let i = 0; i < v.length; i++) {
        const nv = visit(v[i]);
        if (nv !== v[i] && out === null) out = v.slice(0, i);
        if (out !== null) out.push(nv);
      }
      const result = out ?? v;
      memo.set(v, result);
      return result;
    }

    if (!isPlainObject(v)) return v;

    memo.set(v, v);
    let out: Record<string, unknown> | null = null;
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const cur = v[k];
      const nv = visit(cur);
      if (nv !== cur && out === null) {
        out = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
        for (let j = 0; j < i; j++) out![keys[j]] = v[keys[j]];
      }
      if (out !== null) out[k] = nv;
    }
    let result: unknown = out ?? v;
    // Graph data that itself looks like a marker or an escape wrapper gets
    // wrapped, so rehydrate can tell it apart from a real reference.
    if (Object.prototype.hasOwnProperty.call(v, BLOB_MARKER_KEY) || isEscaped(v)) {
      result = { [ESCAPE_KEY]: result };
    }
    memo.set(v, result);
    return result;
  };

  const outValue = visit(value);
  await Promise.all(pending.values());
  return { value: outValue, blobs, bytes };
}

/**
 * Return `value` with every blob marker replaced by the original string.
 * Throws if a referenced blob is missing or corrupt: a checkpoint with a
 * hole in it must not be handed to a graph as if it were complete.
 */
export async function rehydrateBlobs(value: unknown, store: BlobStore): Promise<unknown> {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  // `literal` = this object is escaped graph data, so never read it as a marker
  // or an escape wrapper itself (its children are still walked normally).
  const collect = (v: unknown, literal = false): void => {
    if (v === null || typeof v !== 'object') return;
    if (seen.has(v)) return;
    seen.add(v);
    if (!literal && isMarker(v)) {
      ids.add(v.id);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) collect(x);
      return;
    }
    if (!isPlainObject(v)) return;
    if (!literal && isEscaped(v)) {
      collect(v[ESCAPE_KEY], true);
      return;
    }
    for (const k of Object.keys(v)) collect(v[k]);
  };
  collect(value);

  const strings = new Map<string, string>();
  await Promise.all(
    [...ids].map(async (id) => {
      const data = await store.get(id);
      if (!data) throw new Error(`checkpoint blob ${id} is missing`);
      if (sha256Hex(data) !== id) throw new Error(`checkpoint blob ${id} failed its integrity check`);
      strings.set(id, data.toString('utf8'));
    }),
  );

  const memo = new WeakMap<object, unknown>();
  const restore = (v: unknown, literal = false): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (memo.has(v)) return memo.get(v);
    if (!literal && isMarker(v)) return strings.get(v.id)!;
    if (Array.isArray(v)) {
      memo.set(v, v);
      for (let i = 0; i < v.length; i++) v[i] = restore(v[i]);
      return v;
    }
    if (!isPlainObject(v)) return v;
    if (!literal && isEscaped(v)) {
      const inner = restore(v[ESCAPE_KEY], true);
      memo.set(v, inner);
      return inner;
    }
    memo.set(v, v);
    for (const k of Object.keys(v)) v[k] = restore(v[k]);
    return v;
  };
  // Freshly deserialized values are owned by the caller, so restoring in
  // place is safe and avoids copying large trees.
  return restore(value);
}

// ============================================================================
// Mongo-backed store
// ============================================================================

const CHUNK_BYTES = 8 * 1024 * 1024;
// Checkpoints expire after 7 days; blobs live a day longer and have their
// clock reset whenever a new checkpoint references them.
const BLOB_TTL_SECONDS = 8 * 24 * 60 * 60;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000;

function getBlobModel(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
  if (mongoose.models.GraphCheckpointBlob) return mongoose.models.GraphCheckpointBlob;
  const schema = new mongoose.Schema(
    {
      _id: { type: String },
      blobId: { type: String, required: true, index: true },
      idx: { type: Number, required: true },
      total: { type: Number, required: true },
      bytes: { type: Number, required: true },
      data: { type: Buffer, required: true },
      createdAt: { type: Date, default: Date.now, expires: BLOB_TTL_SECONDS },
    },
    { collection: 'graphcheckpointblobs' },
  );
  return mongoose.model('GraphCheckpointBlob', schema);
}

/** Small LRU of recently read blobs, bounded by total bytes. */
class ByteLru {
  private map = new Map<string, Buffer>();
  private total = 0;
  constructor(private readonly maxBytes: number) {}
  get(id: string): Buffer | undefined {
    const v = this.map.get(id);
    if (v) {
      this.map.delete(id);
      this.map.set(id, v);
    }
    return v;
  }
  set(id: string, data: Buffer): void {
    if (data.length > this.maxBytes) return;
    if (this.map.has(id)) {
      this.total -= this.map.get(id)!.length;
      this.map.delete(id);
    }
    this.map.set(id, data);
    this.total += data.length;
    while (this.total > this.maxBytes) {
      const oldest = this.map.keys().next().value as string;
      this.total -= this.map.get(oldest)!.length;
      this.map.delete(oldest);
    }
  }
}

export class MongoBlobStore implements BlobStore {
  /** id -> last time this process wrote or touched it. */
  private known = new Map<string, number>();
  private cache = new ByteLru(64 * 1024 * 1024);

  async put(id: string, data: Buffer): Promise<void> {
    const now = Date.now();
    const last = this.known.get(id);
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return;
    const Model = getBlobModel();
    const total = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
    const existing = await Model.countDocuments({ blobId: id });
    if (existing === total) {
      await Model.updateMany({ blobId: id }, { $set: { createdAt: new Date() } });
    } else {
      for (let i = 0; i < total; i++) {
        const chunk = data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        await Model.updateOne(
          { _id: `${id}:${i}` },
          {
            $set: { createdAt: new Date() },
            $setOnInsert: { blobId: id, idx: i, total, bytes: data.length, data: chunk },
          },
          { upsert: true },
        );
      }
    }
    this.known.set(id, now);
    if (this.known.size > 10_000) this.known.delete(this.known.keys().next().value as string);
    this.cache.set(id, data);
  }

  async get(id: string): Promise<Buffer | null> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const Model = getBlobModel();
    const docs = await Model.find({ blobId: id }).sort({ idx: 1 }).lean();
    if (!docs.length || docs.length !== docs[0].total) return null;
    const data = Buffer.concat(docs.map((d: any) => toBuffer(d.data)));
    this.cache.set(id, data);
    return data;
  }
}

function toBuffer(v: any): Buffer {
  if (Buffer.isBuffer(v)) return v;
  // mongodb Binary from .lean(): value() returns exactly the written bytes
  // (the backing .buffer can be larger than .position).
  if (v && typeof v === 'object' && typeof v.value === 'function') return Buffer.from(v.value());
  if (v && typeof v === 'object' && v.buffer) {
    const b: Uint8Array = v.buffer;
    return Buffer.from(typeof v.position === 'number' ? b.subarray(0, v.position) : b);
  }
  return Buffer.from(v);
}

let _defaultStore: MongoBlobStore | null = null;
export function defaultBlobStore(): BlobStore {
  if (!_defaultStore) _defaultStore = new MongoBlobStore();
  return _defaultStore;
}
