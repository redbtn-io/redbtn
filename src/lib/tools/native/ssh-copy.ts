/**
 * SSH Copy — Native System Tool
 *
 * Copies files to a remote machine via SSH/SFTP. Supports three content sources:
 *
 * 1. **Knowledge Library** — `libraryId` (+ optional `documentId`, `since`)
 *    Reads files directly from GridFS (no HTTP, no auth tokens needed).
 *    Can sync an entire library or a single document.
 *
 * 2. **Source URL** — `sourceUrl`
 *    Fetches content from any URL and writes it to the remote path.
 *
 * 3. **Inline content** — `content` (+ optional `contentBase64`)
 *    Writes raw string or base64-decoded content directly.
 *
 * Uses ssh2 SFTP for efficient binary-safe file transfer.
 */

import { Client, SFTPWrapper } from 'ssh2';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import mongoose from 'mongoose';
import { GridFSBucket, ObjectId } from 'mongodb';
import type { NativeToolDefinition, NativeMcpResult, NativeToolContext } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface SshCopyArgs {
  // SSH connection
  host: string;
  port?: number;
  user?: string;
  sshKeyPath?: string;
  sshKey?: string;
  password?: string;

  // Destination
  remotePath: string;

  // Source: Knowledge Library
  libraryId?: string;
  documentId?: string;
  since?: string; // ISO date — only copy docs added after this

  // Source: URL
  sourceUrl?: string;

  // Source: Inline
  content?: string;
  contentBase64?: boolean;
  filename?: string; // Used with content/sourceUrl to name the remote file

  // Options
  overwrite?: boolean;
  createDirs?: boolean;
}

interface FileToTransfer {
  filename: string;
  buffer: Buffer;
}

// ---------------------------------------------------------------------------
// Content resolution helpers
// ---------------------------------------------------------------------------

