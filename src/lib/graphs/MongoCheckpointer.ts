/**
 * MongoDB Checkpointer for LangGraph
 *
 * Persists graph state to MongoDB after every node completes.
 * On crash/retry, the graph resumes from the last completed checkpoint.
 *
 * Collection: graphcheckpoints
 * TTL: 7 days (auto-cleanup via MongoDB TTL index)
 *
 * Key design decisions:
 * - Uses the existing Mongoose connection (no new connection)
 * - thread_id = runId (each run has its own isolated checkpoint thread)
 * - Serializes checkpoint data using the langgraph-checkpoint JsonPlusSerializer
 * - Stores pending writes separately for full resume fidelity
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } = require('@langchain/langgraph-checkpoint');

// fast-safe-stringify's silent-fallback string. When the underlying JSON.stringify
// throws (typically on a BigInt), the serializer catches and writes this placeholder
// instead of the real checkpoint. The placeholder later deserializes to a string,
// which crashes LangGraph in `_first()` because `string.versions_seen` is undefined
// and `undefined['__input__']` throws. Detect it at write time so the next failure
// surfaces what was unserializable instead of silently corrupting checkpoints.
const FAST_SAFE_STRINGIFY_PLACEHOLDER = '[unable to serialize, circular reference is too complex to analyze]';

/**
 * Walk an arbitrary value and return the path + native-type of the first sub-value
 * that JSON.stringify cannot natively handle (BigInt, throwing getters, etc.).
 * Returns null if nothing pathological is found within MAX_DEPTH.
 */
function findUnserializableValue(root: any, maxDepth = 30): { path: string; reason: string } | null {
  const seen = new WeakSet<object>();
  const stack: Array<{ value: any; path: string; depth: number }> = [{ value: root, path: '$', depth: 0 }];
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop()!;
    if (depth > maxDepth) continue;
    const t = typeof value;
    if (t === 'bigint') return { path, reason: `BigInt(${value.toString()})` };
    if (t === 'symbol') return { path, reason: `Symbol(${(value as symbol).description ?? ''})` };
    if (value === null || t !== 'object') continue;
    if (seen.has(value)) continue;
    seen.add(value);
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch (e: any) {
      return { path, reason: `Object.keys threw: ${e?.message ?? String(e)}` };
    }
    for (const k of keys) {
      let v: any;
      try {
        v = value[k];
      } catch (e: any) {
        return { path: `${path}.${k}`, reason: `getter threw: ${e?.message ?? String(e)}` };
      }
      stack.push({ value: v, path: `${path}.${k}`, depth: depth + 1 });
    }
  }
  return null;
}

// One-line warn dedupe so we don't flood logs with the same offender on every
// checkpoint write within a single run.
const _warnedOffenders = new Set<string>();

function assertSerializationOk(label: string, source: any, bytes: Uint8Array): void {
  // The 69-byte placeholder (67 chars + two JSON quotes) is the canonical signal
  // of a silent JSON.stringify failure inside fast-safe-stringify.
  if (bytes.byteLength > 80) return;
  const decoded = Buffer.from(bytes).toString('utf8');
  if (!decoded.includes(FAST_SAFE_STRINGIFY_PLACEHOLDER)) return;
  const offender = findUnserializableValue(source);
  const detail = offender
    ? `${offender.path} (${offender.reason})`
    : 'no BigInt/throwing-getter found in walk — may be a deeper structural issue';
  const key = `${label}::${detail}`;
  if (_warnedOffenders.has(key)) return;
  _warnedOffenders.add(key);
  // LOG-ONLY. Throwing here cascades into the runPublisher pipeline and breaks
  // streaming output (this is what broke Discord on the 0.0.147-alpha deploy).
  // The read-side guard in getTuple() handles the silent corruption — this
  // branch just surfaces *what* is unserializable so we can coerce it at the
  // source. With the registry refactor (infra out of state) this branch
  // should no longer fire in practice — its presence is belt-and-suspenders.
  console.error(
    `[MongoCheckpointer] ${label} silently fell back to placeholder ` +
    `("${FAST_SAFE_STRINGIFY_PLACEHOLDER}"). ` +
    `Offending value: ${detail}. ` +
    `Coerce this value to a JSON-safe primitive before it enters graph state.`
  );
}

