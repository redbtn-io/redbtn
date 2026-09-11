/**
 * Per-run MCP tool bridge (Unix domain socket, nonce-gated).
 *
 * # What this is
 *
 * The server half of the surface a `claude -p` child gets when it runs as a
 * child of a neuron step (the "Opus 5" / `claude-code` provider). The CLI runs
 * its own agent loop and will not hand us `tool_calls`, so the only way to give
 * it the run's tools — under the run's capability profile, its exec guard, its
 * rate limits and its audit — is to speak MCP at it.
 *
 * Transport is a Unix domain socket inside the step's private `dir` (mode 0700,
 * socket 0600), reached by `run-bridge-shim.ts`, a ~20-line dependency-free
 * stdio↔socket pipe named as the `command` in the CLI's `mcp.json`. There is no
 * HTTP hop, no edge, no Redis: server and client are one process tree, so a
 * tool call costs well under a millisecond before it reaches the real registry.
 *
 * # The security contract (this file IS the enforcement point)
 *
 * `--allowedTools` gates nothing under `defaultMode: bypassPermissions`, which
 * is the fleet standard, so every client-side flag is belt and this server is
 * the only real gate. Concretely:
 *
 *   1. `tools/list` serves `node.tools ∩ native registry − FORBIDDEN`. Nothing
 *      else is served and, more importantly, nothing else is *callable*: the
 *      allowlist is rebuilt at construction and `tools/call` checks it again.
 *   2. The `environmentId` property is REMOVED from every served schema and
 *      overwritten from the session on every call, so a CLI that guesses an
 *      environment id cannot retarget a tool at another machine (every env tool
 *      accepts an override, and `hasAccess` is owner-or-`isPublic`).
 *   3. `cwd` / `workingDir` default to the session's workingDir. The bridge no
 *      longer injects a `run_command` timeout: PR #379 gave the tool its own
 *      operator-tunable default (`RUN_COMMAND_DEFAULT_TIMEOUT_MS`), and a
 *      hardcoded shadow here would silently override that knob for CLI steps
 *      only — a stricter, invisible, untunable limit that an API neuron
 *      running the same tool does not get.
 *   4. Every dispatch goes through `NativeToolRegistry.callTool` — never a
 *      handler directly — so the capability profile, the fail-closed exec gate,
 *      the kill switches, `EXEC_RATE_MAX` and the fail-closed audit all apply
 *      exactly as they do for an API neuron. The context carries
 *      `untrustedCaller: true`, and that flag is READ BACK through
 *      `callerIsTrusted` before the call leaves this file, so a rename of the
 *      caller-trust contract fails the call instead of quietly handing a
 *      model-chosen URL the platform's internal credentials.
 *   5. The connection is nonce-gated: the first line must be the auth frame,
 *      compared in constant time. Three failures revoke the session and fail
 *      the step. An unauthenticated peer gets `AUTH_DEADLINE_MS` and
 *      `MAX_PREAUTH_BYTES` and is then destroyed, and the listener accepts at
 *      most `MAX_CONNECTIONS` sockets at once: one CLI child needs one socket,
 *      and this heap is shared with every other step on the replica.
 *   6. BOTH the published `input` and the published result are scrubbed for
 *      credential patterns and bounded in size before they reach the run
 *      archive — never before the result is returned, because the model needs
 *      the real bytes. A credential the model passes as an ARGUMENT is worth
 *      exactly as much as one that comes back in a result. Scrubbing is by
 *      VALUE SHAPE and by KEY NAME, because `_secrets`, a `password` and a
 *      connection's `apiKey` have no recognisable shape at all.
 *   7. Every `tools/call` frame is charged against the session budget BEFORE
 *      the allowlist and the args check, so the two denial branches — the
 *      cheapest frames an attacker can send, and the ones that publish two
 *      run-archive writes each — are capped like everything else.
 *   8. Attacker-controlled bytes are truncated on their way into an error
 *      message or the archive (a bogus tool name, an unvalidated args blob) —
 *      and anything the server would ECHO VERBATIM is allowlisted instead of
 *      truncated, because a bound that only covers one JSON type is not a
 *      bound: a JSON-RPC `id` must be a finite number or a short string, and a
 *      `protocolVersion` must be short and version-shaped, or the frame is an
 *      invalid request answered at constant size.
 *   9. The peer cannot make the worker starve or swell. Reads are pumped in
 *      bounded batches so a pipelined burst cannot stall the event loop; writes
 *      apply backpressure and a peer that will not drain is dropped;
 *      `tools/call` is capped by budget and by concurrency — DENIALS INCLUDED,
 *      because a denial is two archive writes and the dispatcher is
 *      fire-and-forget; and every archive write the bridge awaits has a
 *      deadline. The one deliberate exception is
 *      `callTool` itself — a tool owns its own timeout and holds one of four
 *      inflight slots, not the session.
 *  10. The socket lives 0600 inside a 0700 directory and both are removed on
 *      every ordinary exit path — and, through a single `process.on('exit')`
 *      sweep, on the ones where `close()` never runs. The step directory holds
 *      the CLI's `mcp.json`, which holds the nonce.
 *
 * # What this is NOT
 *
 * It does not extend `McpServer` / `McpServerSSE`. Those are the abstract
 * Redis-transport classes with no live subclass anywhere in the engine; the
 * only thing worth sharing with them is the wire vocabulary, so this module
 * imports `./types` and nothing else from `lib/mcp`.
 *
 * @module lib/mcp/run-bridge
 */

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { StringDecoder } from 'string_decoder';

import type {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  Tool,
  CallToolResult,
} from './types';
import { getNativeRegistry } from '../tools/native-registry';
import type { NativeToolContext } from '../tools/native-registry';
import { coerceArgsToSchema } from '../tools/coerce-args';
import { getDataToolRule } from '../permissions/tool-map';
import { runControlRegistry } from '../run/RunControlRegistry';
import { callerIsTrusted } from '../tools/native/_outbound-url';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// =============================================================================
// Constants
// =============================================================================

/** MCP revision we speak when the client does not name one. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** Server identity reported in `initialize`. */
export const BRIDGE_SERVER_NAME = 'redbtn';

/**
 * Max size of the unparsed read buffer before the peer is dropped.
 *
 * The buffer is drained of complete lines on every turn and the socket is
 * paused while a pump is yielding, so in practice this bounds ONE pending
 * frame. Measured in UTF-16 code units, which is >= the byte count for ASCII
 * JSON and never more than 2x under it: it is a ceiling, not an accountant.
 */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Frames parsed per event-loop turn before the pump yields.
 *
 * A peer may pipeline: `JSON.parse` + dispatch of every complete line in one
 * synchronous `while` was a way to buy an unbounded stall of the worker's event
 * loop with one 8 MB write of tiny frames. The pump processes a bounded batch,
 * pauses the socket, and resumes on the next tick.
 */
const MAX_FRAMES_PER_TICK = 64;

/**
 * Userspace write backlog tolerated before the peer is destroyed.
 *
 * `socket.write` buffers in the heap without bound when the peer stops
 * reading. A CLI child that pipelines `tools/list` and never drains is the
 * cheapest heap-exhaustion primitive on the socket, so writes apply
 * backpressure (pause the reader) and a backlog past this ceiling is a peer
 * that is not going to drain.
 */
const MAX_WRITE_BACKLOG_BYTES = 8 * 1024 * 1024;

/** Failed auth frames tolerated before the whole session is revoked. */
const MAX_AUTH_FAILURES = 3;

/**
 * Concurrent `tools/call` frames allowed per session — DENIALS INCLUDED.
 *
 * A denial is not free work: it publishes a `tool_start` and a `tool_error` to
 * the run archive. `handleRequest` is fire-and-forget, so leaving denials
 * outside this cap let a child hold `maxCalls` audit conversations open at
 * once.
 */
export const MAX_INFLIGHT_CALLS = 4;

