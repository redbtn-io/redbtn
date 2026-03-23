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

import mongoose from 'mongoose';

// Use GridFSBucket and ObjectId from mongoose's bundled mongodb to avoid BSON version mismatch
const { GridFSBucket } = mongoose.mongo;
const ObjectId = mongoose.Types.ObjectId;
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface LibraryWriteArgs {
  libraryId: string;
  title: string;
  content: string;
  filename?: string;
  mimeType?: string;
  sourceType?: string;
  metadata?: Record<string, unknown>;
}

function generateId(): string {
  return 'doc_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

const libraryWrite: NativeToolDefinition = {
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

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as LibraryWriteArgs;
    const {
      libraryId,
      title,
      content,
      filename = title.replace(/[^a-zA-Z0-9_-]/g, '_') + '.md',
      mimeType = 'text/markdown',
      sourceType = 'automation',
      metadata = {},
    } = args;

    const startTime = Date.now();
    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'library_write';

    console.log(`[library_write] Writing "${title}" to library ${libraryId}`);

    try {
      const db = mongoose.connection.db;
      if (!db) throw new Error('MongoDB connection not available');

      const librariesCol = db.collection('libraries');
      const library = await librariesCol.findOne({ libraryId });
      if (!library) throw new Error(`Knowledge Library not found: ${libraryId}`);

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

      await new Promise<void>((resolve, reject) => {
        uploadStream.on('error', reject);
        uploadStream.on('finish', () => resolve());
        uploadStream.end(buffer);
      });

      const gridFsFileId = uploadStream.id.toString();

      // Count words and chars
      const wordCount = content.split(/\s+/).filter((w: string) => w.length > 0).length;
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
        metadata: {
          ...metadata,
          wordCount,
          writtenBy: 'library_write',
          runId: context?.runId || null,
        },
      };

      await librariesCol.updateOne(
        { libraryId },
        {
          $push: { documents: docEntry } as any,
          $inc: {
            documentCount: 1,
            totalSize: buffer.length,
          },
          $set: { lastUpdatedAt: new Date() },
        } as any
      );

      // Try to chunk and index in vector store
      let chunked = false;
      let chunkCount = 0;
      try {
        // Dynamic import to avoid hard dependency
        const { VectorStoreManager } = require('../../memory/vectors');
        if (VectorStoreManager && library.vectorCollection) {
          const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8024';
          const vsm = new VectorStoreManager(chromaUrl);
          const chunks = await vsm.chunkText(content, {
            chunkSize: library.chunkSize || 2000,
            chunkOverlap: library.chunkOverlap || 200,
          });

          if (chunks.length > 0) {
            await vsm.addDocuments(library.vectorCollection, chunks.map((chunk: string, i: number) => ({
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
            await librariesCol.updateOne(
              { libraryId, 'documents.documentId': documentId },
              {
                $set: { 'documents.$.chunkCount': chunkCount },
                $inc: { totalChunks: chunkCount },
              }
            );
          }
        }
      } catch (vecErr: unknown) {
        const msg = vecErr instanceof Error ? vecErr.message : String(vecErr);
        console.warn(`[library_write] Vector indexing skipped: ${msg}`);
        // Non-fatal — document is still stored in GridFS
      }

      const duration = Date.now() - startTime;
      console.log(`[library_write] Written "${title}" (${buffer.length}B, ${chunkCount} chunks) in ${duration}ms`);

      if (publisher) {
        try {
          (publisher as AnyObject).publish({
            type: 'tool_output',
            nodeId,
            data: {
              chunk: `[library_write] Written "${title}" to ${library.name} (${buffer.length} bytes, ${chunkCount} chunks)\n`,
              stream: 'stdout',
            },
          });
        } catch (_) { /* ignore */ }
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const duration = Date.now() - startTime;
      console.error(`[library_write] Error: ${msg}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: msg, durationMs: duration }) }],
        isError: true,
      };
    }
  },
};

export default libraryWrite;
module.exports = libraryWrite;
