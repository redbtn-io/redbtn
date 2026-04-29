/**
 * Environments — Types
 *
 * # What this module is
 *
 * Type contracts for the EnvironmentManager subsystem. This is **Phase A** of
 * the Environments project (see `ENVIRONMENT-HANDOFF.md` §2 Phase A).
 *
 * The Environment primitive is a long-running, self-healing SSH/SFTP target
 * managed by the engine. Each Environment is a config document in MongoDB
 * (Phase B) plus an in-memory `EnvironmentSession` (this module). The
 * `EnvironmentManager` (sibling module) keeps a per-process `Map<envId,
 * session>` so coding-agent tools (fs pack — Phase C, process pack — Phase D)
 * get connection pooling and drop tolerance "for free."
 *
 * # Phase A scoping
 *
 * Phase A is **pure runtime** — no Mongoose, no REST, no secret resolution.
 * The manager receives a fully-resolved `IEnvironment` document plus the
 * already-resolved `sshKey: string` from the caller. Phase B will add the
 * Mongoose schema, REST API, secret-store integration, and access-check
 * plumbing. This separation keeps Phase A tiny, testable in isolation, and
 * decoupled from the schema/secrets infra Phase B introduces.
 *
 * # Stream parallels
 *
 * Environments share *patterns* with Streams (per-process registry, lifecycle
 * states, drop tolerance) but they are NOT Streams. They serve a different
 * purpose: SSH/SFTP targets for tool execution, not realtime voice/text
 * provider sessions.
 *
 * @module lib/environments/types
 */

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for an EnvironmentSession (see ENVIRONMENT-HANDOFF.md §3.1).
 *
 * Allowed transitions:
 *
 *   closed → opening → open → degraded → opening (reconnect) → open
 *                          \    \
 *                           \    \-- closed (after maxAttempts)
 *                            \
 *                             \-- closing → closed (idle/explicit/maxLifetime)
 *
 * - `closed`: No live SSH connection. Either never opened or torn down.
 * - `opening`: SSH handshake in progress (and optional `openCommand` running).
 * - `open`: Healthy session, ready for `exec` / `sftp*`.
 * - `degraded`: SSH connection dropped, reconnect attempts in progress.
 *               New ops queue into `pendingCommands` (bounded buffer).
 * - `closing`: Graceful close in progress (idle timer fired, maxLifetime hit,
 *              or explicit `close()` call). Drains in-flight ops then ends.
 */
export type EnvironmentLifecycleState =
  | 'closed'
  | 'opening'
  | 'open'
  | 'degraded'
  | 'closing';

// ---------------------------------------------------------------------------
// Environment configuration document
// ---------------------------------------------------------------------------

/**
 * Reconnect policy. Default values are applied by the manager — fields are
 * required at the type level so the schema (Phase B) can enforce defaults
 * upstream and the runtime never sees `undefined` here.
 */
export interface EnvironmentReconnectPolicy {
  /** Maximum reconnect attempts before flipping to `closed`. Default 5. */
  maxAttempts: number;
  /** Initial backoff in ms — attempt N waits min(backoffMs * 2^(N-1), maxBackoffMs). Default 2000. */
  backoffMs: number;
  /** Cap on per-attempt backoff. Default 30000 (30s). */
  maxBackoffMs: number;
}

/**
 * Environment configuration — the persistent shape that lives in Mongo
 * (Phase B). Phase A receives this from the caller fully resolved (no schema
 * defaults to apply).
 *
 * # Why `kind` is a discriminator
 *
 * v1 only supports `'self-hosted'` (user-supplied SSH target). Phase G adds
 * `'redbtn-hosted'` (system provisions an isolated cloud env on demand). Having
 * the discriminator from day one means Phase G doesn't require a schema
 * migration to add the new `kind`.
 *
 * # `secretRef` semantics
 *
 * `secretRef` is the *name* of the secret that holds the SSH private key. The
 * caller is responsible for resolving this via `@redbtn/redsecrets` BEFORE
 * calling `EnvironmentManager.acquire()` and passing the resolved string as
 * the `sshKey` argument. Phase A never touches the secret store directly —
 * this keeps Phase A free of `@redbtn/redsecrets` and lets Phase B wire in
 * resolution + audit/access logic.
 */