/**
 * Peer sockets the listener will hold at once.
 *
 * One CLI child dials in once. Anything beyond a small ceiling is either a bug
 * or a same-uid process squatting on the socket, and every held socket owns a
 * receive buffer on a worker replica whose whole heap is 1792 MB and is shared
 * with every other concurrent step.
 */
export const MAX_CONNECTIONS = 4;

/** How long a peer may hold a socket without a valid auth frame. */
export const AUTH_DEADLINE_MS = 5_000;

/** Bytes an UNAUTHENTICATED peer may buffer. The real auth frame is ~90. */
export const MAX_PREAUTH_BYTES = 4 * 1024;

/** Byte bound on the `input` published for an ACCEPTED call. */
const MAX_PUBLISHED_INPUT_BYTES = 64 * 1024;

/**
 * Byte bound on the RESULT published for an accepted call.
 *
 * The module contract says both halves of a call are bounded before they reach
 * the archive; the result half was not, and a result's size is as
 * caller-chosen as an argument's (`read_file` on a big file, a `run_command`
 * that writes megabytes to stdout). Larger than the input bound because a
 * legitimate result usually is.
 */
const MAX_PUBLISHED_RESULT_BYTES = 256 * 1024;

/**
 * Byte bound on the `input` published for a DENIED call. Much tighter: these
 * args never passed a schema, were never coerced, and are the payload of
 * choice for a child trying to write megabytes into the run archive.
 */
const MAX_DENIED_INPUT_BYTES = 512;

/** Recursion bound when walking a published `input` (hostile nesting). */
const MAX_SCRUB_DEPTH = 12;

/** Bound on an attacker-supplied tool name echoed into an error or an audit. */
const MAX_ECHOED_NAME = 64;

/** `sun_path` is 108 bytes on Linux; leave headroom for the NUL. */
const MAX_SOCKET_PATH = 100;

/** Recursion bound when copying prototype-polluting keys out of an args blob. */
const MAX_STRIP_DEPTH = 12;

/** Chars of a client-chosen JSON-RPC `id` we will echo back. */
const MAX_RPC_ID_CHARS = 128;

/** Chars of a client-chosen `protocolVersion` we will echo back. */
const MAX_PROTOCOL_VERSION_CHARS = 32;

/** A protocol version we are willing to repeat to the client verbatim. */
const PROTOCOL_VERSION_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * Deadline on one run-archive write.
 *
 * The publisher is a network write. Left unbounded it holds a `tools/call`
 * slot (there are four) or, on the denial path, one pending promise per frame.
 * A missed archive write is logged and abandoned; it never fails the call.
 */
const PUBLISHER_TIMEOUT_MS = 15_000;

/**
 * Absolute ceiling on `maxCalls`, whatever `maxToolIterations` the node config
 * carries. The node config is not model-chosen, so this is a bound on operator
 * error rather than on an attacker, but every one of those calls is an archive
 * write and the budget should not be able to name a number with no roof.
 */
export const MAX_CALLS_CEILING = 2_000;

/** Default `--max-turns` assumption when the node does not set one. */
const DEFAULT_MAX_TOOL_ITERATIONS = 50;

/**
 * Tools that are NEVER served and NEVER callable through the bridge, even when
 * the node lists them.
 *
 *   - `invoke_tool` / `list_available_tools` / `get_tool_schema` — the meta
 *     pack. Serving them re-opens the whole registry through one indirection.
 *   - `invoke_graph` — starts another run, with another profile, off this jail.
 *   - `ssh_shell` — inline mode carries its own host/credentials and is
 *     unscoped by `environmentId`, so pinning the session's env does nothing.
 *   - `ssh_copy` — the same hole, in a tool that also moves bytes. With no
 *     `environmentId` the pin is a `delete` (see the option docs), and
 *     `ssh-copy.ts` then falls back to inline `host`/`user`/`sshKey`/`password`
 *     — while `libraryId` reads a Knowledge Library straight out of GridFS.
 *     That is arbitrary-host exfiltration with the model choosing the host, so
 *     it is forbidden outright rather than parked behind the caller-trust gate
 *     below: that fix is about model-chosen URLs and will not touch inline SSH.
 *   - `send_webhook` — arbitrary `url` + `method` + `headers` + `body`, and
 *     unmapped in `tool-map`, so it gets neither the capability check
 *     (`native-registry.ts` `enforceToolCapability`) nor the exec guard. PR
 *     #386 did put it behind the SSRF guard, so the fleet-proxy half is closed;
 *     the ungated half is not, and an egress primitive with a request body and
 *     no capability rule stays off. (`send_email` is a fixed relay — the model picks
 *     a recipient, not a host — and is left servable; if that is judged too
 *     generous it belongs in this list too.)
 *   - `alert_desktop` and every `desktop_*` tool — see `FORBIDDEN_TOOL_PREFIXES`.
 *   - `workspace_checkout` / `workspace_checkin` / `workspace_release` — the
 *     worker owns workspace lifecycle; a run must not move its own fence.
 *   - The AUTHORING pack — `create_neuron` / `update_neuron` / `delete_neuron`
 *     / `fork_neuron`, `create_node` / `update_node` / `node_patch` /
 *     `delete_node` / `fork_node`, and `create_graph` / `update_graph` /
 *     `graph_patch` / `publish_graph` / `fork_graph` / `delete_graph`.
 *
 *     The neuron trio was already here for "self-modification of the model
 *     layer that runs the next step", and the rest achieve exactly that by a
 *     different door: a node IS the step, and a graph is the program the steps
 *     run in. `graph_patch` on the running graph, or `update_node` on the next
 *     node, rewrites the thing about to execute — with the run's own
 *     credentials and no second pair of eyes. `publish_graph` is worse than
 *     self-modification: `native-registry.ts` names `create_graph` +
 *     `update_automation` + a CRON trigger as the boundary the model-driven
 *     taint CANNOT cross, because a scheduled run starts with no model context
 *     to taint. A coding child has no business authoring the platform it runs
 *     on, so the whole pack is off. This is a bridge rule, not a capability
 *     rule — an API neuron with the right profile still has these.
 *
 * The URL-fetching tools are excluded separately by `NETWORK_TOOLS` +
 * `CALLER_TRUST_FIX_PRESENT` below, because that exclusion lifts itself.
 */
export const FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'invoke_tool',
  'list_available_tools',
  'get_tool_schema',
  'invoke_graph',
  'ssh_shell',
  'ssh_copy',
  'send_webhook',
  'alert_desktop',
  'workspace_checkout',
  'workspace_checkin',
  'workspace_release',
  'create_neuron',
  'update_neuron',
  'delete_neuron',
  'fork_neuron',
  'create_node',
  'update_node',
  'node_patch',
  'delete_node',
  'fork_node',
  'create_graph',
  'update_graph',
  'graph_patch',
  'publish_graph',
  'fork_graph',
  'delete_graph',
]);

/**
 * Name prefixes forbidden wholesale.
 *
 * The desktop pack is George's actual keyboard, mouse and shell on a machine a
 * human is sitting at, and it CANNOT be excluded by `tool-map` resource:
 *
 *   - `desktop_exec` is `resource: 'exec'` (`tool-map.ts:208`), the same
 *     resource as `run_command`, so a resource-only rule serves it;
 *   - `desktop_settings`, `desktop_list` and `desktop_ping` are absent from
 *     `tool-map` entirely, so `getDataToolRule` returns `undefined` for them
 *     and a resource-only rule serves those too;
 *   - only the seven `computer:control` tools (`desktop_click`, `desktop_type`,
 *     …) were ever covered.
 *
 * A prefix is the only rule that survives someone adding `desktop_paste` next
 * month, so the prefix is the rule and the resource check below is the belt.
 */
export const FORBIDDEN_TOOL_PREFIXES: readonly string[] = ['desktop_'];

