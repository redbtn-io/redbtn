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
 *   3. `cwd` / `workingDir` default to the session's workingDir; `run_command`
 *      gets a default `timeout` so a hung command cannot pin a relay forever.
 *   4. Every dispatch goes through `NativeToolRegistry.callTool` — never a
 *      handler directly — so the capability profile, the fail-closed exec gate,
 *      the kill switches, `EXEC_RATE_MAX` and the fail-closed audit all apply
 *      exactly as they do for an API neuron.
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
 *      exactly as much as one that comes back in a result.
 *   7. Every `tools/call` frame is charged against the session budget BEFORE
 *      the allowlist and the args check, so the two denial branches — the
 *      cheapest frames an attacker can send, and the ones that publish two
 *      run-archive writes each — are capped like everything else.
 *   8. Attacker-controlled bytes (a bogus tool name, an unvalidated args blob)
 *      are truncated on their way into an error message or the archive.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

// =============================================================================
// Constants
// =============================================================================

/** MCP revision we speak when the client does not name one. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';

/** Server identity reported in `initialize`. */
export const BRIDGE_SERVER_NAME = 'redbtn';

/** Max bytes of a single newline-delimited frame before the peer is dropped. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Failed auth frames tolerated before the whole session is revoked. */
const MAX_AUTH_FAILURES = 3;

/** Concurrent `tools/call` dispatches allowed per session. */
const MAX_INFLIGHT_CALLS = 4;

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

/** Default `--max-turns` assumption when the node does not set one. */
const DEFAULT_MAX_TOOL_ITERATIONS = 50;

/** Default `run_command` timeout injected when the CLI omits one (ms). */
const DEFAULT_RUN_COMMAND_TIMEOUT_MS = 300_000;

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
 *   - `send_webhook` — arbitrary `url` + `method` + `headers` + `body`, no SSRF
 *     blocklist, and unmapped in `tool-map`, so it gets neither the capability
 *     check (`native-registry.ts` `enforceToolCapability`) nor the exec guard.
 *     It is precisely the model-chooses-the-destination egress primitive, with
 *     a request body attached. (`send_email` is a fixed relay — the model picks
 *     a recipient, not a host — and is left servable; if that is judged too
 *     generous it belongs in this list too.)
 *   - `alert_desktop` and every `desktop_*` tool — see `FORBIDDEN_TOOL_PREFIXES`.
 *   - `workspace_checkout` / `workspace_checkin` / `workspace_release` — the
 *     worker owns workspace lifecycle; a run must not move its own fence.
 *   - `create_neuron` / `update_neuron` / `delete_neuron` — self-modification
 *     of the model layer that runs the next step.
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
 */
export const NETWORK_TOOLS: ReadonlySet<string> = new Set([
  'fetch_url',
  'scrape_url',
  'web_search',
]);

/**
 * True when this build carries the caller-trust / SSRF fix (engine PR #378).
 *
 * Detected rather than declared, and it fails SAFE: any doubt (module missing,
 * `require` unavailable under an ESM test runner, resolution throwing) reads as
 * "not present", which forbids the network tools.
 */
export const CALLER_TRUST_FIX_PRESENT: boolean = detectCallerTrustFix();

