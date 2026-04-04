"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __await = (this && this.__await) || function (v) { return this instanceof __await ? (this.v = v, this) : new __await(v); }
var __asyncGenerator = (this && this.__asyncGenerator) || function (thisArg, _arguments, generator) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var g = generator.apply(thisArg, _arguments || []), i, q = [];
    return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function () { return this; }, i;
    function awaitReturn(f) { return function (v) { return Promise.resolve(v).then(f, reject); }; }
    function verb(n, f) { if (g[n]) { i[n] = function (v) { return new Promise(function (a, b) { q.push([n, v, a, b]) > 1 || resume(n, v); }); }; if (f) i[n] = f(i[n]); } }
    function resume(n, v) { try { step(g[n](v)); } catch (e) { settle(q[0][3], e); } }
    function step(r) { r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r); }
    function fulfill(value) { resume("next", value); }
    function reject(value) { resume("throw", value); }
    function settle(f, v) { if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoCheckpointer = void 0;
exports.createMongoCheckpointer = createMongoCheckpointer;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint, getCheckpointId } = require('@langchain/langgraph-checkpoint');
// ============================================================================
// MongoDB schema helpers (raw mongoose access, no model recompilation)
// ============================================================================
function getCheckpointModel() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (mongoose.models.GraphCheckpoint) {
        return mongoose.models.GraphCheckpoint;
    }
    const schema = new mongoose.Schema({
        threadId: { type: String, required: true, index: true },
        checkpointNs: { type: String, default: '' },
        checkpointId: { type: String, required: true },
        parentCheckpointId: { type: String, default: null },
        checkpoint: { type: String, required: true },
        metadata: { type: String, required: true },
        createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
    }, { collection: 'graphcheckpoints' });
    schema.index({ threadId: 1, checkpointNs: 1, checkpointId: 1 }, { unique: true });
    return mongoose.model('GraphCheckpoint', schema);
}
function getWritesModel() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (mongoose.models.GraphCheckpointWrite) {
        return mongoose.models.GraphCheckpointWrite;
    }
    const schema = new mongoose.Schema({
        threadId: { type: String, required: true, index: true },
        checkpointNs: { type: String, default: '' },
        checkpointId: { type: String, required: true },
        taskId: { type: String, required: true },
        idx: { type: Number, required: true },
        channel: { type: String, required: true },
        value: { type: String, required: true },
        createdAt: { type: Date, default: Date.now, expires: 7 * 24 * 60 * 60 },
    }, { collection: 'graphcheckpointwrites' });
    schema.index({ threadId: 1, checkpointNs: 1, checkpointId: 1, taskId: 1, idx: 1 }, { unique: true });
    return mongoose.model('GraphCheckpointWrite', schema);
}
// ============================================================================
// MongoCheckpointer class
// ============================================================================
class MongoCheckpointer extends BaseCheckpointSaver {
    constructor(serde) {
        super(serde);
    }
    getTuple(config) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const threadId = (_a = config.configurable) === null || _a === void 0 ? void 0 : _a.thread_id;
            const checkpointNs = (_c = (_b = config.configurable) === null || _b === void 0 ? void 0 : _b.checkpoint_ns) !== null && _c !== void 0 ? _c : '';
            const checkpointId = getCheckpointId(config);
            if (!threadId)
                return undefined;
            try {
                const CheckpointModel = getCheckpointModel();
                const WritesModel = getWritesModel();
                let doc;
                if (checkpointId) {
                    doc = yield CheckpointModel.findOne({ threadId, checkpointNs, checkpointId }).lean();
                }
                else {
                    doc = yield CheckpointModel.findOne({ threadId, checkpointNs }).sort({ checkpointId: -1 }).lean();
                }
                if (!doc)
                    return undefined;
                const checkpointBytes = Buffer.from(doc.checkpoint, 'base64');
                const metadataBytes = Buffer.from(doc.metadata, 'base64');
                const deserializedCheckpoint = yield this.serde.loadsTyped('json', checkpointBytes);
                const deserializedMetadata = yield this.serde.loadsTyped('json', metadataBytes);
                const writeDocs = yield WritesModel.find({ threadId, checkpointNs, checkpointId: doc.checkpointId }).lean();
                const pendingWrites = yield Promise.all(writeDocs.map((w) => __awaiter(this, void 0, void 0, function* () {
                    const valueBytes = Buffer.from(w.value, 'base64');
                    const deserializedValue = yield this.serde.loadsTyped('json', valueBytes);
                    return [w.taskId, w.channel, deserializedValue];
                })));
                const tuple = {
                    config: { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: doc.checkpointId } },
                    checkpoint: deserializedCheckpoint,
                    metadata: deserializedMetadata,
                    pendingWrites,
                };
                if (doc.parentCheckpointId != null) {
                    tuple.parentConfig = { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: doc.parentCheckpointId } };
                }
                return tuple;
            }
            catch (error) {
                console.error('[MongoCheckpointer] getTuple error:', error);
                return undefined;
            }
        });
    }
    list(config, options) {
        return __asyncGenerator(this, arguments, function* list_1() {
            var _a, _b, _c, _d;
            const threadId = (_a = config.configurable) === null || _a === void 0 ? void 0 : _a.thread_id;
            const checkpointNs = (_b = config.configurable) === null || _b === void 0 ? void 0 : _b.checkpoint_ns;
            const checkpointId = (_c = config.configurable) === null || _c === void 0 ? void 0 : _c.checkpoint_id;
            if (!threadId)
                return yield __await(void 0);
            try {
                const CheckpointModel = getCheckpointModel();
                const WritesModel = getWritesModel();
                const query = { threadId };
                if (checkpointNs !== undefined)
                    query.checkpointNs = checkpointNs;
                if (checkpointId !== undefined)
                    query.checkpointId = checkpointId;
                const { before, limit, filter } = options !== null && options !== void 0 ? options : {};
                if ((_d = before === null || before === void 0 ? void 0 : before.configurable) === null || _d === void 0 ? void 0 : _d.checkpoint_id) {
                    query.checkpointId = { $lt: before.configurable.checkpoint_id };
                }
                let cursor = CheckpointModel.find(query).sort({ checkpointId: -1 });
                if (limit !== undefined)
                    cursor = cursor.limit(limit);
                const docs = yield __await(cursor.lean());
                for (const doc of docs) {
                    const checkpointBytes = Buffer.from(doc.checkpoint, 'base64');
                    const metadataBytes = Buffer.from(doc.metadata, 'base64');
                    const deserializedCheckpoint = yield __await(this.serde.loadsTyped('json', checkpointBytes));
                    const deserializedMetadata = yield __await(this.serde.loadsTyped('json', metadataBytes));
                    if (filter && !Object.entries(filter).every(([k, v]) => deserializedMetadata[k] === v))
                        continue;
                    const writeDocs = yield __await(WritesModel.find({ threadId, checkpointNs: doc.checkpointNs, checkpointId: doc.checkpointId }).lean());
                    const pendingWrites = yield __await(Promise.all(writeDocs.map((w) => __awaiter(this, void 0, void 0, function* () {
                        const valueBytes = Buffer.from(w.value, 'base64');
                        const deserializedValue = yield this.serde.loadsTyped('json', valueBytes);
                        return [w.taskId, w.channel, deserializedValue];
                    }))));
                    const tuple = {
                        config: { configurable: { thread_id: threadId, checkpoint_ns: doc.checkpointNs, checkpoint_id: doc.checkpointId } },
                        checkpoint: deserializedCheckpoint,
                        metadata: deserializedMetadata,
                        pendingWrites,
                    };
                    if (doc.parentCheckpointId != null) {
                        tuple.parentConfig = { configurable: { thread_id: threadId, checkpoint_ns: doc.checkpointNs, checkpoint_id: doc.parentCheckpointId } };
                    }
                    yield yield __await(tuple);
                }
            }
            catch (error) {
                console.error('[MongoCheckpointer] list error:', error);
            }
        });
    }
    put(config, checkpoint, metadata, _newVersions) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d, _e;
            const threadId = (_a = config.configurable) === null || _a === void 0 ? void 0 : _a.thread_id;
            const checkpointNs = (_c = (_b = config.configurable) === null || _b === void 0 ? void 0 : _b.checkpoint_ns) !== null && _c !== void 0 ? _c : '';
            if (!threadId)
                throw new Error('[MongoCheckpointer] put() called without thread_id in config.configurable');
            try {
                const CheckpointModel = getCheckpointModel();
                const preparedCheckpoint = copyCheckpoint(checkpoint);
                const [[, checkpointBytes], [, metadataBytes]] = yield Promise.all([
                    this.serde.dumpsTyped(preparedCheckpoint),
                    this.serde.dumpsTyped(metadata),
                ]);
                const checkpointStr = Buffer.from(checkpointBytes).toString('base64');
                const metadataStr = Buffer.from(metadataBytes).toString('base64');
                const parentCheckpointId = (_e = (_d = config.configurable) === null || _d === void 0 ? void 0 : _d.checkpoint_id) !== null && _e !== void 0 ? _e : null;
                yield CheckpointModel.findOneAndUpdate({ threadId, checkpointNs, checkpointId: checkpoint.id }, { $set: { threadId, checkpointNs, checkpointId: checkpoint.id, parentCheckpointId, checkpoint: checkpointStr, metadata: metadataStr, createdAt: new Date() } }, { upsert: true, new: true });
                return { configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpoint.id } };
            }
            catch (error) {
                console.error('[MongoCheckpointer] put error:', error);
                throw error;
            }
        });
    }
    putWrites(config, writes, taskId) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c, _d;
            const threadId = (_a = config.configurable) === null || _a === void 0 ? void 0 : _a.thread_id;
            const checkpointNs = (_c = (_b = config.configurable) === null || _b === void 0 ? void 0 : _b.checkpoint_ns) !== null && _c !== void 0 ? _c : '';
            const checkpointId = (_d = config.configurable) === null || _d === void 0 ? void 0 : _d.checkpoint_id;
            if (!threadId)
                throw new Error('[MongoCheckpointer] putWrites() called without thread_id in config.configurable');
            if (!checkpointId)
                throw new Error('[MongoCheckpointer] putWrites() called without checkpoint_id in config.configurable');
            try {
                const WritesModel = getWritesModel();
                yield Promise.all(writes.map((_a, idx_1) => __awaiter(this, [_a, idx_1], void 0, function* ([channel, value], idx) {
                    var _b;
                    const [, valueBytes] = yield this.serde.dumpsTyped(value);
                    const valueStr = Buffer.from(valueBytes).toString('base64');
                    const resolvedIdx = (_b = WRITES_IDX_MAP[channel]) !== null && _b !== void 0 ? _b : idx;
                    yield WritesModel.findOneAndUpdate({ threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx }, { $setOnInsert: { threadId, checkpointNs, checkpointId, taskId, idx: resolvedIdx, channel, value: valueStr, createdAt: new Date() } }, { upsert: true });
                })));
            }
            catch (error) {
                console.error('[MongoCheckpointer] putWrites error:', error);
                throw error;
            }
        });
    }
    deleteThread(threadId) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const CheckpointModel = getCheckpointModel();
                const WritesModel = getWritesModel();
                yield Promise.all([
                    CheckpointModel.deleteMany({ threadId }),
                    WritesModel.deleteMany({ threadId }),
                ]);
                console.log(`[MongoCheckpointer] Deleted checkpoints for thread: ${threadId}`);
            }
            catch (error) {
                console.error('[MongoCheckpointer] deleteThread error:', error);
            }
        });
    }
}
exports.MongoCheckpointer = MongoCheckpointer;
function createMongoCheckpointer() {
    return new MongoCheckpointer();
}