/**
 * Resources whose tools are forbidden wholesale, keyed off `tool-map`.
 *
 * `computer` is the live half: it covers the seven computer-use tools.
 * `environment` covers NOTHING today and is not pretending to — no rule in
 * `permissions/tool-map.ts` uses it, and `permissions/types.ts:52` marks it
 * "reserved: managing env configs (not gated yet)". It is listed so that the
 * day a rule does claim that resource, those tools are forbidden here by
 * default instead of silently served. Read this set as `computer` plus a
 * placeholder, never as two resources' worth of coverage.
 */
const FORBIDDEN_RESOURCES: ReadonlySet<string> = new Set(['computer', 'environment']);

/**
 * URL-fetching tools, forbidden while this build predates the caller-trust fix.
 *
 * `fetch_url`, `scrape_url` and `web_search` run ON THE WORKER, and today
 * `fetch-url.ts` attaches `Authorization`, `X-User-Id` and `X-Internal-Key`
 * (= `INTERNAL_SERVICE_KEY`) to any request aimed at `app.redbtn.io` /
 * `run.redbtn.io` / `WEBAPP_URL`. On the webapp side
 * `X-Internal-Key` + `X-User-Id` resolves as an ADMIN impersonating that user.
 * A model that picks the URL therefore picks an admin request — so until the
 * fix lands these are not served to a model-driven caller at all.
 *
 * Engine PR #378 ("stop model-chosen URLs from borrowing internal auth; add an
 * SSRF guard") is what lands it: it adds `NativeToolContext.untrustedCaller`,
 * makes those tools honour it, and ships `src/lib/net/ssrf-guard.ts`. The
 * detection below keys on that module so this gate lifts itself when the fix is
 * merged rather than waiting for someone to remember a constant.
 *
 * `ssh_copy` is NOT in this set. It also takes a `sourceUrl`, but its inline
 * SSH mode is a separate and larger hole that #378 does not address, so it is
 * in `FORBIDDEN_TOOLS` unconditionally and does not come back when the gate
 * lifts. `send_webhook` is likewise unconditional: it is unmapped in
 * `tool-map`, so no amount of caller-trust plumbing gives it a capability
 * check or an exec guard.
 *
 * The gate has now lifted — #378 and #386 are merged — so these three ARE
 * served. What keeps them safe is `untrustedCaller: true` on every dispatch,
 * asserted at run time against `callerIsTrusted` before the call leaves this
 * file (see `assertUntrustedContext`).
 */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  'fetch_url',
  'scrape_url',
  'web_search',
]);

/**
 * True when this build carries the caller-trust / SSRF fix (engine PRs #378 and
 * #386). Both are merged, so this is `true` — and it is now derived from a
 * STATIC IMPORT rather than a `require.resolve` probe.
 *
 * The probe was wrong in a way that mattered: `require.resolve` cannot resolve
 * a `.ts` sibling under vitest's ESM loader, so the constant read `false` in
 * every test and `true` in the compiled CJS `dist`. The branch that actually
 * ships — network tools SERVED to a model — was therefore the one branch the
 * suite never executed. A static import is the same answer in both worlds, and
 * it fails at COMPILE time rather than silently flipping a security gate if
 * `_outbound-url` is ever moved or renamed.
 *
 * `isForbiddenForBridge` keeps reading it so the intent stays legible and so a
 * build that somehow lacks the helper still fails closed at run time.
 */
export const CALLER_TRUST_FIX_PRESENT: boolean = typeof callerIsTrusted === 'function';

/** Credential shapes scrubbed out of published tool text. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\brpat_[A-Za-z0-9_-]{8,}/g,
  /\brbt_[A-Za-z0-9_-]{8,}/g,
  /\brsk_[A-Za-z0-9_-]{8,}/g,
  /\bghp_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bsk_live_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /\bmongodb\+srv:\/\/\S+/g,
];

const SCRUBBED = '[REDACTED]';

/**
 * Property names whose VALUE is a credential whatever it looks like.
 *
 * {@link SECRET_PATTERNS} only catches credentials with a recognisable shape.
 * A run's `_secrets` bag, a `password`, a connection's `apiKey` and an
 * `Authorization` header are none of those — they are arbitrary strings — and
 * a bridge caller can put any of them into a tool argument and read them back
 * out of the run archive. The key is the signal the value cannot give.
 *
 * Numbers and booleans are exempt so a legitimate `maxTokens: 500` is not
 * redacted into uselessness; a secret is never a number.
 */
const SECRET_KEY_PATTERN =
  /^_?secrets?$|secret|token|password|passwd|passphrase|api[_-]?key|apikey|access[_-]?key|private[_-]?key|ssh[_-]?key|credential|authorization|bearer/i;

/** True when `key` names a value that must never reach the run archive. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * Replace credential-shaped substrings. Applied to text content on its way to
 * `toolComplete` (the run archive), NOT to what the model is handed back.
 */
export function scrubSecretsForPublish(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, SCRUBBED);
  }
  return out;
}

// =============================================================================
// Public types
// =============================================================================

/** The three publisher methods the bridge needs; a real `RunPublisher` fits. */
export interface RunBridgePublisher {
  toolStart(
    toolId: string,
    toolName: string,
    toolType: string,
    options?: AnyObject,
  ): Promise<void> | void;
  toolComplete(
    toolId: string,
    result?: unknown,
    metadata?: AnyObject,
    options?: AnyObject,
  ): Promise<void> | void;
  toolError(toolId: string, error: string, options?: AnyObject): Promise<void> | void;
}

/** Minimal shape of a resolved tool the bridge can serve (see tool-resolver). */
export interface RunBridgeToolRef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  source?: 'native' | 'mcp' | 'graph';
}

export interface StartRunToolBridgeOptions {
  /** Run id — used for cancel registration, audit and tool ids. */
  runId: string;
  /** Live graph state. Passed to `callTool` verbatim: it carries the profile. */
  state: Record<string, unknown>;
  /** Run publisher for `tool_start` / `tool_complete` / `tool_error`. */
  publisher: RunBridgePublisher | null;
  /** Tools the node declared, already resolved. Intersected with the registry. */
  resolvedTools: RunBridgeToolRef[];
  /**
   * Environment every call is pinned to.
   *
   * Non-empty: `args.environmentId` is OVERWRITTEN with this on every call, so
   * a CLI that guesses another environment id cannot retarget a tool.
   *
   * Empty: the key is UNSET on every call. That is not the same as "no env tool
   * can be targeted" — each tool then resolves an environment its own way.
   * `run_command` falls back to `state.data.environmentId`
   * (`run-command.ts:110-115`), which is normally the same environment the step
   * is working in; `ssh_copy` falls back to inline `host`/`user`/`sshKey`,
   * which is exactly why it is in `FORBIDDEN_TOOLS`. An empty pin removes the
   * bridge's override, it does not remove the tool's own resolution — the
   * capability profile is still what decides which environment is reachable.
   */
  environmentId: string;
  /** Default `cwd` / `workingDir` for calls whose schema declares one. Defaults to '/workspace'. */
  workingDir?: string;
  /** Run-level abort signal. Aborting revokes and closes the bridge. */
  abortSignal: AbortSignal | null;
  /** Owning neuron step id, stamped on every published tool event. */
  neuronStepId: string;
  /** The step's private directory (mode 0700). Holds `bridge.sock`. */
  dir: string;

  // ── optional ──────────────────────────────────────────────────────────────
  /** Resolved connection credentials, forwarded to `callTool` unchanged. */
  credentials?: unknown;
  /** Node's `maxToolIterations`; sets the hard call cap (`n*4 + 8`). */
  maxToolIterations?: number;
  /** Called once on a fatal security event (auth revocation). */
  onFatal?: (err: Error) => void;
  /** Called on run cancellation — the executor kills the CLI child here. */
  onCancel?: () => void;
  /** Auth deadline per connection (ms). Defaults to `AUTH_DEADLINE_MS`. */
  authDeadlineMs?: number;
}