function detectCallerTrustFix(): boolean {
  try {
    // `require` is absent under an ESM loader; treat that as "unknown" ⇒ safe.
    if (typeof require !== 'function' || typeof require.resolve !== 'function') return false;
    require.resolve('../net/ssrf-guard');
    require.resolve('../tools/caller-trust');
    return true;
  } catch {
    return false;
  }
}

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
  /** Default `cwd` / `workingDir` for calls whose schema declares one. */
  workingDir: string;
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
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (PROTO_KEYS.has(key)) continue;
    out[key] = raw[key];
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
    for (const key of Object.keys(value)) out[key] = scrubValueForPublish(value[key], depth + 1);
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
  const scrubbed = scrubValueForPublish(raw);
  let json: string;
  try {
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
    workingDir,
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
    typeof maxToolIterations === 'number' && maxToolIterations > 0
      ? maxToolIterations
      : DEFAULT_MAX_TOOL_ITERATIONS;
  const maxCalls = iterations * 4 + 8;

  // The step directory is the access control: 0700 there makes 0600 on the
  // socket. We deliberately do NOT flip the process-global umask around
  // `listen()` — the worker runs concurrent steps in one process, so a global
  // umask window is a race that could loosen an unrelated file. Explicit modes
  // give the same result deterministically.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);

  const socketPath = path.join(dir, 'bridge.sock');
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
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[RunBridge] failed to remove step dir ${dir}:`, err);
      }
    }
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
    try {
      socket.write(`${JSON.stringify(payload)}\n`);
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
      await publisher.toolStart(toolId, safeName, 'native', {
        input: boundPublishedInput(args, MAX_DENIED_INPUT_BYTES),
        triggeredBy: 'neuron',
        neuronStepId,
        bridge: true,
        denied: true,
      });
      await publisher.toolError(toolId, reason, { triggeredBy: 'neuron', neuronStepId });
    } catch (err) {
      console.warn('[RunBridge] failed to publish denial audit:', err);
    }
  }

  async function handleToolsCall(
    params: AnyObject | undefined,
  ): Promise<CallToolResult | { rpcError: JsonRpcError }> {
    const name = typeof params?.name === 'string' ? params.name : '';
    const rawArgs = params?.arguments;

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
    // gets past the caps costs one unit of budget whether it is served or
    // denied. (A frame the cap itself refused is not charged — otherwise a
    // capped session could never report a stable `callsTotal`.)
    stats.callsTotal += 1;

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
    if (workingDir) {
      if (schemaProps?.cwd && (args.cwd === undefined || args.cwd === '')) args.cwd = workingDir;
      if (schemaProps?.workingDir && (args.workingDir === undefined || args.workingDir === '')) {
        args.workingDir = workingDir;
      }
    }
    if (name === 'run_command' && args.timeout === undefined) {
      args.timeout = DEFAULT_RUN_COMMAND_TIMEOUT_MS;
    }

    inflight += 1;
    const toolId = generateBridgeToolId(name, ++seq);

    try {
      if (publisher) {
        await publisher.toolStart(toolId, name, 'native', {
          // Scrubbed and bounded, exactly like the result at `toolComplete`:
          // an API key handed to a tool as an argument is the same secret in
          // the same archive as one that comes back in a result.
          input: boundPublishedInput(args, MAX_PUBLISHED_INPUT_BYTES),
          triggeredBy: 'neuron',
          neuronStepId,
          bridge: true,
        });
      }

      // `untrustedCaller` is what the caller-trust fix (PR #378) reads. It is
      // declared through an intersection rather than added to
      // `NativeToolContext` here so this file does not collide with that PR;
      // once it lands the property is simply part of the interface.
      const context: NativeToolContext & { untrustedCaller?: boolean } = {
        publisher: null,
        state: state as AnyObject,
        runId,
        nodeId: null,
        toolId,
        abortSignal: abortSignal ?? null,
        credentials: (credentials ?? null) as NativeToolContext['credentials'],
        untrustedCaller: true,
      };

      const result = await getNativeRegistry().callTool(name, args, context);

      if (publisher) {
        await publisher.toolComplete(
          toolId,
          scrubResultForPublish(result),
          { neuronStep: neuronStepId, bridge: true },
          { triggeredBy: 'neuron', neuronStepId },
        );
      }
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (publisher) {
        try {
          await publisher.toolError(toolId, message, { triggeredBy: 'neuron', neuronStepId });
        } catch (pubErr) {
          console.warn('[RunBridge] failed to publish tool error:', pubErr);
        }
      }
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    } finally {
      inflight -= 1;
    }
  }

  async function handleRequest(socket: net.Socket, req: JsonRpcRequest): Promise<void> {
    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;

    if (isNotification) return;

    if (revoked) {
      replyError(socket, id, { code: -32000, message: `Session revoked: ${revokedReason}` });
      return;
    }

    switch (method) {
      case 'initialize': {
        const requested = (params as AnyObject | undefined)?.protocolVersion;
        reply(socket, id, {
          protocolVersion: typeof requested === 'string' && requested ? requested : DEFAULT_PROTOCOL_VERSION,
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

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
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
      let idx = buffer.indexOf('\n');
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
        if (!line) {
          // A blank line is free to send and free to ignore, which made it a
          // way to keep an unauthenticated socket alive without ever failing
          // auth. After auth it stays what it always was: noise.
          if (!authed) {
            failAuth('blank line before the auth frame');
            return;
          }
          continue;
        }

        if (!authed) {
          let frame: AnyObject | null = null;
          try {
            frame = JSON.parse(line);
          } catch {
            failAuth('first line is not JSON');
            return;
          }
          if (!frame || frame.redbtn !== 'auth' || typeof frame.nonce !== 'string') {
            failAuth('first line is not an auth frame');
            return;
          }
          if (!nonceMatches(frame.nonce, nonce)) {
            failAuth('nonce mismatch');
            return;
          }
          authed = true;
          clearAuthTimer();
          continue;
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
          continue;
        }
        // Dispatched concurrently, on purpose: an MCP client matches responses
        // by `id`, Claude emits parallel `tool_use` blocks, and serialising here
        // would both stall those and make the inflight cap unreachable. The
        // cap is what bounds concurrency, and it is checked and incremented
        // with no `await` between the two, so a burst cannot race past it.
        void handleRequest(socket, req).catch((err) => {
          console.warn('[RunBridge] request handler threw:', err);
        });
      }
    });

    socket.on('error', (err) => {
      console.warn('[RunBridge] socket error:', err?.message ?? err);
    });
    socket.on('close', () => {
      clearAuthTimer();
      sockets.delete(socket);
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