// Hard ceiling for a single serialized checkpoint / write value. Mongo rejects
// documents over 16MB, and the bson serializer's internal buffer (17,825,792
// bytes) throws ERR_OUT_OF_RANGE before that — which surfaced as an unhandled
// rejection that killed the whole worker process mid-run (2026-07-20, tpf-ai
// deep reports carrying ~6MB of TTS audio base64 in state). 14MB leaves room
// for the base64 inflation and the rest of the document around the payload.
const MAX_CHECKPOINT_BYTES = (() => {
  const raw = Number(process.env.CHECKPOINT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : 14 * 1024 * 1024;
})();

function oversized(label: string, threadId: string | undefined, bytes: number): boolean {
  if (bytes <= MAX_CHECKPOINT_BYTES) return false;
  console.error(
    `[MongoCheckpointer] ${label} skipped for thread ${threadId ?? 'unknown'}: ` +
    `serialized size ${bytes} exceeds ${MAX_CHECKPOINT_BYTES} bytes. ` +
    `The run continues WITHOUT this checkpoint (crash-resume falls back to the ` +
    `previous one). Shrink graph state — large blobs (audio/doc payloads) ` +
    `should be cleared from state once consumed.`
  );
  return true;
}

// ============================================================================
// MongoDB schema helpers (raw mongoose access, no model recompilation)
// ============================================================================

function getCheckpointModel(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
  if (mongoose.models.GraphCheckpoint) {
    return mongoose.models.GraphCheckpoint;
  }
  const schema = new mongoose.Schema({
    conversationId: { type: String, required: true, index: true },
    threadId: { type: String, required: true, index: true },
    checkpointNs: { type: String, default: '' },
    checkpointId: { type: String, required: true },
    parentCheckpointId: { type: String, default: null },
    checkpoint: { type: String, required: true },
    metadata: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
  }, { collection: 'graphcheckpoints' });
  schema.index({ conversationId: 1, threadId: 1, checkpointNs: 1, checkpointId: 1 }, { unique: true });
  return mongoose.model('GraphCheckpoint', schema);
}

function getWritesModel(): any {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mongoose = require('mongoose');
  if (mongoose.models.GraphCheckpointWrite) {
    return mongoose.models.GraphCheckpointWrite;
  }
  const schema = new mongoose.Schema({
    conversationId: { type: String, required: true, index: true },
    threadId: { type: String, required: true, index: true },
    checkpointNs: { type: String, default: '' },
    checkpointId: { type: String, required: true },
    taskId: { type: String, required: true },
    idx: { type: Number, required: true },
    channel: { type: String, required: true },
    value: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
  }, { collection: 'graphcheckpointwrites' });
  schema.index(
    { conversationId: 1, threadId: 1, checkpointNs: 1, checkpointId: 1, taskId: 1, idx: 1 },
    { unique: true }
  );
  return mongoose.model('GraphCheckpointWrite', schema);
}

// ============================================================================
// MongoCheckpointer class
// ============================================================================

export class MongoCheckpointer extends BaseCheckpointSaver {
  constructor(serde?: any) {
    super(serde);
  }

  private _getIds(config: any): { conversationId: string; threadId: string } {
    const threadId = config.configurable?.thread_id;
    // Fall back to thread_id for conversation_id if missing (legacy/flat chat support)
    const conversationId = config.configurable?.conversation_id || threadId;
    return { conversationId, threadId };
  }

  async getTuple(config: any): Promise<any> {
    const { conversationId, threadId } = this._getIds(config);
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = getCheckpointId(config);
    if (!threadId || !conversationId) return undefined;
    try {
      const CheckpointModel = getCheckpointModel();
      const WritesModel = getWritesModel();
      let doc: any;
      if (checkpointId) {
        doc = await CheckpointModel.findOne({ conversationId, threadId, checkpointNs, checkpointId }).lean();
      } else {
        doc = await CheckpointModel.findOne({ conversationId, threadId, checkpointNs }).sort({ checkpointId: -1 }).lean();
      }
      if (!doc) return undefined;
      const checkpointBytes = Buffer.from(doc.checkpoint, 'base64');
      const metadataBytes = Buffer.from(doc.metadata, 'base64');
      const deserializedCheckpoint = await this.serde.loadsTyped('json', checkpointBytes);
      const deserializedMetadata = await this.serde.loadsTyped('json', metadataBytes);
      // Refuse corrupted checkpoints written by an old engine before the put-time
      // guard existed. A proper checkpoint is an object with versions_seen; the
      // fast-safe-stringify placeholder deserializes to a plain string. Returning
      // undefined here makes LangGraph fall back to emptyCheckpoint() instead of
      // crashing in `_first()` with "Cannot read properties of undefined".
      if (typeof deserializedCheckpoint !== 'object' || deserializedCheckpoint === null || !('versions_seen' in deserializedCheckpoint)) {
        console.error(`[MongoCheckpointer] Refusing corrupted checkpoint for thread ${threadId} (checkpointId=${doc.checkpointId}): deserialized to ${typeof deserializedCheckpoint}. Falling back to emptyCheckpoint.`);
        return undefined;
      }
      const writeDocs = await WritesModel.find({ conversationId, threadId, checkpointNs, checkpointId: doc.checkpointId }).lean();
      const pendingWrites = await Promise.all(
        writeDocs.map(async (w: any) => {
          const valueBytes = Buffer.from(w.value, 'base64');
          const deserializedValue = await this.serde.loadsTyped('json', valueBytes);
          return [w.taskId, w.channel, deserializedValue];
        })
      );
      const tuple: any = {
        config: { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: doc.checkpointId } },
        checkpoint: deserializedCheckpoint,
        metadata: deserializedMetadata,
        pendingWrites,
      };
      if (doc.parentCheckpointId != null) {
        tuple.parentConfig = { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: doc.parentCheckpointId } };
      }
      return tuple;
    } catch (error) {
      console.error('[MongoCheckpointer] getTuple error:', error);
      return undefined;
    }
  }

  async *list(config: any, options?: any): AsyncGenerator<any> {
    const { conversationId, threadId } = this._getIds(config);
    const checkpointNs = config.configurable?.checkpoint_ns;
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !conversationId) return;
    try {
      const CheckpointModel = getCheckpointModel();
      const WritesModel = getWritesModel();
      const query: any = { conversationId, threadId };
      if (checkpointNs !== undefined) query.checkpointNs = checkpointNs;
      if (checkpointId !== undefined) query.checkpointId = checkpointId;
      const { before, limit, filter } = options ?? {};
      if (before?.configurable?.checkpoint_id) {
        query.checkpointId = { $lt: before.configurable.checkpoint_id };
      }
      let cursor = CheckpointModel.find(query).sort({ checkpointId: -1 });
      if (limit !== undefined) cursor = cursor.limit(limit);
      const docs = await cursor.lean();
      for (const doc of docs) {
        const checkpointBytes = Buffer.from(doc.checkpoint, 'base64');
        const metadataBytes = Buffer.from(doc.metadata, 'base64');
        const deserializedCheckpoint = await this.serde.loadsTyped('json', checkpointBytes);
        const deserializedMetadata = await this.serde.loadsTyped('json', metadataBytes);
        if (typeof deserializedCheckpoint !== 'object' || deserializedCheckpoint === null || !('versions_seen' in deserializedCheckpoint)) {
          console.error(`[MongoCheckpointer] Skipping corrupted checkpoint in list() for thread ${threadId} (checkpointId=${doc.checkpointId})`);
          continue;
        }
        if (filter && !Object.entries(filter).every(([k, v]) => (deserializedMetadata as any)[k] === v)) continue;
        const writeDocs = await WritesModel.find({ conversationId, threadId, checkpointNs: doc.checkpointNs, checkpointId: doc.checkpointId }).lean();
        const pendingWrites = await Promise.all(
          writeDocs.map(async (w: any) => {
            const valueBytes = Buffer.from(w.value, 'base64');
            const deserializedValue = await this.serde.loadsTyped('json', valueBytes);
            return [w.taskId, w.channel, deserializedValue];
          })
        );
        const tuple: any = {
          config: { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: doc.checkpointNs, checkpoint_id: doc.checkpointId } },
          checkpoint: deserializedCheckpoint,
          metadata: deserializedMetadata,
          pendingWrites,
        };
        if (doc.parentCheckpointId != null) {
          tuple.parentConfig = { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: doc.checkpointNs, checkpoint_id: doc.parentCheckpointId } };
        }
        yield tuple;
      }
    } catch (error) {
      console.error('[MongoCheckpointer] list error:', error);
    }
  }

  async put(config: any, checkpoint: any, metadata: any, _newVersions?: any): Promise<any> {
    const { conversationId, threadId } = this._getIds(config);
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    if (!threadId || !conversationId) throw new Error('[MongoCheckpointer] put() called without thread_id/conversation_id in config.configurable');
    try {
      const CheckpointModel = getCheckpointModel();
      const preparedCheckpoint = copyCheckpoint(checkpoint);
      const [[, checkpointBytes], [, metadataBytes]] = await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);
      assertSerializationOk('put(checkpoint)', preparedCheckpoint, checkpointBytes);
      assertSerializationOk('put(metadata)', metadata, metadataBytes);
      const checkpointStr = Buffer.from(checkpointBytes).toString('base64');
      const metadataStr = Buffer.from(metadataBytes).toString('base64');
      const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
      if (!oversized('put(checkpoint)', threadId, checkpointStr.length + metadataStr.length)) {
        await CheckpointModel.findOneAndUpdate(
          { conversationId, threadId, checkpointNs, checkpointId: checkpoint.id },
          { $set: { conversationId, threadId, checkpointNs, checkpointId: checkpoint.id, parentCheckpointId, checkpoint: checkpointStr, metadata: metadataStr, createdAt: new Date() } },
          { upsert: true, new: true }
        );
      }
      return { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
    } catch (error) {
      // NEVER rethrow: checkpoint persistence is best-effort. A thrown error
      // here escapes LangGraph's pregel loop as an unhandled rejection and
      // kills the worker process, orphaning every in-flight run (the
      // 2026-07-20 tpf-ai incident). Losing one checkpoint only degrades
      // crash-resume granularity — the run itself must keep going.
      console.error('[MongoCheckpointer] put error (non-fatal, checkpoint skipped):', error);
      return { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
    }
  }

  async putWrites(config: any, writes: any[], taskId: string): Promise<void> {
    const { conversationId, threadId } = this._getIds(config);
    const checkpointNs = config.configurable?.checkpoint_ns ?? '';
    const checkpointId = config.configurable?.checkpoint_id;
    if (!threadId || !conversationId) throw new Error('[MongoCheckpointer] putWrites() called without thread_id/conversation_id in config.configurable');
    if (!checkpointId) throw new Error('[MongoCheckpointer] putWrites() called without checkpoint_id in config.configurable');
    try {
      const WritesModel = getWritesModel();
      await Promise.all(
        writes.map(async ([channel, value]: [string, any], idx: number) => {
          const [, valueBytes] = await this.serde.dumpsTyped(value);
          assertSerializationOk(`putWrites(${channel})`, value, valueBytes);
          const valueStr = Buffer.from(valueBytes).toString('base64');
          if (oversized(`putWrites(${channel})`, threadId, valueStr.length)) return;
          const resolvedIdx = WRITES_IDX_MAP[channel] ?? idx;
          await WritesModel.findOneAndUpdate(
            { conversationId, threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx },
            { $setOnInsert: { conversationId, threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx, channel, value: valueStr, createdAt: new Date() } },
            { upsert: true }
          );
        })
      );
    } catch (error) {
      // Same rationale as put(): a failed pending-write record must never
      // crash the worker. See the put() catch block.
      console.error('[MongoCheckpointer] putWrites error (non-fatal, write skipped):', error);
    }
  }

  async deleteThread(threadId: string, conversationId?: string): Promise<void> {
    try {
      const CheckpointModel = getCheckpointModel();
      const WritesModel = getWritesModel();
      const query: any = { threadId };
      if (conversationId) query.conversationId = conversationId;
      await Promise.all([
        CheckpointModel.deleteMany(query),
        WritesModel.deleteMany(query),
      ]);
      console.log(`[MongoCheckpointer] Deleted checkpoints for thread: ${threadId}${conversationId ? ` (conv: ${conversationId})` : ''}`);
    } catch (error) {
      console.error('[MongoCheckpointer] deleteThread error:', error);
    }
  }
}

export function createMongoCheckpointer(): MongoCheckpointer {
  return new MongoCheckpointer();
}
