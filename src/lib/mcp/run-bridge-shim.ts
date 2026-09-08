/**
 * stdio ↔ Unix-socket shim for the per-run MCP tool bridge.
 *
 * Named as the `command` in the CLI's `mcp.json`; the CLI speaks
 * newline-delimited JSON-RPC over this process's stdio, and this process is
 * nothing but a pipe to `run-bridge.ts`'s socket. It writes ONE frame of its
 * own — the auth line — then never touches the stream again.
 *
 * Dependency-free by contract: it runs as `node <this file>` from `dist`, out
 * of any module graph, so it must import nothing but node builtins.
 *
 * Exit codes: 2 = no environment, 1 = the socket refused us, 0 = the server
 * closed the connection. It never calls `process.exit` once a stream is in
 * play — see `finish()`.
 *
 * @module lib/mcp/run-bridge-shim
 */

import * as net from 'net';

const sock = process.env.REDBTN_BRIDGE_SOCK;
const nonce = process.env.REDBTN_BRIDGE_NONCE;

if (!sock || !nonce) {
  // `exitCode` rather than `exit()`: stderr is a pipe here and a pipe write is
  // asynchronous, so exiting immediately can drop the diagnostic.
  process.exitCode = 2;
  process.stderr.write('run-bridge-shim: REDBTN_BRIDGE_SOCK and REDBTN_BRIDGE_NONCE are required\n');
} else {
  const socket = net.connect(sock);

  /**
   * Stop reading stdin and let the process end on its own.
   *
   * The previous version called `process.exit(0)` from the socket's `close`
   * handler. `socket.pipe(process.stdout)` writes to a pipe ASYNCHRONOUSLY, so
   * exiting there discards whatever is still buffered — which is the last
   * JSON-RPC response the server sent, i.e. the tool result the model is
   * waiting on. Setting an exit code and releasing the only remaining handle
   * lets Node flush stdout and exit with the same status.
   */
  const finish = (code: number): void => {
    process.exitCode = code;
    try {
      process.stdin.unpipe(socket);
    } catch {
      /* never piped */
    }
    try {
      process.stdin.destroy();
    } catch {
      /* already gone */
    }
  };

  socket.on('connect', () => {
    socket.write(`${JSON.stringify({ redbtn: 'auth', nonce })}\n`);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.on('error', (err: Error) => {
    process.stderr.write(`run-bridge-shim: ${err.message}\n`);
    finish(1);
    socket.destroy();
  });
  socket.on('close', () => finish(typeof process.exitCode === 'number' ? process.exitCode : 0));
  process.stdin.on('end', () => socket.end());
}