export interface IEnvironment {
  /** User-facing ID (e.g. `env_abc123`). */
  environmentId: string;
  /** Owner. */
  userId: string;
  /** Display name (e.g. "Alpha Server"). */
  name: string;
  /** Optional human-readable description. */
  description?: string;

  // --- Target ---
  /** Discriminator. v1 = `'self-hosted'`. Phase G reserves `'redbtn-hosted'`. */
  kind: 'self-hosted';
  /** Hostname or IP. */
  host: string;
  /** SSH port. Default 22. */
  port: number;
  /** SSH username. */
  user: string;
  /** Name of the secret holding the SSH private key (PEM). Resolved by caller. */
  secretRef: string;
  /** Default working directory for `exec`. Optional — falls back to home. */
  workingDir?: string;

  // --- Lifecycle ---
  /** Idle timeout in ms after last op. Default 300000 (5 min). */
  idleTimeoutMs: number;
  /** Hard kill after this many ms. Default 28800000 (8 h). */
  maxLifetimeMs: number;
  /** Reconnect policy when the SSH connection drops mid-session. */
  reconnect: EnvironmentReconnectPolicy;

  // --- Optional hooks ---
  /** Run after SSH handshake succeeds, before flipping state to `open`. Failure → close. */
  openCommand?: string;
  /** Run during graceful close, before ending the SSH client. Failures logged but not blocking. */
  closeCommand?: string;

  // --- Persistence ---
  /** When true, every `exec` writes a record to the `environmentLogs` collection. Default true. */
  archiveOutputLogs: boolean;

  // --- Audit ---
  /** When true, any user with access can use this env. When false, only owner. Default false. */
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

// ---------------------------------------------------------------------------
// Exec / SFTP options + results
// ---------------------------------------------------------------------------

/**
 * Options for `EnvironmentSession.exec()`.
 */
export interface ExecOptions {
  /** Override the environment's default `workingDir` for this call. */
  cwd?: string;
  /** Environment variables to export before running the command. */
  env?: Record<string, string>;
  /** Hard-kill the command after this many ms. 0 / undefined = no timeout. */
  timeout?: number;
  /** External cancellation signal (e.g. from `runControlRegistry`). */
  abortSignal?: AbortSignal;
}

/**
 * Result of `EnvironmentSession.exec()`.
 *
 * - `stdout` / `stderr` are truncated to the last `EXEC_MAX_OUTPUT_BYTES`
 *   (default 64KB) — `truncated` flips true if either was clipped.
 * - `exitCode` is the remote process's numeric exit code, or `null` if the
 *   process was killed by signal (and `signal` is set in the underlying
 *   stream callback).
 * - `durationMs` measures wall-clock time from `exec()` call to `'close'`
 *   event on the channel — it does NOT include time the command spent
 *   buffered in `pendingCommands` while the session was `degraded`.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  /** True if either stdout or stderr was clipped to `EXEC_MAX_OUTPUT_BYTES`. */
  truncated: boolean;
}

/**
 * Default tail size for stdout/stderr in `ExecResult`. Anything beyond this
 * is dropped from the head of the buffer.
 */
export const EXEC_MAX_OUTPUT_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// SFTP types
// ---------------------------------------------------------------------------

/**
 * Stat result from `EnvironmentSession.sftpStat()`. Boiled down to the
 * fields callers actually care about — full `ssh2.Stats` is more than we
 * want to expose at the public boundary.
 */
export interface SftpStatResult {
  size: number;
  mode: number;
  modifiedAt: Date;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
}

