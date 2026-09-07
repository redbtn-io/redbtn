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
 * @module lib/mcp/run-bridge-shim
 */

import * as net from 'net';

const sock = process.env.REDBTN_BRIDGE_SOCK;
const nonce = process.env.REDBTN_BRIDGE_NONCE;

if (!sock || !nonce) {
  process.stderr.write('run-bridge-shim: REDBTN_BRIDGE_SOCK and REDBTN_BRIDGE_NONCE are required\n');
  process.exit(2);
}

const socket = net.connect(sock);
socket.on('connect', () => {
  socket.write(`${JSON.stringify({ redbtn: 'auth', nonce })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on('error', (err: Error) => {
  process.stderr.write(`run-bridge-shim: ${err.message}\n`);
  process.exit(1);
});
socket.on('close', () => process.exit(0));
process.stdin.on('end', () => socket.end());
