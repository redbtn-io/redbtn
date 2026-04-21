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
      const checkpointStr = Buffer.from(checkpointBytes).toString('base64');
      const metadataStr = Buffer.from(metadataBytes).toString('base64');
      const parentCheckpointId = config.configurable?.checkpoint_id ?? null;
      await CheckpointModel.findOneAndUpdate(
        { conversationId, threadId, checkpointNs, checkpointId: checkpoint.id },
        { $set: { conversationId, threadId, checkpointNs, checkpointId: checkpoint.id, parentCheckpointId, checkpoint: checkpointStr, metadata: metadataStr, createdAt: new Date() } },
        { upsert: true, new: true }
      );
      return { configurable: { conversation_id: conversationId, thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
    } catch (error) {
      console.error('[MongoCheckpointer] put error:', error);
      throw error;
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
          const valueStr = Buffer.from(valueBytes).toString('base64');
          const resolvedIdx = WRITES_IDX_MAP[channel] ?? idx;
          await WritesModel.findOneAndUpdate(
            { conversationId, threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx },
            { $setOnInsert: { conversationId, threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx, channel, value: valueStr, createdAt: new Date() } },
            { upsert: true }
          );
        })
      );
    } catch (error) {
      console.error('[MongoCheckpointer] putWrites error:', error);
      throw error;
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