/**
 * Single entry from `EnvironmentSession.sftpReaddir()`.
 *
 * The `type` discriminator is `'file' | 'dir' | 'link' | 'other'` — we
 * collapse the various block/char/socket/fifo cases into `'other'` because
 * coding-agent tools only need the file/dir/link distinction.
 */
export interface SftpDirEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  modifiedAt: Date;
}

/**
 * Options for `EnvironmentSession.sftpRead()`.
 */
export interface SftpReadOptions {
  /** Byte offset to start reading from. */
  offset?: number;
  /** Maximum number of bytes to read. */
  length?: number;
}

/**
 * Options for `EnvironmentSession.sftpWrite()`.
 */
export interface SftpWriteOptions {
  /** File mode (octal, e.g. 0o644). Applied via SFTP chmod after the rename. */
  mode?: number;
}

// ---------------------------------------------------------------------------
// Pending command buffer
// ---------------------------------------------------------------------------

/**
 * Internal entry in the `pendingCommands` queue while the session is
 * `degraded`. Each call to `exec` / `sftp*` during degraded becomes one of
 * these — the public method returns a Promise that the manager will resolve
 * (or reject) when the session reconnects (or fails reconnect).
 *
 * `bytes` is used for buffer-size bookkeeping (we cap total queue size to
 * `BUFFER_MAX_BYTES` independent of the command count cap).
 */
export interface PendingCommand {
  /** Internal kind so the drain loop knows what to dispatch. */
  kind: 'exec' | 'sftp-read' | 'sftp-write' | 'sftp-stat' | 'sftp-readdir';
  /** Human-readable label for diagnostics (e.g. the command string or path). */
  label: string;
  /** Approximate byte cost (used for the 1MB buffer cap). */
  bytes: number;
  /** Function to run when the session reconnects. Wraps the actual op. */
  run: () => Promise<unknown>;
  /** Settle the public-facing promise. */
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** When this entry was queued (for diagnostic logs). */
  queuedAt: Date;
}

/** Max number of buffered commands during `degraded`. Oldest dropped first. */
export const BUFFER_MAX_COMMANDS = 100;

/** Max total bytes across buffered commands. Oldest dropped first. */
export const BUFFER_MAX_BYTES = 1024 * 1024; // 1MB

// ---------------------------------------------------------------------------
// Status snapshot (manager.status())
// ---------------------------------------------------------------------------

/**
 * Public-facing snapshot of an EnvironmentSession's runtime state. Returned
 * by `EnvironmentManager.status()` and (in Phase B) by the
 * `GET /api/v1/environments/:id/status` route.
 *
 * Fields are intentionally diagnostic — nothing here can mutate the session.
 */
export interface EnvironmentStatus {
  environmentId: string;
  userId: string;
  state: EnvironmentLifecycleState;
  openedAt: Date | null;
  lastUsedAt: Date;
  /** Current reconnect attempt (1-indexed) when in `degraded`. 0 otherwise. */
  reconnectAttempt: number;
  /** Number of commands currently buffered awaiting reconnect. */
  pendingCommandCount: number;
  /** Sum of `bytes` across pendingCommands. */
  pendingCommandBytes: number;
}

// ---------------------------------------------------------------------------
// Environment lifecycle events (EventEmitter)
// ---------------------------------------------------------------------------

/**
 * Lifecycle event payload — emitted on `EnvironmentSession` (and forwarded by
 * the manager) whenever the lifecycle state changes. Phase F (Studio UI) will
 * subscribe to this so the dashboard can show live status changes.
 */
export interface EnvironmentLifecycleEvent {
  environmentId: string;
  from: EnvironmentLifecycleState;
  to: EnvironmentLifecycleState;
  reason?: string;
  /** When the transition happened. */
  at: Date;
}

/**
 * Event emitted on every successful `exec` (and `sftp*`) call. Used by the
 * archiveOutputLogs callback to persist a log row, and (in Phase F) by the UI
 * to show recent commands.
 */
