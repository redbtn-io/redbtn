"use strict";
/**
 * SSH Shell — Native System Tool
 *
 * Opens an SSH connection, runs a command, streams stdout/stderr back through
 * the RunPublisher in real-time. Returns the full output and exit code when
 * the command completes.
 *
 * Key characteristics vs. MCP stdio path:
 * - No JSON-RPC serialization overhead
 * - No hard 90-second timeout (configurable per call, default unlimited)
 * - RunPublisher access for live UI streaming
 * - Large output support (truncated at 100KB in return value, full output
 *   is available as the streaming feed)
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
Object.defineProperty(exports, "__esModule", { value: true });
const ssh2_1 = require("ssh2");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
// No limits — Claude sessions can produce large outputs and we need
// the full stream-json including the final result event
const MAX_RETURN_BYTES = Infinity;
const MAX_STDERR_BYTES = Infinity;
const MAX_BUFFER_BYTES = Infinity;
const sshShell = {
    description: 'Execute a command on a remote machine via SSH with real-time output streaming. Returns stdout, stderr, and exit code.',
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
                description: 'Path to SSH private key file on the worker machine. Supports ~ expansion.',
            },
            sshKey: {
                type: 'string',
                description: 'SSH private key content (PEM string). Use this instead of sshKeyPath when the key is stored in secrets.',
            },
            password: {
                type: 'string',
                description: 'SSH password. Only used when sshKeyPath is not provided.',
            },
            command: {
                type: 'string',
                description: 'Shell command to execute on the remote machine.',
            },
            workingDir: {
                type: 'string',
                description: 'Working directory on the remote machine. If set, the command is prefixed with cd <dir> &&.',
            },
            timeout: {
                type: 'number',
                description: 'Timeout in milliseconds. 0 means no timeout (default: 0).',
                default: 0,
            },
            env: {
                type: 'object',
                description: 'Environment variables to export before running the command.',
                default: {},
            },
        },
        required: ['host', 'command'],
    },
    handler: (rawArgs, context) => __awaiter(void 0, void 0, void 0, function* () {
        const args = rawArgs;
        const { host, port = 22, user = 'alpha', sshKeyPath, sshKey, password, command, workingDir, timeout = 0, env = {}, } = args;
        const publisher = (context === null || context === void 0 ? void 0 : context.publisher) || null;
        const runId = (context === null || context === void 0 ? void 0 : context.runId) || null;
        const nodeId = (context === null || context === void 0 ? void 0 : context.nodeId) || 'ssh_shell';
        console.log(`[ssh_shell] Connecting to ${user}@${host}:${port}`);
        console.log(`[ssh_shell] Command: ${command.substring(0, 200)}${command.length > 200 ? '...' : ''}`);
        if (runId)
            console.log(`[ssh_shell] Run: ${runId}, Node: ${nodeId}`);
        // Build the full command to execute on the remote shell
        let fullCommand = command;
        if (workingDir) {
            fullCommand = `cd ${JSON.stringify(workingDir)} && ${command}`;
        }
        if (env && Object.keys(env).length > 0) {
            const envExports = Object.entries(env)
                .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
                .join(' && ');
            fullCommand = `${envExports} && ${fullCommand}`;
        }
        return new Promise((resolve) => {
            const conn = new ssh2_1.Client();
            let stdout = '';
            let stderr = '';
            let exitCode = null;
            let timeoutTimer = null;
            let settled = false;
            const startTime = Date.now();
            const settle = (error) => {
                if (settled)
                    return;
                settled = true;
                if (timeoutTimer) {
                    clearTimeout(timeoutTimer);
                    timeoutTimer = null;
                }
                if (statusInterval) {
                    clearInterval(statusInterval);
                    statusInterval = null;
                }
                try {
                    conn.end();
                }
                catch (_) { /* ignore */ }
                const duration = Date.now() - startTime;
                if (error) {
                    console.error(`[ssh_shell] Error after ${duration}ms: ${error.message}`);
                    resolve({
                        content: [{
                                type: 'text',
                                text: JSON.stringify({
                                    success: false,
                                    error: error.message,
                                    stdout: stdout.length > MAX_RETURN_BYTES
                                        ? stdout.substring(stdout.length - MAX_RETURN_BYTES)
                                        : stdout,
                                    stderr: stderr.length > MAX_STDERR_BYTES
                                        ? stderr.substring(stderr.length - MAX_STDERR_BYTES)
                                        : stderr,
                                    exitCode,
                                    durationMs: duration,
                                }),
                            }],
                        isError: true,
                    });
                    return;
                }
                const success = exitCode === 0;
                console.log(`[ssh_shell] Completed in ${duration}ms. exitCode=${exitCode}, stdout=${stdout.length}B, stderr=${stderr.length}B`);
                if (stderr.length > 0)
                    console.log(`[ssh_shell] stderr: ${stderr.substring(0, 500)}`);
                resolve({
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                success,
                                exitCode,
                                stdout: stdout.length > MAX_RETURN_BYTES
                                    ? stdout.substring(stdout.length - MAX_RETURN_BYTES)
                                    : stdout,
                                stderr: stderr.length > MAX_STDERR_BYTES
                                    ? stderr.substring(stderr.length - MAX_STDERR_BYTES)
                                    : stderr,
                                totalBytes: stdout.length + stderr.length,
                                truncated: stdout.length > MAX_RETURN_BYTES || stderr.length > MAX_STDERR_BYTES,
                                durationMs: duration,
                            }),
                        }],
                });
            };
            if (timeout > 0) {
                timeoutTimer = setTimeout(() => {
                    settle(new Error(`SSH command timed out after ${Math.round(timeout / 1000)}s`));
                }, timeout);
            }
            if (context === null || context === void 0 ? void 0 : context.abortSignal) {
                context.abortSignal.addEventListener('abort', () => {
                    settle(new Error('SSH command aborted by caller'));
                }, { once: true });
            }
            const connConfig = {
                host,
                port,
                username: user,
                readyTimeout: 15000,
                keepaliveInterval: 15000,
                keepaliveCountMax: 5,
            };
            if (sshKey) {
                // Key content passed directly (e.g. from secrets store)
                connConfig.privateKey = Buffer.from(sshKey, 'utf8');
                console.log(`[ssh_shell] Using key auth: inline key (${sshKey.length} chars)`);
            }
            else if (sshKeyPath) {
                const expandedPath = sshKeyPath.replace(/^~/, os.homedir());
                try {
                    connConfig.privateKey = fs.readFileSync(expandedPath);
                    console.log(`[ssh_shell] Using key auth: ${expandedPath}`);
                }
                catch (readErr) {
                    const msg = readErr instanceof Error ? readErr.message : String(readErr);
                    return settle(new Error(`Cannot read SSH key at '${expandedPath}': ${msg}`));
                }
            }
            else if (password) {
                connConfig.password = password;
                console.log('[ssh_shell] Using password auth');
            }
            else {
                console.warn('[ssh_shell] No auth method provided — connection may fail');
            }
            // Periodic status publisher — keeps client informed during long SSH runs
            let statusInterval = null;
            conn.on('ready', () => {
                console.log(`[ssh_shell] SSH connection established to ${user}@${host}:${port}`);
                if (publisher) {
                    try {
                        publisher.publish({
                            type: 'tool_start',
                            nodeId,
                            data: {
                                tool: 'ssh_shell',
                                host,
                                user,
                                command: command.substring(0, 200),
                                timestamp: Date.now(),
                            },
                        });
                    }
                    catch (pubErr) {
                        const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
                        console.warn('[ssh_shell] Failed to publish tool_start:', msg);
                    }
                    // Publish periodic status updates every 15 seconds so the UI shows activity
                    statusInterval = setInterval(() => {
                        if (settled) {
                            if (statusInterval)
                                clearInterval(statusInterval);
                            return;
                        }
                        const elapsed = Math.round((Date.now() - startTime) / 1000);
                        try {
                            publisher.publish({
                                type: 'status',
                                action: 'running_command',
                                description: `SSH command running (${elapsed}s, ${stdout.length + stderr.length} bytes)`,
                                timestamp: Date.now(),
                            });
                        }
                        catch (_) { /* ignore */ }
                    }, 15000);
                }
                conn.exec(fullCommand, { pty: false }, (err, stream) => {
                    if (err) {
                        console.error('[ssh_shell] exec() failed:', err.message);
                        return settle(err);
                    }
                    stream.on('data', (data) => {
                        const chunk = data.toString('utf8');
                        stdout += chunk;
                        // Rolling buffer — discard oldest bytes if we exceed the limit
                        if (stdout.length > MAX_BUFFER_BYTES) {
                            stdout = stdout.substring(stdout.length - MAX_BUFFER_BYTES);
                        }
                        if (publisher) {
                            try {
                                publisher.publish({
                                    type: 'tool_output',
                                    nodeId,
                                    data: { chunk, stream: 'stdout', totalBytes: stdout.length },
                                });
                            }
                            catch (pubErr) {
                                const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
                                console.warn('[ssh_shell] Failed to publish stdout chunk:', msg);
                            }
                        }
                        // Parser/streaming callback
                        if (context.onChunk) {
                            try {
                                context.onChunk(chunk, 'stdout');
                            }
                            catch (cbErr) {
                                const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
                                console.warn('[ssh_shell] onChunk callback error (stdout):', msg);
                            }
                        }
                    });
                    stream.stderr.on('data', (data) => {
                        const chunk = data.toString('utf8');
                        stderr += chunk;
                        if (stderr.length > MAX_BUFFER_BYTES) {
                            stderr = stderr.substring(stderr.length - MAX_BUFFER_BYTES);
                        }
                        if (publisher) {
                            try {
                                publisher.publish({
                                    type: 'tool_output',
                                    nodeId,
                                    data: { chunk, stream: 'stderr', totalBytes: stderr.length },
                                });
                            }
                            catch (pubErr) {
                                const msg = pubErr instanceof Error ? pubErr.message : String(pubErr);
                                console.warn('[ssh_shell] Failed to publish stderr chunk:', msg);
                            }
                        }
                        // Parser/streaming callback
                        if (context.onChunk) {
                            try {
                                context.onChunk(chunk, 'stderr');
                            }
                            catch (cbErr) {
                                const msg = cbErr instanceof Error ? cbErr.message : String(cbErr);
                                console.warn('[ssh_shell] onChunk callback error (stderr):', msg);
                            }
                        }
                    });
                    stream.on('close', (code, signal) => {
                        exitCode = code;
                        if (signal) {
                            console.log(`[ssh_shell] Process killed by signal: ${signal}`);
                        }
                        settle(null);
                    });
                    stream.on('error', (streamErr) => {
                        console.error('[ssh_shell] Stream error:', streamErr.message);
                        settle(streamErr);
                    });
                });
            });
            conn.on('error', (connErr) => {
                console.error(`[ssh_shell] Connection error: ${connErr.message}`);
                settle(connErr);
            });
            conn.on('timeout', () => {
                settle(new Error(`SSH connection to ${host}:${port} timed out`));
            });
            conn.on('end', () => {
                if (!settled) {
                    settle(new Error('SSH connection closed unexpectedly by remote'));
                }
            });
            conn.connect(connConfig);
        });
    }),
};
exports.default = sshShell;
// Also export as module.exports for CJS require() compatibility (the .js files use require())
module.exports = sshShell;