export interface RunBridgeStats {
  /**
   * `tools/call` frames charged against the budget. Denials are charged too —
   * a denial publishes two run-archive events, so it is work, and leaving it
   * free made the denial path the one unbounded path in the bridge.
   * Frames rejected BY the cap itself are not charged (see `capped`).
   */
  callsTotal: number;
  /** Calls refused by the allowlist. */
  denied: number;
  /** Failed auth frames across all connections. */
  authFailures: number;
  /** Calls refused because the hard cap was reached. */
  capped: number;
}

export interface RunToolBridge {
  /** Absolute path of the listening socket. */
  readonly socketPath: string;
  /** 64 hex chars. The only credential the CLI holds for the platform. */
  readonly nonce: string;
  /** Absolute path of the stdio shim the CLI is told to spawn. */
  readonly shimPath: string;
  /** Ready-to-write `mcp.json` contents (write it 0600). */
  readonly mcpConfig: Record<string, unknown>;
  /** Names actually served, in `tools/list` order. */
  readonly toolNames: string[];
  /** The served tool descriptors (schemas already stripped). */
  readonly tools: Tool[];
  readonly stats: RunBridgeStats;
  readonly revoked: boolean;
  readonly revokedReason: string | null;
  /** Hard cap on total `tools/call` dispatches for this session. */
  readonly maxCalls: number;
  /** Refuse further work and drop every peer. Idempotent. */
  revoke(reason: string): void;
  /** Revoke, stop listening, unlink the socket and (by default) remove `dir`. */
  close(opts?: { removeDir?: boolean }): Promise<void>;
}

// =============================================================================
// Helpers
// =============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keys that must never survive into an args object handed to a tool. */
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Copy an args object, dropping prototype-polluting keys. `JSON.parse` makes
 * `__proto__` an OWN property, so it is enumerable here and must be skipped by
 * name — assigning it into a fresh object would otherwise rewrite the
 * prototype of the object we hand to a tool.
 */
export function stripPrototypeKeys(raw: Record<string, unknown>): Record<string, unknown> {
  return stripPrototypeKeysDeep(raw, 0) as Record<string, unknown>;
}

/**
 * The recursive half. A top-level-only strip left
 * `{ options: { __proto__: { isAdmin: true } } }` intact, and any downstream
 * tool that deep-merges its options — or hands them to a library that does —
 * turns that into prototype pollution. Depth-bounded for the same reason
 * {@link scrubValueForPublish} is: the args came off a socket.
 *
 * The bound FAILS CLOSED, and that is the whole point of it. Returning the
 * subtree unstripped — which is what this did — turned the recursion limit into
 * the bypass: fourteen meaningless wrappers around
 * `{"__proto__":{"POLLUTED":"yes"}}` walked straight past the bound and reached
 * a tool handler with `__proto__` as an own property. Past the bound nothing
 * that can CARRY a key survives, so the marker is a string, exactly as
 * {@link scrubValueForPublish} does it. No native tool's schema describes an
 * object twelve levels deep, so nothing legitimate is being truncated here.
 */