export interface EnvironmentExecCompletedEvent {
  environmentId: string;
  userId: string;
  command: string;
  cwd: string;
  result: ExecResult;
  startedAt: Date;
}

// ---------------------------------------------------------------------------
// Environment log archive (per ENVIRONMENT-HANDOFF.md §3.7)
// ---------------------------------------------------------------------------

/**
 * The `environmentLogs` Mongo collection shape (defined in Phase B). Phase A
 * exposes this type so that the optional `onExecComplete` callback (passed
 * to the manager constructor) has a stable contract — Phase B will wire the
 * callback to a real Mongo write, but Phase A defines the record shape.
 *
 * Indexed on `(environmentId, startedAt: -1)`, `(userId, startedAt: -1)`,
 * `(runId, startedAt: -1)` (Phase B will declare these).
 */
export interface IEnvironmentLog {
  environmentId: string;
  userId: string;
  /** When the call originated from a graph run, the runId for diagnostics. */
  runId?: string;
  command: string;
  cwd: string;
  /** Truncated to EXEC_MAX_OUTPUT_BYTES. */
  stdout: string;
  /** Truncated to EXEC_MAX_OUTPUT_BYTES. */
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  startedAt: Date;
  /** TTL — default 30 days from startedAt. */
  expiresAt: Date;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when `exec` / `sftp*` is called on a session that's already closed,
 * OR when a queued (degraded) command is rejected because reconnect failed.
 *
 * Caller code should check for this and treat it as a user-visible session
 * teardown — re-acquiring the environment will open a fresh session.
 */
export class EnvironmentClosedError extends Error {
  readonly code = 'ENV_CLOSED';
  constructor(public readonly environmentId: string, message?: string) {
    super(message ?? `Environment session ${environmentId} is closed`);
    this.name = 'EnvironmentClosedError';
  }
}

/**
 * Thrown when an `exec` exceeds its `opts.timeout`.
 */
export class EnvironmentTimeoutError extends Error {
  readonly code = 'ENV_TIMEOUT';
  constructor(public readonly environmentId: string, public readonly timeoutMs: number) {
    super(`Environment ${environmentId} command timed out after ${timeoutMs}ms`);
    this.name = 'EnvironmentTimeoutError';
  }
}

/**
 * Thrown when the pending-command buffer is full AND the new command can't
 * displace the oldest (because it would still exceed `BUFFER_MAX_BYTES`).
 *
 * In practice this is rare — the eviction policy drops oldest on overflow,
 * which always makes room for any single command up to `BUFFER_MAX_BYTES`.
 * This error exists for the corner case where a single command exceeds the
 * total buffer cap.
 */
export class EnvironmentBufferOverflowError extends Error {
  readonly code = 'ENV_BUFFER_OVERFLOW';
  constructor(public readonly environmentId: string, message: string) {
    super(message);
    this.name = 'EnvironmentBufferOverflowError';
  }
}

// ---------------------------------------------------------------------------
// Defaults — applied by the manager when fields are absent on the input
// IEnvironment. Mirrors the schema defaults that Phase B will enforce
// upstream, but having them here too makes Phase A safe in isolation
// (callers don't have to fully populate the doc to get sensible behaviour).
// ---------------------------------------------------------------------------

export const ENV_DEFAULTS = {
  port: 22,
  idleTimeoutMs: 5 * 60 * 1000, // 5 min
  maxLifetimeMs: 8 * 60 * 60 * 1000, // 8 h
  reconnect: {
    maxAttempts: 5,
    backoffMs: 2000,
    maxBackoffMs: 30000,
  } as EnvironmentReconnectPolicy,
  archiveOutputLogs: true,
  isPublic: false,
  /** TTL for environmentLogs records when archive is enabled. */
  logsTtlMs: 30 * 24 * 60 * 60 * 1000, // 30 days
} as const;