async function resolveFromLibrary(args: SshCopyArgs, publisher: AnyObject | null, nodeId: string): Promise<FileToTransfer[]> {
  const { libraryId, documentId, since } = args;
  const db = mongoose.connection.db;
  if (!db) throw new Error('MongoDB connection not available — cannot read Knowledge Library');

  const librariesCol = db.collection('libraries');
  const library = await librariesCol.findOne({ libraryId });
  if (!library) throw new Error(`Knowledge Library not found: ${libraryId}`);

  let docs = library.documents || [];

  // Filter to specific document
  if (documentId) {
    docs = docs.filter((d: AnyObject) => d.documentId === documentId);
    if (docs.length === 0) throw new Error(`Document ${documentId} not found in library ${libraryId}`);
  }

  // Filter by date
  if (since) {
    const sinceDate = new Date(since);
    docs = docs.filter((d: AnyObject) => new Date(d.addedAt) >= sinceDate);
  }

  // Only copy docs that have a GridFS file
  docs = docs.filter((d: AnyObject) => d.gridFsFileId);

  if (docs.length === 0) {
    return [];
  }

  if (publisher) {
    try {
      (publisher as AnyObject).publish({
        type: 'tool_output',
        nodeId,
        data: { chunk: `[ssh_copy] Preparing ${docs.length} file(s) from library "${library.name}"\n`, stream: 'stdout' },
      });
    } catch (_) { /* ignore */ }
  }

  const bucket = new GridFSBucket(db, { bucketName: 'library_files' });
  const files: FileToTransfer[] = [];

  for (const doc of docs) {
    try {
      const stream = bucket.openDownloadStream(new ObjectId(doc.gridFsFileId));
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      // Use original filename or document source or title
      const filename = doc.source || doc.title || `doc_${doc.documentId}`;
      files.push({ filename, buffer });

      console.log(`[ssh_copy] Read ${filename} (${buffer.length} bytes) from GridFS`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ssh_copy] Failed to read document ${doc.documentId} from GridFS: ${msg}`);
    }
  }

  return files;
}

async function resolveFromUrl(args: SshCopyArgs): Promise<FileToTransfer[]> {
  const { sourceUrl, filename } = args;
  if (!sourceUrl) throw new Error('sourceUrl is required');

  console.log(`[ssh_copy] Fetching ${sourceUrl}`);
  const response = await fetch(sourceUrl, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${sourceUrl}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  // Determine filename
  let resolvedFilename = filename;
  if (!resolvedFilename) {
    // Try Content-Disposition header
    const cd = response.headers.get('content-disposition');
    const cdMatch = cd?.match(/filename="?([^";\n]+)"?/);
    if (cdMatch) {
      resolvedFilename = cdMatch[1].trim();
    } else {
      // Fall back to URL path
      const urlPath = new URL(sourceUrl).pathname;
      resolvedFilename = urlPath.split('/').pop() || 'downloaded_file';
    }
  }

  return [{ filename: resolvedFilename, buffer }];
}

function resolveFromContent(args: SshCopyArgs): FileToTransfer[] {
  const { content, contentBase64, filename } = args;
  if (content === undefined || content === null) throw new Error('content is required');

  const buffer = contentBase64
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf8');

  return [{ filename: filename || 'file', buffer }];
}

// ---------------------------------------------------------------------------
// SFTP transfer
// ---------------------------------------------------------------------------

function sftpWriteFile(sftp: SFTPWrapper, remotePath: string, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(remotePath);
    ws.on('error', reject);
    ws.on('close', () => resolve());
    ws.end(buffer);
  });
}

function sftpMkdir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  return new Promise((resolve) => {
    sftp.mkdir(dirPath, (err) => {
      // Ignore EEXIST — directory already exists
      resolve();
    });
  });
}

function sftpStat(sftp: SFTPWrapper, filePath: string): Promise<boolean> {
  return new Promise((resolve) => {
    sftp.stat(filePath, (err) => {
      resolve(!err);
    });
  });
}

async function sftpMkdirp(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean);
  let current = dirPath.startsWith('/') ? '' : '';
  for (const part of parts) {
    current += '/' + part;
    await sftpMkdir(sftp, current);
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const sshCopy: NativeToolDefinition = {
  description: 'Copy files to a remote machine via SSH/SFTP. Supports three content sources: Knowledge Library (libraryId), URL (sourceUrl), or inline content. Can sync an entire library to a remote directory.',
  server: 'system',

  inputSchema: {
    type: 'object',
    properties: {
      host: {
        type: 'string',
        description: 'SSH hostname or IP address',
      },
      port: {
        type: 'number',
        description: 'SSH port (default: 22)',
        default: 22,
      },
      user: {
        type: 'string',
        description: 'SSH username (default: alpha)',
        default: 'alpha',
      },
      sshKeyPath: {
        type: 'string',
        description: 'Path to SSH private key file. Supports ~ expansion.',
      },
      sshKey: {
        type: 'string',
        description: 'SSH private key content (PEM string).',
      },
      password: {
        type: 'string',
        description: 'SSH password. Only used when no key is provided.',
      },
      remotePath: {
        type: 'string',
        description: 'Remote directory to copy files into (for library/URL), or full file path (for single file). Created automatically if it does not exist.',
      },

      // Knowledge Library source
      libraryId: {
        type: 'string',
        description: 'Copy files from this Knowledge Library. Reads directly from GridFS — no auth tokens needed.',
      },
      documentId: {
        type: 'string',
        description: 'Copy a specific document from the library. Requires libraryId.',
      },
      since: {
        type: 'string',
        description: 'ISO date string. Only copy documents added after this date. Useful for incremental sync.',
      },

      // URL source
      sourceUrl: {
        type: 'string',
        description: 'Fetch content from this URL and copy to remotePath.',
      },

      // Inline source
      content: {
        type: 'string',
        description: 'Inline content to write to the remote file.',
      },
      contentBase64: {
        type: 'boolean',
        description: 'If true, content is base64-encoded and will be decoded before writing.',
        default: false,
      },
      filename: {
        type: 'string',
        description: 'Filename for inline content or URL downloads. Used when remotePath is a directory.',
      },

      // Options
      overwrite: {
        type: 'boolean',
        description: 'Overwrite existing files (default: true).',
        default: true,
      },
    },
    required: ['host', 'remotePath'],
  },

  handler: async (rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const args = rawArgs as SshCopyArgs;
    const {
      host,
      port = 22,
      user = 'alpha',
      sshKeyPath,
      sshKey,
      password,
      remotePath,
      overwrite = true,
    } = args;

    const publisher = context?.publisher || null;
    const nodeId = context?.nodeId || 'ssh_copy';
    const startTime = Date.now();

    console.log(`[ssh_copy] Target: ${user}@${host}:${port}:${remotePath}`);

    // -----------------------------------------------------------------------
    // 1. Resolve content source
    // -----------------------------------------------------------------------
    let files: FileToTransfer[];
    try {
      if (args.libraryId) {
        files = await resolveFromLibrary(args, publisher, nodeId);
      } else if (args.sourceUrl) {
        files = await resolveFromUrl(args);
      } else if (args.content !== undefined) {
        files = resolveFromContent(args);
      } else {
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No content source provided. Specify libraryId, sourceUrl, or content.' }) }],
          isError: true,
        };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ssh_copy] Content resolution failed: ${msg}`);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: `Content resolution failed: ${msg}` }) }],
        isError: true,
      };
    }

    if (files.length === 0) {
      const duration = Date.now() - startTime;
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, filesTransferred: 0, message: 'No files to transfer (library may be empty or no documents match the since filter)', durationMs: duration }) }],
      };
    }

    const totalBytes = files.reduce((sum, f) => sum + f.buffer.length, 0);
    console.log(`[ssh_copy] ${files.length} file(s) to transfer, ${totalBytes} bytes total`);

    // -----------------------------------------------------------------------
    // 2. SSH connect + SFTP transfer
    // -----------------------------------------------------------------------
    return new Promise((resolve) => {
      const conn = new Client();
      let settled = false;

      const settle = (error: Error | null, result?: AnyObject) => {
        if (settled) return;
        settled = true;
        try { conn.end(); } catch (_) { /* ignore */ }

        const duration = Date.now() - startTime;

        if (error) {
          console.error(`[ssh_copy] Error after ${duration}ms: ${error.message}`);
          resolve({
            content: [{ type: 'text', text: JSON.stringify({ success: false, error: error.message, durationMs: duration }) }],
            isError: true,
          });
          return;
        }

        console.log(`[ssh_copy] Completed in ${duration}ms`);
        resolve({
          content: [{ type: 'text', text: JSON.stringify({ success: true, ...result, durationMs: duration }) }],
        });
      };

      // Build SSH config (same pattern as ssh_shell)
      const connConfig: Record<string, unknown> = {
        host,
        port,
        username: user,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
      };

      if (sshKey) {
        connConfig.privateKey = Buffer.from(sshKey, 'utf8');
      } else if (sshKeyPath) {
        const expandedPath = sshKeyPath.replace(/^~/, os.homedir());
        try {
          connConfig.privateKey = fs.readFileSync(expandedPath);
        } catch (readErr: unknown) {
          const msg = readErr instanceof Error ? readErr.message : String(readErr);
          return settle(new Error(`Cannot read SSH key at '${expandedPath}': ${msg}`));
        }
      } else if (password) {
        connConfig.password = password;
      }

      if (context?.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          settle(new Error('SSH copy aborted by caller'));
        }, { once: true });
      }

      conn.on('ready', () => {
        conn.sftp((err, sftp) => {
          if (err) return settle(err);

          (async () => {
            // Determine if remotePath is a directory target
            const isMultiFile = files.length > 1;
            const endsWithSlash = remotePath.endsWith('/');
            const isDirectory = isMultiFile || endsWithSlash || !!args.libraryId;

            if (isDirectory) {
              // Ensure remote directory exists
              await sftpMkdirp(sftp, remotePath);
            } else {
              // Ensure parent directory exists
              const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
              if (parentDir) await sftpMkdirp(sftp, parentDir);
            }

            const transferred: Array<{ filename: string; bytes: number }> = [];
            const skipped: string[] = [];

            for (const file of files) {
              const targetPath = isDirectory
                ? `${remotePath.replace(/\/+$/, '')}/${file.filename}`
                : remotePath;

              // Check overwrite
              if (!overwrite) {
                const exists = await sftpStat(sftp, targetPath);
                if (exists) {
                  skipped.push(file.filename);
                  continue;
                }
              }

              // Ensure parent directory for this specific file
              const fileParent = targetPath.substring(0, targetPath.lastIndexOf('/'));
              if (fileParent) await sftpMkdirp(sftp, fileParent);

              await sftpWriteFile(sftp, targetPath, file.buffer);
              transferred.push({ filename: file.filename, bytes: file.buffer.length });

              if (publisher) {
                try {
                  (publisher as AnyObject).publish({
                    type: 'tool_output',
                    nodeId,
                    data: {
                      chunk: `[ssh_copy] Transferred ${file.filename} (${file.buffer.length} bytes) → ${targetPath}\n`,
                      stream: 'stdout',
                    },
                  });
                } catch (_) { /* ignore */ }
              }
            }

            settle(null, {
              filesTransferred: transferred.length,
              filesSkipped: skipped.length,
              totalBytes: transferred.reduce((s, f) => s + f.bytes, 0),
              files: transferred,
              ...(skipped.length > 0 ? { skipped } : {}),
            });
          })().catch((asyncErr: Error) => settle(asyncErr));
        });
      });

      conn.on('error', (connErr: Error) => settle(connErr));
      conn.on('timeout', () => settle(new Error(`SSH connection to ${host}:${port} timed out`)));
      conn.on('end', () => {
        if (!settled) settle(new Error('SSH connection closed unexpectedly'));
      });

      conn.connect(connConfig as any);
    });
  },
};

export default sshCopy;
module.exports = sshCopy;