function stripPrototypeKeysDeep(value: unknown, depth: number): unknown {
  if (depth >= MAX_STRIP_DEPTH) return isPlainObject(value) || Array.isArray(value) ? '[TRUNCATED]' : value;
  if (Array.isArray(value)) return value.map((item) => stripPrototypeKeysDeep(item, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (PROTO_KEYS.has(key)) continue;
    out[key] = stripPrototypeKeysDeep(value[key], depth + 1);
  }
  return out;
}

/**
 * Deep-ish clone of a tool's input schema with the `environmentId` property
 * removed (top level and from `required`), so the model never sees it, never
 * supplies it, and never learns that other environments exist.
 */
export function stripEnvironmentIdFromSchema(schema: unknown): Tool['inputSchema'] {
  const base: AnyObject = isPlainObject(schema)
    ? JSON.parse(JSON.stringify(schema))
    : { type: 'object', properties: {} };
  base.type = 'object';
  if (!isPlainObject(base.properties)) base.properties = {};
  delete (base.properties as AnyObject).environmentId;
  if (Array.isArray(base.required)) {
    base.required = base.required.filter((r: unknown) => r !== 'environmentId');
    if (base.required.length === 0) delete base.required;
  }
  return base as Tool['inputSchema'];
}

/** Is this tool forbidden for a bridge caller, whatever the node declared? */
export function isForbiddenForBridge(name: string): boolean {
  if (FORBIDDEN_TOOLS.has(name)) return true;
  if (FORBIDDEN_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  const rule = getDataToolRule(name);
  if (rule && FORBIDDEN_RESOURCES.has(rule.resource)) return true;
  if (!CALLER_TRUST_FIX_PRESENT && NETWORK_TOOLS.has(name)) return true;
  return false;
}

/**
 * Build the served tool table: what the node declared, intersected with the
 * native registry, minus everything forbidden. MCP- and graph-sourced tools are
 * not bridged: their own transports have their own trust stories.
 */
export function buildBridgeToolTable(resolvedTools: RunBridgeToolRef[]): Tool[] {
  const registry = getNativeRegistry();
  const registered = new Set(registry.listTools().map((t) => t.name));
  const seen = new Set<string>();
  const out: Tool[] = [];

  for (const tool of resolvedTools) {
    const name = tool?.name;
    if (typeof name !== 'string' || !name) continue;
    if (seen.has(name)) continue;
    if (tool.source && tool.source !== 'native') continue;
    if (!registered.has(name)) continue;
    if (isForbiddenForBridge(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: tool.description ?? registry.get(name)?.description ?? '',
      inputSchema: stripEnvironmentIdFromSchema(tool.inputSchema ?? registry.get(name)?.inputSchema),
    });
  }
  return out;
}

/**
 * Deep-scrub credential shapes out of a value on its way to the run archive.
 *
 * Depth-bounded: a hostile child can nest JSON as deep as `JSON.parse` will go,
 * and an unbounded walk of that is a stack overflow in the worker.
 */
export function scrubValueForPublish(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubSecretsForPublish(value);
  if (depth >= MAX_SCRUB_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((item) => scrubValueForPublish(item, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const inner = value[key];
      // A key that NAMES a credential redacts its value whatever the shape:
      // `_secrets` is an object, an `apiKey` is a string with no pattern, and
      // both are the model's to choose as a tool argument.
      if (isSecretKey(key) && inner !== null && inner !== undefined && typeof inner !== 'number' && typeof inner !== 'boolean') {
        out[key] = SCRUBBED;
        continue;
      }
      out[key] = scrubValueForPublish(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * What actually gets published as a tool event's `input`: scrubbed, and bounded
 * in bytes. Over the bound it collapses to a marker plus a prefix, because the
 * alternative is letting a peer choose how many megabytes land in the archive.
 */
export function boundPublishedInput(raw: unknown, maxBytes: number): unknown {
  let scrubbed: unknown;
  let json: string;
  // The scrub is INSIDE the try: it reads every own property of the value, and
  // a getter that throws (or any exotic object) would otherwise take the whole
  // publish down instead of degrading to a marker. `JSON.stringify` throws on
  // its own for a BigInt. Cycles do NOT reach here — `MAX_SCRUB_DEPTH` severs
  // them during the scrub — so this branch is for the hostile-value cases.
  try {
    scrubbed = scrubValueForPublish(raw);
    json = JSON.stringify(scrubbed) ?? 'null';
  } catch {
    return { _bridgeTruncated: true, _reason: 'unserialisable' };
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes <= maxBytes) return scrubbed;
  return {
    _bridgeTruncated: true,
    _bytes: bytes,
    preview: Buffer.from(json, 'utf8').subarray(0, maxBytes).toString('utf8'),
  };
}

/**
 * True when a JSON-RPC `id` is one this server is willing to echo.
 *
 * An allowlist, not a blocklist: JSON-RPC 2.0 permits a string, a number or
 * null, and every response repeats the id verbatim. A short string or a finite
 * number costs a bounded number of bytes to repeat; an object, an array, or a
 * 5000-character string is a peer choosing how many bytes leave the worker on
 * every frame it sends. `null`/absent never reaches here — that is a
 * notification, and notifications are not answered at all.
 */
export function isEchoableRpcId(id: unknown): id is string | number {
  if (typeof id === 'number') return Number.isFinite(id);
  return typeof id === 'string' && id.length <= MAX_RPC_ID_CHARS;
}

/** Bound an attacker-supplied name before it reaches a message or the archive. */
export function echoName(name: string): string {
  if (typeof name !== 'string' || !name) return '(missing)';
  return name.length > MAX_ECHOED_NAME ? `${name.slice(0, MAX_ECHOED_NAME)}…` : name;
}

function generateBridgeToolId(name: string, seq: number): string {
  return `tool_bridge_${name}_${Date.now()}_${seq}_${crypto.randomBytes(3).toString('hex')}`;
}

/** Constant-time nonce comparison over fixed-length digests. */
function nonceMatches(given: string, expected: string): boolean {
  try {
    const a = crypto.createHash('sha256').update(String(given), 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Where the compiled shim lives next to this module. */
function resolveShimPath(): string {
  try {
    if (typeof require === 'function' && typeof require.resolve === 'function') {
      return require.resolve('./run-bridge-shim');
    }
  } catch {
    /* fall through */
  }
  const base = typeof __dirname === 'string' ? __dirname : path.join(process.cwd(), 'dist/lib/mcp');
  return path.join(base, 'run-bridge-shim.js');
}

/** Scrub a native tool result for publication without touching the original. */
export function scrubResultForPublish(result: unknown): unknown {
  if (!isPlainObject(result) || !Array.isArray((result as AnyObject).content)) return result;
  const src = result as AnyObject;
  return {
    ...src,
    content: (src.content as AnyObject[]).map((block) =>
      block && block.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: scrubSecretsForPublish(block.text) }
        : block,
    ),
  };
}

/**
 * Assert that the context this bridge is about to dispatch with really reads as
 * untrusted under the merged caller-trust contract.
 *
 * `untrustedCaller: true` is the whole reason `fetch_url` / `scrape_url` /
 * `web_search` are servable at all: it is what stops a model-chosen URL from
 * borrowing `INTERNAL_SERVICE_KEY` and what turns off the `SSRF_ALLOW_HOSTS`
 * escape hatch. Setting a boolean and hoping is not enough — if that property
 * is ever renamed, every bridge call silently becomes a TRUSTED call with a
 * model-chosen destination. So the flag is read back through the same
 * predicate the tools use, and a mismatch fails the call instead.
 */
export function assertUntrustedContext(context: NativeToolContext): void {
  if (callerIsTrusted(context)) {
    throw new Error(
      'run-bridge: refusing to dispatch — the bridge context does not read as untrusted. ' +
        'The caller-trust contract changed under this module; see lib/tools/native/_outbound-url.',
    );
  }
}

/**
 * Await one run-archive write under a deadline.
 *
 * Publishing is a network write and it is not on the critical path of the tool
 * call: a write that misses {@link PUBLISHER_TIMEOUT_MS} is logged and
 * abandoned. Errors are swallowed for the same reason — a broken archive must
 * not turn a successful tool call into an error the model has to reason about.
 */
async function publishBounded(label: string, work: Promise<void> | void): Promise<void> {
  if (!work || typeof (work as Promise<void>).then !== 'function') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work as Promise<void>,
      new Promise<void>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PUBLISHER_TIMEOUT_MS} ms`)),
          PUBLISHER_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
  } catch (err) {
    console.warn(`[RunBridge] publisher ${label} failed:`, err instanceof Error ? err.message : err);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// =============================================================================
// Orphan cleanup
// =============================================================================

/**
 * Sockets and step directories a live bridge owns, keyed by socket path.
 *
 * `close()` unlinks both, and libuv unlinks the socket when the server handle
 * closes — but neither runs if the worker dies between `listen()` and `close()`
 * (an uncaught exception, an OOM kill of the step, `process.exit` from a fatal
 * path). What is left behind is a step directory that holds the CLI's
 * `mcp.json`, and that file holds the run's nonce. Registering here gives the
 * process one best-effort sweep on the way out.
 */
const ACTIVE_BRIDGE_PATHS = new Map<string, { dir: string }>();
let exitHookInstalled = false;

/**
 * Unlink every socket + step directory a live bridge still owns. Synchronous
 * on purpose: it runs from `process.on('exit')`, where nothing async survives.
 * Exported so a worker can sweep on its own shutdown path, and so the sweep is
 * testable without emitting a process event.
 */
export function cleanupOrphanedBridges(): void {
  for (const [socketPath, entry] of ACTIVE_BRIDGE_PATHS) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(entry.dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  ACTIVE_BRIDGE_PATHS.clear();
}

function registerForExitCleanup(socketPath: string, dir: string): void {
  ACTIVE_BRIDGE_PATHS.set(socketPath, { dir });
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // ONE listener for every bridge this process ever starts, so a worker running
  // many concurrent steps cannot trip `MaxListenersExceededWarning`.
  //
  // `exit` only. A `SIGTERM`/`SIGINT` listener would SUPPRESS the default
  // termination for the entire worker process, which is not this module's
  // decision to make.
  process.on('exit', cleanupOrphanedBridges);
}

/**
 * Refuse a step directory that `close({ removeDir: true })` must not be pointed
 * at. `close` ends in `fs.rmSync(dir, { recursive: true, force: true })`, and
 * the caller supplies `dir`, so an empty string, a relative path or a top-level
 * directory is worth failing on at construction rather than at teardown.
 */
function assertUsableStepDir(dir: unknown): string {
  if (typeof dir !== 'string' || !dir.trim()) {
    throw new Error('run-bridge: `dir` is required');
  }
  const resolved = path.resolve(dir);
  if (!path.isAbsolute(dir)) {
    throw new Error(`run-bridge: \`dir\` must be an absolute path: ${dir}`);
  }
  // `/x` splits to ['', 'x'] — two segments, one of them empty. A step dir is
  // always nested at least one level below a container (`<tmp>/<run>/<step>`).
  const segments = resolved.split(path.sep).filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`run-bridge: \`dir\` is too close to the filesystem root to remove: ${resolved}`);
  }
  return resolved;
}

// =============================================================================
// The bridge
// =============================================================================

/**
 * Start a per-run MCP server on a Unix socket inside `dir`.
 *
 * Resolves once the socket is listening; the returned handle carries the nonce,
 * the ready-made `mcp.json` object and the exact tool list that was served, so
 * the caller can assert on the CLI's `system/init` event before spending a turn.
 */
export async function startRunToolBridge(
  options: StartRunToolBridgeOptions,
): Promise<RunToolBridge> {
  const {
    runId,
    state,
    publisher,
    resolvedTools,
    environmentId,
    workingDir = '/workspace',
    abortSignal,
    neuronStepId,
    dir,
    credentials,
    maxToolIterations,
    onFatal,
    onCancel,
    authDeadlineMs = AUTH_DEADLINE_MS,
  } = options;

  const tools = buildBridgeToolTable(resolvedTools ?? []);
  const toolsByName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
  const nonce = crypto.randomBytes(32).toString('hex');
  const iterations =
    typeof maxToolIterations === 'number' && Number.isFinite(maxToolIterations) && maxToolIterations > 0
      ? maxToolIterations
      : DEFAULT_MAX_TOOL_ITERATIONS;
  const maxCalls = Math.min(Math.floor(iterations) * 4 + 8, MAX_CALLS_CEILING);

  // The step directory is the access control: 0700 there makes 0600 on the
  // socket. We deliberately do NOT flip the process-global umask around
  // `listen()` — the worker runs concurrent steps in one process, so a global
  // umask window is a race that could loosen an unrelated file. Explicit modes
  // give the same result deterministically.
  const stepDir = assertUsableStepDir(dir);
  fs.mkdirSync(stepDir, { recursive: true, mode: 0o700 });
  // An EXISTING directory keeps whatever mode it had, so re-assert it: 0700 on
  // the directory is what makes the socket unreachable to another uid, and it
  // is the half of the story that is not a race (the socket is chmod'ed after
  // `listen`, and the window between the two is covered by this).
  fs.chmodSync(stepDir, 0o700);

  const socketPath = path.join(stepDir, 'bridge.sock');
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH) {
    throw new Error(
      `run-bridge: socket path too long (${Buffer.byteLength(socketPath)} > ${MAX_SOCKET_PATH}): ${socketPath}`,
    );
  }
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* no stale socket */
  }

  const stats: RunBridgeStats = { callsTotal: 0, denied: 0, authFailures: 0, capped: 0 };
  const sockets = new Set<net.Socket>();
  /**
   * Read-flow state per peer.
   *
   * Two independent reasons to stop reading — the peer is not draining our
   * writes (`writeBlocked`), and the frame pump is yielding the event loop
   * (`pumpYield`) — so they are tracked separately and reconciled by
   * `syncFlow`, or one would clobber the other's resume.
   */
  const peerFlow = new WeakMap<net.Socket, { writeBlocked: boolean; pumpYield: boolean; syncFlow(): void }>();
  let inflight = 0;
  let seq = 0;
  let revoked = false;
  let revokedReason: string | null = null;
  let closed = false;
  let unregisterCancel: () => void = () => {};
  let abortHandler: (() => void) | null = null;

  const server = net.createServer();
  // Node destroys anything past this before `connection` even fires, so the
  // ceiling holds whether or not the handler below ever runs.
  server.maxConnections = MAX_CONNECTIONS;

  function revoke(reason: string): void {
    if (revoked) return;
    revoked = true;
    revokedReason = reason;
    console.warn(`[RunBridge] session revoked for run ${runId}: ${reason}`);
    for (const s of sockets) {
      try {
        s.destroy();
      } catch {
        /* ignore */
      }
    }
    sockets.clear();
    try {
      server.close();
    } catch {
      /* ignore */
    }
  }

  function fatal(err: Error): void {
    revoke(err.message);
    try {
      onFatal?.(err);
    } catch (hookErr) {
      console.warn('[RunBridge] onFatal hook threw:', hookErr);
    }
  }

  async function close(opts?: { removeDir?: boolean }): Promise<void> {
    const removeDir = opts?.removeDir !== false;
    if (!closed) {
      closed = true;
      revoke(revokedReason ?? 'closed');
      unregisterCancel();
      if (abortHandler && abortSignal) {
        try {
          abortSignal.removeEventListener('abort', abortHandler);
        } catch {
          /* ignore */
        }
        abortHandler = null;
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      fs.unlinkSync(socketPath);
    } catch {
      /* already gone */
    }
    if (removeDir) {
      try {
        fs.rmSync(stepDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[RunBridge] failed to remove step dir ${stepDir}:`, err);
      }
    }
    // Whatever `removeDir` said, this bridge no longer needs the exit sweep:
    // either the directory is gone, or the caller asked to keep it.
    ACTIVE_BRIDGE_PATHS.delete(socketPath);
  }

  // ── JSON-RPC plumbing ──────────────────────────────────────────────────────

  function reply(socket: net.Socket, id: string | number, result: unknown): void {
    write(socket, { jsonrpc: '2.0', id, result });
  }

  function replyError(socket: net.Socket, id: string | number, error: JsonRpcError): void {
    write(socket, { jsonrpc: '2.0', id, error });
  }

  function write(socket: net.Socket, payload: JsonRpcResponse): void {
    if (socket.destroyed) return;
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch (err) {
      // A native tool may return something `JSON.stringify` refuses (a BigInt,
      // a cyclic structure). Dropping the response would hang the client on an
      // id it will never see, so answer with a well-formed error instead.
      console.warn('[RunBridge] response is not serialisable:', err);
      line = `${JSON.stringify({
        jsonrpc: '2.0',
        id: (payload as AnyObject).id ?? 0,
        error: { code: -32603, message: 'Internal error: tool result is not serialisable' },
      })}\n`;
    }
    try {
      // Backpressure. `socket.write` returning false means the kernel buffer is
      // full and Node is now buffering in the heap with no bound of its own, so
      // stop reading from this peer until it drains. A peer that never drains
      // is not a client, and past the ceiling it is dropped.
      if (!socket.write(line)) {
        const flow = peerFlow.get(socket);
        if (flow) {
          flow.writeBlocked = true;
          flow.syncFlow();
        }
      }
      if (socket.writableLength > MAX_WRITE_BACKLOG_BYTES) {
        console.warn(
          `[RunBridge] peer write backlog over ${MAX_WRITE_BACKLOG_BYTES} bytes; dropping peer`,
        );
        socket.destroy();
      }
    } catch (err) {
      console.warn('[RunBridge] failed to write response:', err);
    }
  }

  /**
   * Audit a refused call onto the run record as a started-then-errored tool, so
   * a bridge denial is as visible as a capability denial. The `bridge`/`denied`
   * flags are for a caller that wants to key off them (tests, a future UI); the
   * real `RunPublisher` ignores unknown option keys, so the durable signal is
   * the tool name plus the `bridge denied: …` error text.
   */
  async function auditDenial(name: string, args: unknown, reason: string): Promise<void> {
    if (!publisher) return;
    const safeName = echoName(name);
    // The tool id embeds the name, so it is built from the BOUNDED one.
    const toolId = generateBridgeToolId(safeName, ++seq);
    try {
      // NOTHING here is trusted: the name and the args are whatever the peer
      // put on the wire, they never passed a schema, and this is the path a
      // hostile child would spam. Both are bounded, and the args are scrubbed
      // as well — a credential the model passes as an ARGUMENT would otherwise
      // reach the archive in the clear while the same string in a result is
      // redacted.
      await publishBounded(
        'toolStart(denied)',
        publisher.toolStart(toolId, safeName, 'native', {
          input: boundPublishedInput(args, MAX_DENIED_INPUT_BYTES),
          triggeredBy: 'neuron',
          neuronStepId,
          bridge: true,
          denied: true,
        }),
      );
      await publishBounded(
        'toolError(denied)',
        publisher.toolError(toolId, reason, { triggeredBy: 'neuron', neuronStepId }),
      );
    } catch (err) {
      console.warn('[RunBridge] failed to publish denial audit:', err);
    }
  }

  /**
   * Charge one `tools/call` frame against BOTH caps, then dispatch it.
   *
   * The budget and the concurrency limit are applied here, together, and both
   * cover the denial path as well as the accepted one. Charging only the
   * accepted path left a real hole: `handleRequest` is fire-and-forget, so a
   * child that pipelines `maxCalls` bogus names had that many `auditDenial`
   * calls — two `RunPublisher` writes and two 15 s timers each — in flight at
   * once, because a denial returned before `inflight` was ever incremented.
   * One counter, incremented before the first `await` and released in a
   * `finally`, is what makes "at most four archive conversations at a time"
   * true for every branch instead of just the happy one.
   */
  async function handleToolsCall(
    params: AnyObject | undefined,
  ): Promise<CallToolResult | { rpcError: JsonRpcError }> {
    // ── The caps come FIRST, before the allowlist and before the args check ──
    // Those two branches each publish a `tool_start` and a `tool_error` to the
    // run archive, and an unknown tool name with a multi-megabyte argument blob
    // is the cheapest frame a hostile child can produce. Checking the caps
    // after them made the denial path the one path in this bridge with no
    // budget and no bound: a loop of `{"name":"nope","arguments":{"pad":<7MB>}}`
    // bought two concurrent archive writes per frame, forever.
    if (stats.callsTotal >= maxCalls) {
      stats.capped += 1;
      return {
        content: [
          {
            type: 'text',
            text:
              `Error: tool budget exhausted for this step (${maxCalls} calls). ` +
              'Summarise what you have and finish without further tool calls.',
          },
        ],
        isError: true,
      };
    }

    if (inflight >= MAX_INFLIGHT_CALLS) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: too many concurrent tool calls (max ${MAX_INFLIGHT_CALLS}). Retry this call sequentially.`,
          },
        ],
        isError: true,
      };
    }

    // Charged here, synchronously, before the first `await`: every frame that
    // gets past the caps costs one unit of budget AND one concurrency slot,
    // whether it is served or denied. (A frame the cap itself refused is not
    // charged — otherwise a capped session could never report a stable
    // `callsTotal`.)
    stats.callsTotal += 1;
    inflight += 1;
    try {
      return await dispatchToolsCall(params);
    } finally {
      inflight -= 1;
    }
  }

  /** The body of an accepted-into-the-caps `tools/call`. */
  async function dispatchToolsCall(
    params: AnyObject | undefined,
  ): Promise<CallToolResult | { rpcError: JsonRpcError }> {
    const name = typeof params?.name === 'string' ? params.name : '';
    const rawArgs = params?.arguments;

    if (!name || !toolsByName.has(name)) {
      stats.denied += 1;
      const reason = `Tool '${echoName(name)}' is not available to this run.`;
      await auditDenial(name, rawArgs, `bridge denied: ${reason}`);
      return { rpcError: { code: -32602, message: reason } };
    }

    if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
      stats.denied += 1;
      const reason = `Invalid arguments for '${echoName(name)}': expected a JSON object.`;
      await auditDenial(name, rawArgs, `bridge denied: ${reason}`);
      return { rpcError: { code: -32602, message: reason } };
    }

    const served = toolsByName.get(name)!;
    let args = stripPrototypeKeys(isPlainObject(rawArgs) ? rawArgs : {});

    try {
      args = coerceArgsToSchema(args, served.inputSchema as AnyObject);
      args = stripPrototypeKeys(args);
    } catch (err) {
      console.warn(`[RunBridge] arg coercion failed for '${name}' (using raw args):`, err);
    }

    // The pin. Unconditional: an env id the CLI supplied is discarded, and a
    // session with no environment cannot address one at all.
    if (environmentId) {
      args.environmentId = environmentId;
    } else {
      delete args.environmentId;
    }

    const schemaProps = (served.inputSchema as AnyObject)?.properties as AnyObject | undefined;
    const effectiveWorkingDir = workingDir || '/workspace';
    if (effectiveWorkingDir) {
      if (schemaProps?.cwd && (args.cwd === undefined || args.cwd === '')) args.cwd = effectiveWorkingDir;
      if (schemaProps?.workingDir && (args.workingDir === undefined || args.workingDir === '')) {
        args.workingDir = effectiveWorkingDir;
      }
    }

    const toolId = generateBridgeToolId(name, ++seq);

    try {
      if (publisher) {
        await publishBounded(
          'toolStart',
          publisher.toolStart(toolId, name, 'native', {
            // Scrubbed and bounded, exactly like the result at `toolComplete`:
            // an API key handed to a tool as an argument is the same secret in
            // the same archive as one that comes back in a result.
            input: boundPublishedInput(args, MAX_PUBLISHED_INPUT_BYTES),
            triggeredBy: 'neuron',
            neuronStepId,
            bridge: true,
          }),
        );
      }

      // `untrustedCaller` is the property `lib/tools/caller-trust`,
      // `_outbound-url` and every URL-taking tool read. It is now a declared
      // member of `NativeToolContext` (PR #378 landed), so this is typed as the
      // plain interface — the intersection this file used to carry would have
      // let a RENAME of the property typecheck while silently making every
      // bridge call a trusted one.
      const context: NativeToolContext = {
        publisher: null,
        state: state as AnyObject,
        runId,
        nodeId: null,
        toolId,
        abortSignal: abortSignal ?? null,
        credentials: (credentials ?? null) as NativeToolContext['credentials'],
        untrustedCaller: true,
      };
      // Belt: read the flag back through the predicate the tools use.
      assertUntrustedContext(context);

      // Deliberately NOT wrapped in a timeout. A tool owns its own deadline
      // (`run_command` reads `RUN_COMMAND_DEFAULT_TIMEOUT_MS` for itself since
      // PR #379), it is handed the run's `abortSignal`, and a hung tool costs one of
      // `MAX_INFLIGHT_CALLS` slots rather than the session. A blanket deadline
      // here would kill legitimate long work with no way for a node to opt out.
      const result = await getNativeRegistry().callTool(name, args, context);

      if (publisher) {
        await publishBounded(
          'toolComplete',
          publisher.toolComplete(
            toolId,
            // Two passes, and both are load-bearing. `scrubResultForPublish`
            // knows the MCP content shape; `boundPublishedInput` then scrubs
            // EVERY remaining string (a secret in `structuredContent` or any
            // other field the spread carried through), redacts credential-named
            // keys, and caps the size — a result is as caller-chosen as an
            // argument, and it was the one half of the call the module contract
            // claimed to bound but did not.
            boundPublishedInput(scrubResultForPublish(result), MAX_PUBLISHED_RESULT_BYTES),
            { neuronStep: neuronStepId, bridge: true },
            { triggeredBy: 'neuron', neuronStepId },
          ),
        );
      }
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (publisher) {
        await publishBounded(
          'toolError',
          publisher.toolError(toolId, message, { triggeredBy: 'neuron', neuronStepId }),
        );
      }
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  }

  async function handleRequest(socket: net.Socket, req: JsonRpcRequest): Promise<void> {
    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;

    if (isNotification) return;

    // The id is echoed on EVERY response, including the cheap error ones, so a
    // peer that names itself with a megabyte gets that megabyte back on every
    // frame out of the worker's heap, for free — and `ping` is not charged
    // against the call budget, so it can do it forever.
    //
    // JSON-RPC 2.0 says an id is a string, a number or null. Bounding only the
    // STRING case left the hole open one type over: `{"id":{...5000 chars...}}`
    // is not a string, skipped the check, and came back in full. So this is an
    // allowlist — a short string or a finite number — and everything else is an
    // invalid request answered with a constant-size frame.
    if (!isEchoableRpcId(id)) {
      replyError(socket, 0, {
        code: -32600,
        message: `Invalid Request: id must be a number or a string of at most ${MAX_RPC_ID_CHARS} characters`,
      });
      return;
    }

    if (revoked) {
      replyError(socket, id, { code: -32000, message: `Session revoked: ${revokedReason}` });
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = (params as AnyObject | undefined)?.protocolVersion;
        // The handshake echoes the client's version, so bound and shape it
        // first — same reason as the id above.
        const echoable =
          typeof requested === 'string' &&
          requested.length > 0 &&
          requested.length <= MAX_PROTOCOL_VERSION_CHARS &&
          PROTOCOL_VERSION_PATTERN.test(requested);
        reply(socket, id, {
          protocolVersion: echoable ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: BRIDGE_SERVER_NAME, version: '1.0.0' },
        });
        return;
      }
      case 'ping':
        reply(socket, id, {});
        return;
      case 'tools/list':
        reply(socket, id, { tools });
        return;
      case 'resources/list':
        reply(socket, id, { resources: [] });
        return;
      case 'prompts/list':
        reply(socket, id, { prompts: [] });
        return;
      case 'tools/call': {
        const outcome = await handleToolsCall(params as AnyObject | undefined);
        if ('rpcError' in outcome) replyError(socket, id, outcome.rpcError);
        else reply(socket, id, outcome);
        return;
      }
      default:
        replyError(socket, id, { code: -32601, message: `Method not found: ${method}` });
    }
  }

  // ── Connections ────────────────────────────────────────────────────────────

  server.on('connection', (socket) => {
    // Belt for `maxConnections` above: the ceiling is enforced twice, once by
    // Node against its own connection count and once against the set we hold.
    if (revoked || sockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.setNoDelay(true);

    let authed = false;
    let buffer = '';
    /**
     * Chunk boundaries do not respect UTF-8. `chunk.toString('utf8')` on a
     * buffer that ends mid-character yields U+FFFD and corrupts the frame,
     * which is a real bug for any tool argument carrying non-ASCII text. The
     * decoder holds the trailing bytes until the rest of the character lands.
     */
    const decoder = new StringDecoder('utf8');

    /** Read-flow state for this peer; see `peerFlow`. */
    const flow = {
      writeBlocked: false,
      pumpYield: false,
      syncFlow(): void {
        if (socket.destroyed) return;
        const shouldPause = flow.writeBlocked || flow.pumpYield;
        if (shouldPause && !socket.isPaused()) socket.pause();
        else if (!shouldPause && socket.isPaused()) socket.resume();
      },
    };
    peerFlow.set(socket, flow);

    /**
     * An unauthenticated peer gets a few seconds and a few kilobytes.
     *
     * Without a deadline a peer that connects and says nothing — or that
     * dribbles bytes with no newline — holds a socket and its receive buffer
     * for the life of the step, against a heap shared with every other step on
     * the replica. `unref` so a pending deadline never keeps the worker alive.
     */
    let authTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      authTimer = null;
      if (!authed) failAuth(`no valid auth frame within ${authDeadlineMs} ms`);
    }, authDeadlineMs);
    authTimer.unref?.();

    const clearAuthTimer = (): void => {
      if (authTimer) {
        clearTimeout(authTimer);
        authTimer = null;
      }
    };

    function failAuth(why: string): void {
      clearAuthTimer();
      stats.authFailures += 1;
      console.warn(`[RunBridge] auth failure (${stats.authFailures}/${MAX_AUTH_FAILURES}) for run ${runId}: ${why}`);
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (stats.authFailures >= MAX_AUTH_FAILURES) {
        fatal(
          new Error(
            `run-bridge: ${stats.authFailures} failed authentication attempts on run ${runId}; session revoked`,
          ),
        );
      }
    }

    /**
     * Consume one complete line. Returns `false` when the peer is gone and the
     * pump must stop touching it.
     */
    function handleLine(line: string): boolean {
      if (!line) {
        // A blank line is free to send and free to ignore, which made it a
        // way to keep an unauthenticated socket alive without ever failing
        // auth. After auth it stays what it always was: noise.
        if (!authed) {
          failAuth('blank line before the auth frame');
          return false;
        }
        return true;
      }

      if (!authed) {
        let frame: AnyObject | null = null;
        try {
          frame = JSON.parse(line);
        } catch {
          failAuth('first line is not JSON');
          return false;
        }
        if (!frame || frame.redbtn !== 'auth' || typeof frame.nonce !== 'string') {
          failAuth('first line is not an auth frame');
          return false;
        }
        if (!nonceMatches(frame.nonce, nonce)) {
          failAuth('nonce mismatch');
          return false;
        }
        authed = true;
        clearAuthTimer();
        return true;
      }

      let req: JsonRpcRequest;
      try {
        req = JSON.parse(line) as JsonRpcRequest;
      } catch {
        write(socket, {
          jsonrpc: '2.0',
          id: 0,
          error: { code: -32700, message: 'Parse error' },
        });
        return !socket.destroyed;
      }
      // Dispatched concurrently, on purpose: an MCP client matches responses
      // by `id`, Claude emits parallel `tool_use` blocks, and serialising here
      // would both stall those and make the inflight cap unreachable. The
      // cap is what bounds concurrency, and it is checked and incremented
      // with no `await` between the two, so a burst cannot race past it.
      void handleRequest(socket, req).catch((err) => {
        console.warn('[RunBridge] request handler threw:', err);
      });
      return !socket.destroyed;
    }

    /**
     * Drain complete lines from `buffer` — at most `MAX_FRAMES_PER_TICK` per
     * event-loop turn.
     *
     * The old loop drained the WHOLE buffer synchronously, so one 8 MB write of
     * one-byte frames bought hundreds of thousands of `JSON.parse` calls in a
     * single tick: an event-loop stall on a worker that is also running other
     * steps, timers and sockets. Yielding costs a tick per batch and gives the
     * rest of the process a turn. The socket is paused across the yield so the
     * buffer cannot grow while the pump is away.
     */
    function pump(): void {
      if (socket.destroyed) return;
      let processed = 0;
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        if (processed >= MAX_FRAMES_PER_TICK) {
          flow.pumpYield = true;
          flow.syncFlow();
          setImmediate(() => {
            flow.pumpYield = false;
            pump();
          });
          return;
        }
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        processed += 1;
        if (!handleLine(line)) return;
        idx = buffer.indexOf('\n');
      }
      flow.pumpYield = false;
      flow.syncFlow();
    }

    socket.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > MAX_FRAME_BYTES) {
        console.warn(`[RunBridge] frame over ${MAX_FRAME_BYTES} bytes; dropping peer`);
        socket.destroy();
        return;
      }
      // Before auth the peer is a stranger, and the only frame a stranger gets
      // read is the auth frame (~90 bytes). Bound the FIRST LINE, not the whole
      // buffer: a legitimate client may pipeline its auth frame and its first
      // request into one chunk, and dropping that would be a bug. A stranger
      // that dribbles bytes with no newline is measured the same way, so it can
      // never accumulate its way to `MAX_FRAME_BYTES`.
      if (!authed) {
        const firstBreak = buffer.indexOf('\n');
        const firstLineBytes = firstBreak === -1 ? buffer.length : firstBreak;
        if (firstLineBytes > MAX_PREAUTH_BYTES) {
          failAuth(`auth frame over ${MAX_PREAUTH_BYTES} bytes`);
          return;
        }
      }
      pump();
    });

    // The peer drained what we wrote: it may be read from again.
    socket.on('drain', () => {
      flow.writeBlocked = false;
      flow.syncFlow();
    });

    socket.on('error', (err) => {
      console.warn('[RunBridge] socket error:', err?.message ?? err);
    });
    socket.on('close', () => {
      clearAuthTimer();
      sockets.delete(socket);
      peerFlow.delete(socket);
    });
  });

  server.on('error', (err) => {
    console.warn(`[RunBridge] server error for run ${runId}:`, err);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);
  // From here on the socket and the step directory exist on disk. `close()`
  // removes both; this covers the paths where `close()` never runs.
  registerForExitCleanup(socketPath, stepDir);

  // Cancellation: one registration does all three jobs — kill the CLI child
  // (the executor's callback), revoke the session, close the server.
  unregisterCancel = runControlRegistry.registerOnCancel(runId, () => {
    try {
      onCancel?.();
    } catch (err) {
      console.warn('[RunBridge] onCancel hook threw:', err);
    }
    revoke('run cancelled');
  });

  if (abortSignal) {
    if (abortSignal.aborted) {
      revoke('run aborted');
    } else {
      abortHandler = () => revoke('run aborted');
      abortSignal.addEventListener('abort', abortHandler, { once: true });
    }
  }

  const shimPath = resolveShimPath();
  const mcpConfig = {
    mcpServers: {
      [BRIDGE_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args: [shimPath],
        env: {
          REDBTN_BRIDGE_SOCK: socketPath,
          REDBTN_BRIDGE_NONCE: nonce,
        },
      },
    },
  };

  return {
    socketPath,
    nonce,
    shimPath,
    mcpConfig,
    toolNames: tools.map((t) => t.name),
    tools,
    stats,
    get revoked() {
      return revoked;
    },
    get revokedReason() {
      return revokedReason;
    },
    maxCalls,
    revoke,
    close,
  };
}
