"use strict";
/**
 * Library Write — Native System Tool
 *
 * Writes content to a Knowledge Library programmatically.
 * Creates a document in GridFS, adds it to the library's document list,
 * and optionally chunks + indexes it in the vector store.
 *
 * Use cases:
 * - Automation graphs writing scan results, reports, or digests
 * - Programmatic ingestion from external sources
 * - Agent output archival
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
// Use GridFSBucket and ObjectId from mongoose's bundled mongodb to avoid BSON version mismatch
const { GridFSBucket } = mongoose_1.default.mongo;
const ObjectId = mongoose_1.default.Types.ObjectId;
function generateId() {
    return 'doc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}
const libraryWrite = {
    description: 'Write a document to a Knowledge Library. Stores the content in GridFS and adds it to the library document list. Use for programmatic ingestion of reports, scan results, and automation outputs.',
    server: 'system',
    inputSchema: {
        type: 'object',
        properties: {
            libraryId: {
                type: 'string',
                description: 'Target Knowledge Library ID.',
            },
            title: {
                type: 'string',
                description: 'Document title. Shown in the library UI.',
            },
            content: {
                type: 'string',
                description: 'Text content to write. Will be stored as-is and indexed for search.',
            },
            filename: {
                type: 'string',
                description: 'Filename for the stored document (default: title + .md).',
            },
            mimeType: {
                type: 'string',
                description: 'MIME type of the content (default: text/markdown).',
                default: 'text/markdown',
            },
            sourceType: {
                type: 'string',
                description: 'Source type tag (default: automation). Used for filtering.',
                default: 'automation',
            },
            metadata: {
                type: 'object',
                description: 'Optional metadata to attach to the document.',
            },
        },
        required: ['libraryId', 'title', 'content'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { libraryId, title, content, filename = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md', mimeType = 'text/markdown', sourceType = 'automation', metadata = {}, } = args;
        const startTime = Date.now();
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'library_write';
        console.log(`[library_write] Writing "${title}" to library ${libraryId}`);
        try {
            const db = mongoose_1.default.connection.db;
            if (!db)
                throw new Error('MongoDB connection not available');
            const librariesCol = db.collection('libraries');
            const library = yield librariesCol.findOne({ libraryId });
            if (!library)
                throw new Error(`Knowledge Library not found: ${libraryId}`);
            // Store content in GridFS
            const bucket = new GridFSBucket(db, { bucketName: 'library_files' });
            const buffer = Buffer.from(content, 'utf8');
            const documentId = generateId();
            const uploadStream = bucket.openUploadStream(filename, {
                metadata: {
                    documentId,
                    libraryId,
                    userId: library.userId,
                    mimeType,
                    originalName: filename,
                    uploadedAt: new Date(),
                },
            });
            yield new Promise((resolve, reject) => {
                uploadStream.on('error', reject);
                uploadStream.on('finish', () => resolve());
                uploadStream.end(buffer);
            });
            const gridFsFileId = uploadStream.id.toString();
            // Count words and chars
            const wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
            const charCount = content.length;
            // Add document to library
            const docEntry = {
                documentId,
                title,
                sourceType,
                source: filename,
                mimeType,
                fileSize: buffer.length,
                gridFsFileId,
                chunkCount: 0,
                charCount,
                addedAt: new Date(),
                addedBy: library.userId,
                processingStatus: 'completed',
                metadata: Object.assign(Object.assign({}, metadata), { wordCount, writtenBy: 'library_write', runId: (context === null || context === void 0 ? void 0 : context.runId) || null }),
            };
            yield librariesCol.updateOne({ libraryId }, {
                $push: { documents: docEntry },
                $inc: {
                    documentCount: 1,
                    totalSize: buffer.length,
                },
                $set: { lastUpdatedAt: new Date() },
            });
            // Try to chunk and index in vector store
            let chunked = false;
            let chunkCount = 0;
            try {
                // Dynamic import to avoid hard dependency
                const { VectorStoreManager } = require('../../memory/vectors');
                if (VectorStoreManager && library.vectorCollection) {
                    const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8024';
                    const vsm = new VectorStoreManager(chromaUrl);
                    const chunks = yield vsm.chunkText(content, {
                        chunkSize: library.chunkSize || 2000,
                        chunkOverlap: library.chunkOverlap || 200,
                    });
                    if (chunks.length > 0) {
                        yield vsm.addDocuments(library.vectorCollection, chunks.map((chunk, i) => ({
                            id: `${documentId}_chunk_${i}`,
                            text: chunk,
                            metadata: {
                                documentId,
                                libraryId,
                                title,
                                source: filename,
                                sourceType,
                                addedBy: library.userId,
                                chunkIndex: i,
                            },
                        })));
                        chunkCount = chunks.length;
                        chunked = true;
                        // Update chunk count in document
                        yield librariesCol.updateOne({ libraryId, 'documents.documentId': documentId }, {
                            $set: { 'documents.$.chunkCount': chunkCount },
                            $inc: { totalChunks: chunkCount },
                        });
                    }
                }
            }
            catch (vecErr) {
                const msg = vecErr instanceof Error ? vecErr.message : String(vecErr);
                console.warn(`[library_write] Vector indexing skipped: ${msg}`);
                // Non-fatal — document is still stored in GridFS
            }
            const duration = Date.now() - startTime;
            console.log(`[library_write] Written "${title}" (${buffer.length}B, ${chunkCount} chunks) in ${duration}ms`);
            if (publisher) {
                try {
                    publisher.publish({
                        type: 'tool_output',
                        nodeId,
                        data: {
                            chunk: `[library_write] Written "${title}" to ${library.name} (${buffer.length} bytes, ${chunkCount} chunks)\n`,
                            stream: 'stdout',
                        },
                    });
                }
                catch (_) { /* ignore */ }
            }
            return {
                content: [{
                        type: 'text',
                        text: JSON.stringify({
                            success: true,
                            documentId,
                            gridFsFileId,
                            title,
                            libraryId,
                            fileSize: buffer.length,
                            wordCount,
                            charCount,
                            chunked,
                            chunkCount,
                            durationMs: duration,
                        }),
                    }],
            };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const duration = Date.now() - startTime;
            console.error(`[library_write] Error: ${msg}`);
            return {
                content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg, durationMs: duration }) }],
                isError: true,
            };
        }
    }),
};
exports.default = libraryWrite;
module.exports = libraryWrite;
