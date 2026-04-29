/**
 * EnvironmentSession — long-running SSH/SFTP session with drop tolerance.
 *
 * # What this is
 *
 * One `EnvironmentSession` wraps one `ssh2.Client` (plus its parallel SFTP
 * channel) plus all the lifecycle/buffering/timer machinery needed to make
 * the connection self-healing and idle-managed. The `EnvironmentManager`
 * (sibling module) keeps a `Map<environmentId, EnvironmentSession>` per
 * worker process so multiple tools / nodes / runs share a single SSH tunnel
 * for the duration of an environment's natural life.
 *
 * # Lifecycle
 *
 * See `types.ts` `EnvironmentLifecycleState` for the full state machine.
 *
 * The interesting transitions are:
 *
 *   - `closed → opening`: `open()` was called.
 *   - `opening → open`: SSH `'ready'` AND (if set) `openCommand` succeeded.
 *   - `opening → closed`: handshake failed OR openCommand failed.
 *   - `open → degraded`: ssh2 emitted `'close'` or `'error'` UNEXPECTEDLY.
 *   - `degraded → opening`: reconnect attempt fires.
 *   - `degraded → closed`: max reconnect attempts exhausted.
 *   - `open → closing`: idle timer / maxLifetime / explicit `close()`.
 *   - `closing → closed`: all in-flight ops drained + ssh client ended.
 *
 * Every transition emits a `'lifecycle'` EventEmitter event with `{ from,
 * to, reason }` so the manager (and Phase F UI) can react.
 *
 * # Drop tolerance / command buffering
 *
 * When the SSH connection drops while `state === 'open'`:
 *
 *   1. Flip `state → 'degraded'`.
 *   2. Capture in-flight command (if any) as a pending entry — its public
 *      promise stays unresolved.
 *   3. Begin reconnect with exponential backoff (per env.reconnect policy).
 *   4. New `exec` / `sftp*` calls during degraded: append to
 *      `pendingCommands` queue (bounded — see `BUFFER_MAX_*`).
 *   5. On reconnect success: flip `state → 'open'`, drain pendingCommands
 *      FIFO, resolve their promises with their results.
 *   6. On reconnect failure (max attempts): flip `state → 'closed'`, reject
 *      all pending with `EnvironmentClosedError`.
 *
 * # Timer pause/resume during degraded
 *
 * The idle timer and max-lifetime timer both PAUSE while degraded — they
 * track time-on-open, not wall-clock time. When the session reconnects, the
 * timers resume with their remaining duration intact. This avoids the
 * pathological case where a long network blip causes the session to be
 * marked idle the moment it reconnects.
 *
 * # Why the clientFactory injection
 *
 * The constructor takes an optional `clientFactory: () => ssh2.Client` so
 * tests can swap in a `MockSshClient` that emits the same events as the real
 * thing on demand. This keeps the production path clean (default factory
 * produces a real `Client`) while making drop scenarios testable without
 * spinning up an SSH server.
 *
 * @module lib/environments/EnvironmentSession
 */

import { EventEmitter } from 'events';
import { Client, type ConnectConfig, type SFTPWrapper, type Stats, type FileEntryWithStats } from 'ssh2';
import {
  type IEnvironment,
  type EnvironmentLifecycleState,
  type ExecOptions,
  type ExecResult,
  type SftpStatResult,
  type SftpDirEntry,
  type SftpReadOptions,
  type SftpWriteOptions,
  type PendingCommand,
  type EnvironmentLifecycleEvent,
  type EnvironmentExecCompletedEvent,
  type IEnvironmentLog,
  EXEC_MAX_OUTPUT_BYTES,
  BUFFER_MAX_COMMANDS,
  BUFFER_MAX_BYTES,
  ENV_DEFAULTS,
  EnvironmentClosedError,
  EnvironmentTimeoutError,
  EnvironmentBufferOverflowError,
} from './types';

/** Connect-handshake timeout (overrides ssh2 default of 20s for snappier failure). */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Keepalive ping interval — keeps NATs alive, surfaces dropped connections fast. */
const KEEPALIVE_INTERVAL_MS = 15_000;

/** Number of missed keepalives before ssh2 declares the connection dead. */
const KEEPALIVE_COUNT_MAX = 5;

/** Exec polling timeout for the close event before settling with whatever we have. */
const EXEC_DRAIN_GRACE_MS = 100;

/**
 * Factory function the session uses to construct its underlying SSH client.
 * Defaulted to the real `ssh2.Client` constructor; tests inject a mock.
 *
 * The contract: the returned object must be an `EventEmitter` with the
 * methods/events the session uses (`connect`, `exec`, `sftp`, `end`,
 * `'ready'`, `'error'`, `'close'`).
 */
export type SshClientFactory = () => Client;

