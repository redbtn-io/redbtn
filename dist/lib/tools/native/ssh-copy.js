"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __asyncValues = (this && this.__asyncValues) || function (o) {
    if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
    var m = o[Symbol.asyncIterator], i;
    return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function () { return this; }, i);
    function verb(n) { i[n] = o[n] && function (v) { return new Promise(function (resolve, reject) { v = o[n](v), settle(resolve, reject, v.done, v.value); }); }; }
    function settle(resolve, reject, d, v) { Promise.resolve(v).then(function(v) { resolve({ value: v, done: d }); }, reject); }
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ssh2_1 = require("ssh2");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const mongoose_1 = __importDefault(require("mongoose"));
// Use GridFSBucket and ObjectId from mongoose's bundled mongodb to avoid BSON version mismatch
const { GridFSBucket } = mongoose_1.default.mongo;
const ObjectId = mongoose_1.default.Types.ObjectId;
// ---------------------------------------------------------------------------
// Content resolution helpers
// ---------------------------------------------------------------------------
function resolveFromLibrary(args, publisher, nodeId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, e_1, _b, _c;
        const { libraryId, documentId, since } = args;
        const db = mongoose_1.default.connection.db;
        if (!db)
            throw new Error('MongoDB connection not available — cannot read Knowledge Library');
        const librariesCol = db.collection('libraries');
        const library = yield librariesCol.findOne({ libraryId });
        if (!library)
            throw new Error(`Knowledge Library not found: ${libraryId}`);
        let docs = library.documents || [];
        // Filter to specific document
        if (documentId) {
            docs = docs.filter((d) => d.documentId === documentId);
            if (docs.length === 0)
                throw new Error(`Document ${documentId} not found in library ${libraryId}`);
        }
        // Filter by date
        if (since) {
            const sinceDate = new Date(since);
            docs = docs.filter((d) => new Date(d.addedAt) >= sinceDate);
        }
        // Only copy docs that have a GridFS file
        docs = docs.filter((d) => d.gridFsFileId);
        if (docs.length === 0) {
            return [];
        }
        if (publisher) {
            try {
                publisher.publish({
                    type: 'tool_output',
                    nodeId,
                    data: { chunk: `[ssh_copy] Preparing ${docs.length} file(s) from library "${library.name}"\n`, stream: 'stdout' },
                });
            }
            catch (_) { /* ignore */ }
        }
        const bucket = new GridFSBucket(db, { bucketName: 'library_files' });
        const files = [];
        for (const doc of docs) {
            try {
                const stream = bucket.openDownloadStream(new ObjectId(doc.gridFsFileId));
                const chunks = [];
                try {
                    for (var _d = true, stream_1 = (e_1 = void 0, __asyncValues(stream)), stream_1_1; stream_1_1 = yield stream_1.next(), _a = stream_1_1.done, !_a; _d = true) {
                        _c = stream_1_1.value;
                        _d = false;
                        const chunk = _c;
                        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                    }
                }
                catch (e_1_1) { e_1 = { error: e_1_1 }; }
                finally {
                    try {
                        if (!_d && !_a && (_b = stream_1.return)) yield _b.call(stream_1);
                    }
                    finally { if (e_1) throw e_1.error; }
                }
                const buffer = Buffer.concat(chunks);
                // Use original filename or document source or title
                const filename = doc.source || doc.title || `doc_${doc.documentId}`;
                files.push({ filename, buffer });
                console.log(`[ssh_copy] Read ${filename} (${buffer.length} bytes) from GridFS`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.warn(`[ssh_copy] Failed to read document ${doc.documentId} from GridFS: ${msg}`);
            }
        }
        return files;
    });
}
function resolveFromUrl(args) {
    return __awaiter(this, void 0, void 0, function* () {
        const { sourceUrl, filename } = args;
        if (!sourceUrl)
            throw new Error('sourceUrl is required');
        console.log(`[ssh_copy] Fetching ${sourceUrl}`);
        const response = yield fetch(sourceUrl, { redirect: 'follow' });
        if (!response.ok) {
            throw new Error(`Failed to fetch ${sourceUrl}: ${response.status} ${response.statusText}`);
        }
        const buffer = Buffer.from(yield response.arrayBuffer());
        // Determine filename
        let resolvedFilename = filename;
        if (!resolvedFilename) {
            // Try Content-Disposition header
            const cd = response.headers.get('content-disposition');
            const cdMatch = cd === null || cd === void 0 ? void 0 : cd.match(/filename="?([^";\n]+)"?/);
            if (cdMatch) {
                resolvedFilename = cdMatch[1].trim();
            }
            else {
                // Fall back to URL path
                const urlPath = new URL(sourceUrl).pathname;
                resolvedFilename = urlPath.split('/').pop() || 'downloaded_file';
            }
        }
        return [{ filename: resolvedFilename, buffer }];
    });
}
function resolveFromContent(args) {
    const { content, contentBase64, filename } = args;
    if (content === undefined || content === null)
        throw new Error('content is required');
    const buffer = contentBase64
        ? Buffer.from(content, 'base64')
        : Buffer.from(content, 'utf8');
    return [{ filename: filename || 'file', buffer }];
}
// ---------------------------------------------------------------------------
// SFTP transfer
// ---------------------------------------------------------------------------
function sftpWriteFile(sftp, remotePath, buffer) {
    return new Promise((resolve, reject) => {
        const ws = sftp.createWriteStream(remotePath);
        ws.on('error', reject);
        ws.on('close', () => resolve());
        ws.end(buffer);
    });
}
function sftpMkdir(sftp, dirPath) {
    return new Promise((resolve) => {
        sftp.mkdir(dirPath, (err) => {
            // Ignore EEXIST — directory already exists
            resolve();
        });
    });
}
function sftpStat(sftp, filePath) {
    return new Promise((resolve) => {
        sftp.stat(filePath, (err) => {
            resolve(!err);
        });
    });
}
function sftpMkdirp(sftp, dirPath) {
    return __awaiter(this, void 0, void 0, function* () {
        const parts = dirPath.split('/').filter(Boolean);
        let current = dirPath.startsWith('/') ? '' : '';
        for (const part of parts) {
            current += '/' + part;
            yield sftpMkdir(sftp, current);
        }
    });
}
// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------
const sshCopy = {
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
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { host, port = 22, user = 'alpha', sshKeyPath, sshKey, password, remotePath, overwrite = true, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'ssh_copy';
        const startTime = Date.now();
        console.log(`[ssh_copy] Target: ${user}@${host}:${port}:${remotePath}`);
        // -----------------------------------------------------------------------
        // 1. Resolve content source
        // -----------------------------------------------------------------------
        let files;
        try {
            if (args.libraryId) {
                files = yield resolveFromLibrary(args, publisher, nodeId);
            }
            else if (args.sourceUrl) {
                files = yield resolveFromUrl(args);
            }
            else if (args.content !== undefined) {
                files = resolveFromContent(args);
            }
            else {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ success: false, error: 'No content source provided. Specify libraryId, sourceUrl, or content.' }) }],
                    isError: true,
                };
            }
        }
        catch (err) {
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
            const conn = new ssh2_1.Client();
            let settled = false;
            const settle = (error, result) => {
                if (settled)
                    return;
                settled = true;
                try {
                    conn.end();
                }
                catch (_) { /* ignore */ }
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
                    content: [{ type: 'text', text: JSON.stringify(Object.assign(Object.assign({ success: true }, result), { durationMs: duration })) }],
                });
            };
            // Build SSH config (same pattern as ssh_shell)
            const connConfig = {
                host,
                port,
                username: user,
                readyTimeout: 15000,
                keepaliveInterval: 15000,
            };
            if (sshKey) {
                connConfig.privateKey = Buffer.from(sshKey, 'utf8');
            }
            else if (sshKeyPath) {
                const expandedPath = sshKeyPath.replace(/^~/, os.homedir());
                try {
                    connConfig.privateKey = fs.readFileSync(expandedPath);
                }
                catch (readErr) {
                    const msg = readErr instanceof Error ? readErr.message : String(readErr);
                    return settle(new Error(`Cannot read SSH key at '${expandedPath}': ${msg}`));
                }
            }
            else if (password) {
                connConfig.password = password;
            }
            if (context === null || context === void 0 ? void 0 : context.abortSignal) {
                context.abortSignal.addEventListener('abort', () => {
                    settle(new Error('SSH copy aborted by caller'));
                }, { once: true });
            }
            conn.on('ready', () => {
                conn.sftp((err, sftp) => {
                    if (err)
                        return settle(err);
                    (() => __awaiter(void 0, void 0, void 0, function* () {
                        // Determine if remotePath is a directory target
                        const isMultiFile = files.length > 1;
                        const endsWithSlash = remotePath.endsWith('/');
                        const isDirectory = isMultiFile || endsWithSlash || !!args.libraryId;
                        if (isDirectory) {
                            // Ensure remote directory exists
                            yield sftpMkdirp(sftp, remotePath);
                        }
                        else {
                            // Ensure parent directory exists
                            const parentDir = remotePath.substring(0, remotePath.lastIndexOf('/'));
                            if (parentDir)
                                yield sftpMkdirp(sftp, parentDir);
                        }
                        const transferred = [];
                        const skipped = [];
                        for (const file of files) {
                            const targetPath = isDirectory
                                ? `${remotePath.replace(/\/+$/, '')}/${file.filename}`
                                : remotePath;
                            // Check overwrite
                            if (!overwrite) {
                                const exists = yield sftpStat(sftp, targetPath);
                                if (exists) {
                                    skipped.push(file.filename);
                                    continue;
                                }
                            }
                            // Ensure parent directory for this specific file
                            const fileParent = targetPath.substring(0, targetPath.lastIndexOf('/'));
                            if (fileParent)
                                yield sftpMkdirp(sftp, fileParent);
                            yield sftpWriteFile(sftp, targetPath, file.buffer);
                            transferred.push({ filename: file.filename, bytes: file.buffer.length });
                            if (publisher) {
                                try {
                                    publisher.publish({
                                        type: 'tool_output',
                                        nodeId,
                                        data: {
                                            chunk: `[ssh_copy] Transferred ${file.filename} (${file.buffer.length} bytes) → ${targetPath}\n`,
                                            stream: 'stdout',
                                        },
                                    });
                                }
                                catch (_) { /* ignore */ }
                            }
                        }
                        settle(null, Object.assign({ filesTransferred: transferred.length, filesSkipped: skipped.length, totalBytes: transferred.reduce((s, f) => s + f.bytes, 0), files: transferred }, (skipped.length > 0 ? { skipped } : {})));
                    }))().catch((asyncErr) => settle(asyncErr));
                });
            });
            conn.on('error', (connErr) => settle(connErr));
            conn.on('timeout', () => settle(new Error(`SSH connection to ${host}:${port} timed out`)));
            conn.on('end', () => {
                if (!settled)
                    settle(new Error('SSH connection closed unexpectedly'));
            });
            conn.connect(connConfig);
        });
    }),
};
exports.default = sshCopy;
module.exports = sshCopy;