/**
 * Optional callback fired after every successful `exec` (when
 * `env.archiveOutputLogs === true`). Phase B will plug this into the Mongo
 * `environmentLogs` collection write. Phase A keeps it as a generic hook so
 * the engine never imports Mongoose.
 */
export type OnExecCompleteHandler = (record: IEnvironmentLog) => Promise<void> | void;

/**
 * Constructor arguments for `EnvironmentSession`.
 */
export interface EnvironmentSessionOptions {
  /** Fully-resolved environment config doc (caller loaded from Mongo). */
  env: IEnvironment;
  /** Fully-resolved SSH private key (caller resolved from secret store). */
  sshKey: string;
  /** ID of the user who initiated the acquire (for audit / log records). */
  userId: string;
  /**
   * Optional — when omitted, defaults to `() => new Client()` from ssh2.
   * Tests inject a `MockSshClient` factory.
   */
  clientFactory?: SshClientFactory;
  /**
   * Optional — fired after every successful `exec` when the env has
   * `archiveOutputLogs: true`. Phase A wraps this in a try/catch so handler
   * failures never break the session.
   */
  onExecComplete?: OnExecCompleteHandler;
  /**
   * Optional — runId to stamp on archive log records. Phase B will plumb
   * this through from the run-control registry; Phase A leaves it as an
   * opaque string the caller can pass through.
   */
  runId?: string;
}

interface InternalTimer {
  handle: NodeJS.Timeout;
  /** Wall-clock time when this timer was started (ms since epoch). */
  startedAt: number;
  /** Original duration in ms (so we can compute remaining when paused). */
  durationMs: number;
  /** When paused, the remaining ms to fire. Null when running. */
  remainingMs: number | null;
}

export class EnvironmentSession extends EventEmitter {
  readonly environmentId: string;
  readonly userId: string;
  readonly env: IEnvironment;

  state: EnvironmentLifecycleState = 'closed';
  openedAt: Date | null = null;
  lastUsedAt: Date = new Date();

  // ssh2 handles (null when state !== 'open' or 'opening' partial)
  private client: Client | null = null;
  private sftp: SFTPWrapper | null = null;

  // Buffering during degraded
  private readonly pendingCommands: PendingCommand[] = [];
  private pendingBytes = 0;

  // Reconnect bookkeeping
  reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  // Lifecycle timers — both pause during degraded
  private idleTimer: InternalTimer | null = null;
  private maxLifetimeTimer: InternalTimer | null = null;

  // ssh2 + open hooks
  private readonly clientFactory: SshClientFactory;
  private readonly sshKey: string;
  private readonly onExecComplete?: OnExecCompleteHandler;
  private readonly runId?: string;

  // Concurrency: we serialize exec/sftp calls to keep the buffer drain order
  // deterministic and to avoid stomping on the single SSH session. Real ssh2
  // supports parallel channels, but for v1 we keep things simple — coding
  // agents virtually always serialize anyway.
  private opChain: Promise<unknown> = Promise.resolve();

  // Mark when an explicit close has been requested so the unexpected-close
  // handler doesn't try to recover.
  private explicitClose = false;

  constructor(opts: EnvironmentSessionOptions) {
    super();
    this.env = opts.env;
    this.environmentId = opts.env.environmentId;
    this.userId = opts.userId;
    this.sshKey = opts.sshKey;
    this.clientFactory = opts.clientFactory ?? (() => new Client());
    this.onExecComplete = opts.onExecComplete;
    this.runId = opts.runId;
  }

  // ---------------------------------------------------------------------------
  // Public — lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Open the SSH session. Idempotent — if state is already `opening` /
   * `open`, returns the in-flight or already-open promise.
   *
   * On success: state transitions to `open`.
   * On failure: state transitions back to `closed` and the promise rejects.
   */
  open(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'opening' && this.openingPromise) return this.openingPromise;
    if (this.state === 'closing') {
      return Promise.reject(new EnvironmentClosedError(
        this.environmentId,
        `Environment ${this.environmentId} is closing — cannot open`,
      ));
    }
    if (this.state === 'closed' || this.state === 'degraded') {
      // From degraded we shouldn't be calling open() externally; the reconnect
      // loop handles that. Defensive — treat as closed.
      this.openingPromise = this.openInternal();
      return this.openingPromise;
    }
    return Promise.reject(new Error(`Environment ${this.environmentId}: unexpected state ${this.state}`));
  }

  private openingPromise: Promise<void> | null = null;

  private async openInternal(): Promise<void> {
    this.transitionTo('opening', 'open()');
    try {
      this.client = this.clientFactory();
      this.attachClientHandlers(this.client);

      await this.connectClient(this.client);

      // SFTP channel is requested on demand by sftp* methods, but try to
      // open it eagerly so we surface SFTP-disabled servers at open time.
      try {
        this.sftp = await this.openSftp(this.client);
      } catch (sftpErr) {
        // Some servers don't have SFTP — log and continue. exec still works.
        console.warn(
          `[EnvironmentSession] ${this.environmentId}: SFTP unavailable, continuing exec-only:`,
          sftpErr instanceof Error ? sftpErr.message : sftpErr,
        );
        this.sftp = null;
      }

      // Run openCommand BEFORE flipping to 'open' so failure aborts the open.
      if (this.env.openCommand) {
        try {
          await this.execRaw(this.env.openCommand, {});
        } catch (cmdErr) {
          throw new Error(
            `openCommand failed: ${cmdErr instanceof Error ? cmdErr.message : String(cmdErr)}`,
          );
        }
      }

      this.openedAt = new Date();
      this.lastUsedAt = new Date();
      this.transitionTo('open', 'handshake-complete');
      this.startIdleTimer();
      this.startMaxLifetimeTimer();
      this.openingPromise = null;
      // If any callers buffered ops while we were `opening`, drain them now.
      this.drainPending();
    } catch (err) {
      // Clean up the half-open client and report failure.
      this.tearDownClient();
      this.transitionTo('closed', `open-failed: ${err instanceof Error ? err.message : String(err)}`);
      this.openingPromise = null;
      throw err;
    }
  }

  /**
   * Close the session gracefully. Drains in-flight ops, runs `closeCommand`
   * if set, then ends the ssh2 client.
   *
   * Idempotent — if already closing/closed, resolves immediately.
   *
   * `reason` is recorded on the lifecycle event for diagnostics.
   */
  async close(reason: string = 'explicit'): Promise<void> {
    if (this.state === 'closed') return;
    if (this.state === 'closing' && this.closingPromise) return this.closingPromise;

    this.explicitClose = true;
    this.closingPromise = this.closeInternal(reason);
    return this.closingPromise;
  }

  private closingPromise: Promise<void> | null = null;

  private async closeInternal(reason: string): Promise<void> {
    const previousState = this.state;
    this.transitionTo('closing', reason);

    // Cancel any pending reconnect attempt.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Drain timers — we're closing, no idle/maxLifetime checks needed.
    this.clearTimers();

    // Reject any pending commands. They never get to run.
    this.rejectPending(new EnvironmentClosedError(
      this.environmentId,
      `Environment ${this.environmentId} closed: ${reason}`,
    ));

    // Run closeCommand best-effort. Failures logged, not propagated.
    if (this.client && previousState === 'open' && this.env.closeCommand) {
      try {
        await this.execRaw(this.env.closeCommand, {});
      } catch (err) {
        console.warn(
          `[EnvironmentSession] ${this.environmentId}: closeCommand failed (non-fatal):`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    // End the ssh2 client.
    this.tearDownClient();

    this.transitionTo('closed', reason);
    this.closingPromise = null;
  }

  // ---------------------------------------------------------------------------
  // Public — exec
  // ---------------------------------------------------------------------------

  /**
   * Execute a shell command on the remote host.
   *
   * Behaviour by state:
   *   - `open`: runs immediately on the live SSH client.
   *   - `degraded`: queues into `pendingCommands` (subject to overflow).
   *     The returned promise resolves when reconnect drains the queue.
   *   - `opening`: serialized after the open completes.
   *   - `closed` / `closing`: rejects with `EnvironmentClosedError`.
   *
   * Resets the idle timer on any state where the call is dispatched.
   */
  async exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ?? this.env.workingDir ?? '.';
    return this.dispatchDropTolerant(
      'exec',
      command,
      Buffer.byteLength(command, 'utf8'),
      () => this.execRawTracked(command, opts, cwd),
    ) as Promise<ExecResult>;
  }

  /**
   * Internal — execute + (when archiveOutputLogs) fire the onExecComplete hook.
   */
  private async execRawTracked(
    command: string,
    opts: ExecOptions,
    cwd: string,
  ): Promise<ExecResult> {
    const startedAt = new Date();
    // Reset idle timer for any user-initiated exec (NOT for openCommand /
    // closeCommand — those go through execRaw directly).
    this.touch();
    const result = await this.execRaw(command, opts);
    // Touch again on completion so a long-running exec extends idle past its
    // start time. (touch() resets the timer to its full duration.)
    this.touch();

    // Emit a public event regardless of archive flag — UI / observers can
    // subscribe even when archive is off (Phase F).
    const completedEvent: EnvironmentExecCompletedEvent = {
      environmentId: this.environmentId,
      userId: this.userId,
      command,
      cwd,
      result,
      startedAt,
    };
    try {
      this.emit('exec_completed', completedEvent);
    } catch (emitErr) {
      console.warn(`[EnvironmentSession] ${this.environmentId}: exec_completed listener threw:`, emitErr);
    }

    if (this.env.archiveOutputLogs && this.onExecComplete) {
      const record: IEnvironmentLog = {
        environmentId: this.environmentId,
        userId: this.userId,
        runId: this.runId,
        command,
        cwd,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        startedAt,
        expiresAt: new Date(startedAt.getTime() + ENV_DEFAULTS.logsTtlMs),
      };
      // Fire-and-forget — failures logged, never propagated.
      Promise.resolve()
        .then(() => this.onExecComplete!(record))
        .catch((err) => {
          console.warn(
            `[EnvironmentSession] ${this.environmentId}: onExecComplete handler failed:`,
            err instanceof Error ? err.message : err,
          );
        });
    }

    return result;
  }

  /**
   * Internal — actually invoke ssh2.Client.exec(). Knows nothing about the
   * lifecycle state machine — assumes the client is live. Used both by the
   * public exec() and internally for openCommand / closeCommand.
   */
  private async execRaw(command: string, opts: ExecOptions): Promise<ExecResult> {
    if (!this.client) {
      throw new EnvironmentClosedError(this.environmentId, 'No SSH client');
    }

    // Build the full command with cwd + env injection (mirrors ssh-shell.ts).
    let fullCommand = command;
    const cwd = opts.cwd ?? this.env.workingDir;
    if (cwd) {
      fullCommand = `cd ${JSON.stringify(cwd)} && ${fullCommand}`;
    }
    if (opts.env && Object.keys(opts.env).length > 0) {
      const envExports = Object.entries(opts.env)
        .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
        .join(' && ');
      fullCommand = `${envExports} && ${fullCommand}`;
    }

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let truncatedStdout = false;
    let truncatedStderr = false;
    let exitCode: number | null = null;

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false;
      let timeoutTimer: NodeJS.Timeout | null = null;
      let abortListener: (() => void) | null = null;
      let stream: ReturnType<typeof streamAccessor> | null = null;

      const clearLocal = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (abortListener && opts.abortSignal) {
          opts.abortSignal.removeEventListener('abort', abortListener);
          abortListener = null;
        }
      };

      const settle = (err: Error | null, finalCode: number | null) => {
        if (settled) return;
        settled = true;
        clearLocal();
        const durationMs = Date.now() - startTime;

        if (err) {
          reject(err);
          return;
        }

        const result: ExecResult = {
          stdout: tail(stdout, EXEC_MAX_OUTPUT_BYTES),
          stderr: tail(stderr, EXEC_MAX_OUTPUT_BYTES),
          exitCode: finalCode,
          durationMs,
          truncated: truncatedStdout || truncatedStderr,
        };
        resolve(result);
      };

      // The exec callback signature: (err, stream)
      this.client!.exec(fullCommand, (err, channelStream) => {
        if (err) {
          return settle(err, null);
        }
        stream = channelStream;

        // Hard timeout — kill the stream after opts.timeout.
        if (opts.timeout && opts.timeout > 0) {
          timeoutTimer = setTimeout(() => {
            try {
              channelStream.signal('KILL');
            } catch { /* best-effort */ }
            try {
              channelStream.close();
            } catch { /* best-effort */ }
            settle(new EnvironmentTimeoutError(this.environmentId, opts.timeout!), null);
          }, opts.timeout);
        }

        // External abort signal — same kill semantics as timeout.
        if (opts.abortSignal) {
          if (opts.abortSignal.aborted) {
            try { channelStream.signal('KILL'); } catch { /* ignore */ }
            try { channelStream.close(); } catch { /* ignore */ }
            return settle(new Error('exec aborted'), null);
          }
          abortListener = () => {
            try { channelStream.signal('KILL'); } catch { /* ignore */ }
            try { channelStream.close(); } catch { /* ignore */ }
            settle(new Error('exec aborted'), null);
          };
          opts.abortSignal.addEventListener('abort', abortListener, { once: true });
        }

        channelStream.on('data', (data: Buffer) => {
          const chunk = data.toString('utf8');
          stdout += chunk;
          if (stdout.length > EXEC_MAX_OUTPUT_BYTES) {
            stdout = stdout.slice(stdout.length - EXEC_MAX_OUTPUT_BYTES);
            truncatedStdout = true;
          }
        });

        channelStream.stderr.on('data', (data: Buffer) => {
          const chunk = data.toString('utf8');
          stderr += chunk;
          if (stderr.length > EXEC_MAX_OUTPUT_BYTES) {
            stderr = stderr.slice(stderr.length - EXEC_MAX_OUTPUT_BYTES);
            truncatedStderr = true;
          }
        });

        channelStream.on('close', (code: number | null) => {
          exitCode = typeof code === 'number' ? code : null;
          // Give a moment for any final 'data' bytes to land before settling.
          setTimeout(() => settle(null, exitCode), EXEC_DRAIN_GRACE_MS).unref?.();
        });

        channelStream.on('error', (streamErr: Error) => {
          settle(streamErr, exitCode);
        });
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Public — SFTP
  // ---------------------------------------------------------------------------

  /**
   * Read a file via SFTP. Returns the raw bytes — caller decides on encoding.
   */
  async sftpRead(path: string, opts: SftpReadOptions = {}): Promise<Buffer> {
    return this.dispatchDropTolerant(
      'sftp-read',
      `read:${path}`,
      Buffer.byteLength(path, 'utf8'),
      () => this.sftpReadRaw(path, opts),
    ) as Promise<Buffer>;
  }

  private async sftpReadRaw(path: string, opts: SftpReadOptions): Promise<Buffer> {
    this.touch();
    const sftp = await this.ensureSftp();
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, {}, (err, data) => {
        if (err) return reject(err);
        let buf = data;
        if (typeof opts.offset === 'number' || typeof opts.length === 'number') {
          const start = opts.offset ?? 0;
          const len = opts.length ?? Math.max(0, buf.length - start);
          buf = buf.subarray(start, start + len);
        }
        resolve(buf);
      });
    });
  }

  /**
   * Write a file via SFTP atomically (temp + rename). Optionally chmods after.
   */
  async sftpWrite(
    path: string,
    content: Buffer | string,
    opts: SftpWriteOptions = {},
  ): Promise<void> {
    const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.length;
    return this.dispatchDropTolerant(
      'sftp-write',
      `write:${path}`,
      bytes,
      () => this.sftpWriteRaw(path, content, opts),
    ) as Promise<void>;
  }

  private async sftpWriteRaw(
    path: string,
    content: Buffer | string,
    opts: SftpWriteOptions,
  ): Promise<void> {
    this.touch();
    const sftp = await this.ensureSftp();
    const tmpPath = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;

    // Write to temp.
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(tmpPath, content, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Atomic rename.
    try {
      await new Promise<void>((resolve, reject) => {
        sftp.rename(tmpPath, path, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    } catch (renameErr) {
      // Best-effort cleanup of the temp file.
      try {
        await new Promise<void>((resolve) => {
          sftp.unlink(tmpPath, () => resolve());
        });
      } catch { /* ignore */ }
      throw renameErr;
    }

    // Optional chmod.
    if (typeof opts.mode === 'number') {
      await new Promise<void>((resolve, reject) => {
        sftp.chmod(path, opts.mode!, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  /**
   * SFTP stat — boiled down to the public-facing fields callers care about.
   */
  async sftpStat(path: string): Promise<SftpStatResult> {
    return this.dispatchDropTolerant(
      'sftp-stat',
      `stat:${path}`,
      Buffer.byteLength(path, 'utf8'),
      () => this.sftpStatRaw(path),
    ) as Promise<SftpStatResult>;
  }

  private async sftpStatRaw(path: string): Promise<SftpStatResult> {
    this.touch();
    const sftp = await this.ensureSftp();
    return new Promise<SftpStatResult>((resolve, reject) => {
      sftp.stat(path, (err, stats: Stats) => {
        if (err) return reject(err);
        resolve({
          size: stats.size,
          mode: stats.mode,
          modifiedAt: new Date(stats.mtime * 1000),
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
          isSymbolicLink: stats.isSymbolicLink(),
        });
      });
    });
  }

  /**
   * SFTP readdir — file/dir/link/other discriminator + size + mtime.
   */
  async sftpReaddir(path: string): Promise<SftpDirEntry[]> {
    return this.dispatchDropTolerant(
      'sftp-readdir',
      `readdir:${path}`,
      Buffer.byteLength(path, 'utf8'),
      () => this.sftpReaddirRaw(path),
    ) as Promise<SftpDirEntry[]>;
  }

  private async sftpReaddirRaw(path: string): Promise<SftpDirEntry[]> {
    this.touch();
    const sftp = await this.ensureSftp();
    return new Promise<SftpDirEntry[]>((resolve, reject) => {
      sftp.readdir(path, (err, list: FileEntryWithStats[]) => {
        if (err) return reject(err);
        const entries: SftpDirEntry[] = list.map((e) => ({
          name: e.filename,
          type: e.attrs.isDirectory() ? 'dir'
            : e.attrs.isFile() ? 'file'
              : e.attrs.isSymbolicLink() ? 'link'
                : 'other',
          size: e.attrs.size,
          modifiedAt: new Date(e.attrs.mtime * 1000),
        }));
        resolve(entries);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — ssh2 plumbing
  // ---------------------------------------------------------------------------

  private connectClient(client: Client): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const onReady = () => {
        if (settled) return;
        settled = true;
        client.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        client.removeListener('ready', onReady);
        reject(err);
      };
      client.once('ready', onReady);
      client.once('error', onError);

      const config: ConnectConfig = {
        host: this.env.host,
        port: this.env.port ?? ENV_DEFAULTS.port,
        username: this.env.user,
        privateKey: Buffer.from(this.sshKey, 'utf8'),
        readyTimeout: HANDSHAKE_TIMEOUT_MS,
        keepaliveInterval: KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      };

      try {
        client.connect(config);
      } catch (connectErr) {
        onError(connectErr as Error);
      }
    });
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) return reject(err);
        resolve(sftp);
      });
    });
  }

  private async ensureSftp(): Promise<SFTPWrapper> {
    if (this.sftp) return this.sftp;
    if (!this.client) {
      throw new EnvironmentClosedError(this.environmentId, 'No SSH client');
    }
    this.sftp = await this.openSftp(this.client);
    return this.sftp;
  }

  /**
   * Wire up the lifecycle event handlers on the ssh2 client. Detects
   * unexpected drops and triggers the degraded-state recovery flow.
   */
  private attachClientHandlers(client: Client): void {
    const onUnexpectedClose = (label: string, err?: Error) => {
      if (this.explicitClose) return; // we asked for this; ignore
      if (this.state === 'closed' || this.state === 'closing') return;
      if (this.state === 'opening') {
        // The connect promise's own onError will reject and clean up.
        return;
      }
      // open or degraded → start (or restart) the recovery loop
      const reason = err ? `${label}: ${err.message}` : label;
      this.handleUnexpectedClose(reason);
    };

    client.on('close', () => onUnexpectedClose('ssh-close'));
    client.on('error', (err) => onUnexpectedClose('ssh-error', err));
    client.on('end', () => onUnexpectedClose('ssh-end'));
  }

  /**
   * The drop-recovery flow. Called when the ssh2 client emits 'close' /
   * 'error' / 'end' while we're in `open` (or already `degraded`).
   *
   * In-flight ops at drop time: handled by `dispatchDropTolerant` — when the
   * underlying transport call rejects AND the session is now `degraded`,
   * the wrapper re-queues automatically. We don't need to track an explicit
   * `inFlightOp` here.
   */
  private handleUnexpectedClose(reason: string): void {
    this.tearDownClient();

    if (this.state === 'degraded') {
      // Already recovering; the existing reconnect loop continues.
      return;
    }

    this.transitionTo('degraded', reason);
    this.pauseTimers();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state !== 'degraded') return;
    const policy = this.env.reconnect ?? ENV_DEFAULTS.reconnect;
    this.reconnectAttempt += 1;

    if (this.reconnectAttempt > policy.maxAttempts) {
      // Out of attempts — flip to closed and reject all pending.
      this.transitionTo('closed', `reconnect-exhausted (${policy.maxAttempts} attempts)`);
      this.rejectPending(new EnvironmentClosedError(
        this.environmentId,
        `Reconnect failed after ${policy.maxAttempts} attempts`,
      ));
      this.clearTimers();
      return;
    }

    const backoff = Math.min(
      policy.backoffMs * Math.pow(2, this.reconnectAttempt - 1),
      policy.maxBackoffMs,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.attemptReconnect().catch((err) => {
        console.warn(
          `[EnvironmentSession] ${this.environmentId}: reconnect attempt ${this.reconnectAttempt} failed:`,
          err instanceof Error ? err.message : err,
        );
        // Schedule the next attempt.
        this.scheduleReconnect();
      });
    }, backoff);
    this.reconnectTimer.unref?.();
  }

  private async attemptReconnect(): Promise<void> {
    if (this.state !== 'degraded') return;

    // Open a fresh client.
    const client = this.clientFactory();
    this.attachClientHandlers(client);

    try {
      await this.connectClient(client);
      try {
        const sftp = await this.openSftp(client);
        this.sftp = sftp;
      } catch (sftpErr) {
        console.warn(
          `[EnvironmentSession] ${this.environmentId}: SFTP unavailable after reconnect:`,
          sftpErr instanceof Error ? sftpErr.message : sftpErr,
        );
        this.sftp = null;
      }
      // Note: we deliberately do NOT re-run openCommand on reconnect — its
      // typical purpose (e.g. `git fetch`) shouldn't double-fire just because
      // the network blipped. If openCommand is meant to be idempotent setup,
      // the user can include that idempotency in the command itself.
      this.client = client;
      this.reconnectAttempt = 0;
      this.transitionTo('open', 'reconnected');
      this.resumeTimers();
      // Drain pending commands FIFO.
      this.drainPending();
    } catch (err) {
      // Tear down half-open client and let scheduleReconnect retry.
      try { client.end(); } catch { /* ignore */ }
      throw err;
    }
  }

  /**
   * Drain pending commands FIFO. Each one runs sequentially through the
   * normal serialize() path so they share the single SSH session cleanly.
   */
  private drainPending(): void {
    if (this.state !== 'open') return;
    const queue = this.pendingCommands.splice(0);
    this.pendingBytes = 0;
    for (const entry of queue) {
      this.serialize(async () => {
        try {
          const result = await entry.run();
          entry.resolve(result);
        } catch (err) {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — drop-tolerant dispatch
  // ---------------------------------------------------------------------------

  /**
   * Single dispatch path for every public exec / sftp* method.
   *
   * Behaviour by state:
   *   - `closed` / `closing`: rejects with EnvironmentClosedError immediately.
   *   - `degraded`: enqueues into the pending buffer (subject to overflow).
   *     The promise resolves when the session reconnects and drains.
   *   - `open` / `opening`: serializes behind any prior op and dispatches.
   *     If the dispatched call rejects AND the session has flipped to
   *     `degraded` in the meantime (drop while in flight), the call is
   *     transparently re-queued so it replays after reconnect — the user
   *     never sees the underlying transport failure.
   */
  private dispatchDropTolerant<T>(
    kind: PendingCommand['kind'],
    label: string,
    bytes: number,
    op: () => Promise<T>,
  ): Promise<T> {
    if (this.state === 'closed' || this.state === 'closing') {
      return Promise.reject(new EnvironmentClosedError(this.environmentId));
    }
    // Both `degraded` (waiting for reconnect) and `opening` (waiting for
    // initial handshake) buffer the op into pendingCommands. The drain
    // happens when state flips to 'open' (either from openInternal or from
    // attemptReconnect).
    if (this.state === 'degraded' || this.state === 'opening') {
      return this.enqueuePending(kind, label, bytes, op as () => Promise<unknown>) as Promise<T>;
    }
    // open — wrap the op in a drop-tolerant outer promise. The
    // serialize chain runs the op; if it fails AND the session is now
    // degraded, the outer promise re-queues into pendingCommands and
    // resolves only when reconnect drains. Crucially, we DON'T `await` the
    // re-queue inside the serialize callback — that would deadlock because
    // the drain would chain behind the still-running serialized op.
    return new Promise<T>((resolve, reject) => {
      this.serialize(async () => {
        try {
          const result = await op();
          resolve(result);
        } catch (err) {
          if (this.state === 'degraded') {
            // Re-queue for replay. The pending entry's promise resolves the
            // outer promise — we deliberately fire-and-forget here so the
            // serialize chain progresses (otherwise we'd deadlock on drain).
            this.enqueuePending(kind, label, bytes, op as () => Promise<unknown>)
              .then((r) => resolve(r as T))
              .catch((e) => reject(e));
            return;
          }
          reject(err);
        }
      }).catch(() => { /* serialize errors already routed through the inner reject */ });
    });
  }

  // ---------------------------------------------------------------------------
  // Internal — pending-command buffer
  // ---------------------------------------------------------------------------

  private enqueuePending<T>(
    kind: PendingCommand['kind'],
    label: string,
    bytes: number,
    run: () => Promise<T>,
  ): Promise<T> {
    if (bytes > BUFFER_MAX_BYTES) {
      // Single command too big for the buffer to ever hold.
      throw new EnvironmentBufferOverflowError(
        this.environmentId,
        `Command ${label} (${bytes} bytes) exceeds buffer cap (${BUFFER_MAX_BYTES} bytes)`,
      );
    }
    return new Promise<T>((resolve, reject) => {
      const entry: PendingCommand = {
        kind,
        label,
        bytes,
        run: run as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        queuedAt: new Date(),
      };

      // Eviction: drop oldest until the new entry fits.
      while (
        this.pendingCommands.length >= BUFFER_MAX_COMMANDS ||
        this.pendingBytes + bytes > BUFFER_MAX_BYTES
      ) {
        const dropped = this.pendingCommands.shift();
        if (!dropped) break;
        this.pendingBytes -= dropped.bytes;
        console.warn(
          `[EnvironmentSession] ${this.environmentId}: buffer overflow — dropping oldest pending command (${dropped.kind} ${dropped.label})`,
        );
        dropped.reject(new EnvironmentBufferOverflowError(
          this.environmentId,
          `Buffer overflow — pending command ${dropped.label} dropped`,
        ));
      }

      this.pendingCommands.push(entry);
      this.pendingBytes += bytes;
    });
  }

  private rejectPending(err: Error): void {
    const queue = this.pendingCommands.splice(0);
    this.pendingBytes = 0;
    for (const entry of queue) {
      try { entry.reject(err); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — op serialization
  // ---------------------------------------------------------------------------

  /**
   * Serialize ops behind any prior in-flight op. Keeps drain order
   * deterministic and avoids stomping on the single ssh2 session.
   */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(() => op(), () => op());
    // Swallow rejections on the chain itself so a failing op doesn't break
    // future serialize() calls. The caller still sees the rejection on the
    // returned promise.
    this.opChain = next.catch(() => undefined);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Internal — timers
  // ---------------------------------------------------------------------------

  private startIdleTimer(): void {
    this.clearTimer('idleTimer');
    const ms = this.env.idleTimeoutMs ?? ENV_DEFAULTS.idleTimeoutMs;
    if (!ms || ms <= 0) return;
    this.idleTimer = this.startTimer(ms, () => {
      // Idle timer fired; close gracefully.
      this.idleTimer = null;
      void this.close('idle-timeout');
    });
  }

  private startMaxLifetimeTimer(): void {
    this.clearTimer('maxLifetimeTimer');
    const ms = this.env.maxLifetimeMs ?? ENV_DEFAULTS.maxLifetimeMs;
    if (!ms || ms <= 0) return;
    this.maxLifetimeTimer = this.startTimer(ms, () => {
      this.maxLifetimeTimer = null;
      void this.close('max-lifetime-exceeded');
    });
  }

  private startTimer(durationMs: number, fire: () => void): InternalTimer {
    return {
      handle: (() => {
        const h = setTimeout(fire, durationMs);
        h.unref?.();
        return h;
      })(),
      startedAt: Date.now(),
      durationMs,
      remainingMs: null,
    };
  }

  private pauseTimers(): void {
    const now = Date.now();
    if (this.idleTimer && this.idleTimer.remainingMs === null) {
      const elapsed = now - this.idleTimer.startedAt;
      this.idleTimer.remainingMs = Math.max(0, this.idleTimer.durationMs - elapsed);
      clearTimeout(this.idleTimer.handle);
    }
    if (this.maxLifetimeTimer && this.maxLifetimeTimer.remainingMs === null) {
      const elapsed = now - this.maxLifetimeTimer.startedAt;
      this.maxLifetimeTimer.remainingMs = Math.max(0, this.maxLifetimeTimer.durationMs - elapsed);
      clearTimeout(this.maxLifetimeTimer.handle);
    }
  }

  private resumeTimers(): void {
    if (this.idleTimer && this.idleTimer.remainingMs !== null) {
      const ms = this.idleTimer.remainingMs;
      const fire = () => {
        this.idleTimer = null;
        void this.close('idle-timeout');
      };
      this.idleTimer = this.startTimer(ms, fire);
    }
    if (this.maxLifetimeTimer && this.maxLifetimeTimer.remainingMs !== null) {
      const ms = this.maxLifetimeTimer.remainingMs;
      const fire = () => {
        this.maxLifetimeTimer = null;
        void this.close('max-lifetime-exceeded');
      };
      this.maxLifetimeTimer = this.startTimer(ms, fire);
    }
  }

  private clearTimer(which: 'idleTimer' | 'maxLifetimeTimer'): void {
    const t = this[which];
    if (t) {
      clearTimeout(t.handle);
      this[which] = null;
    }
  }

  private clearTimers(): void {
    this.clearTimer('idleTimer');
    this.clearTimer('maxLifetimeTimer');
  }

  /**
   * Public-ish — bump lastUsedAt + restart the idle timer. Called by all
   * exec / sftp* paths AND by the manager when `acquire()` is called on an
   * existing live session.
   */
  touch(): void {
    this.lastUsedAt = new Date();
    if (this.state === 'open') {
      this.startIdleTimer();
    }
  }

  // ---------------------------------------------------------------------------
  // Internal — state machine
  // ---------------------------------------------------------------------------

  private transitionTo(to: EnvironmentLifecycleState, reason?: string): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    const evt: EnvironmentLifecycleEvent = {
      environmentId: this.environmentId,
      from,
      to,
      reason,
      at: new Date(),
    };
    try {
      this.emit('lifecycle', evt);
    } catch (err) {
      console.warn(`[EnvironmentSession] ${this.environmentId}: lifecycle listener threw:`, err);
    }
  }

  private tearDownClient(): void {
    if (this.client) {
      try { this.client.removeAllListeners(); } catch { /* ignore */ }
      try { this.client.end(); } catch { /* ignore */ }
      this.client = null;
    }
    this.sftp = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(s.length - max);
}

// Type accessor used to keep the inline closure types tidy without exposing
// the full ssh2 ClientChannel surface.
function streamAccessor(): unknown { return undefined; }
