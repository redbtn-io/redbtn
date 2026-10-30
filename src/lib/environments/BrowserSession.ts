/**
 * BrowserSession — an IEnvironmentSession for `browser` environments (the
 * redbtn Browser extension).
 *
 * A browser env is a push-model connector like `desktop-agent`/`cli`: the
 * extension holds an OUTBOUND connection to the webapp gateway and the engine
 * targets it by installId over the same Redis relay (`requestDesktopRaw`).
 * There is no socket to hold open and no SSH at all — one env per browser
 * profile.
 *
 * Unlike DesktopAgentSession, this class deliberately does NOT implement the
 * exec/sftp surface over the relay: a browser cannot run shell commands or
 * serve SFTP. Those methods throw `BrowserUnsupportedError` so a generic env
 * tool pointed at a browser env fails loudly and immediately instead of
 * relaying a request the extension cannot honour. Real browser work goes
 * through `browser()` below, which the `browser_*` native tools dispatch.
 *
 * Lifecycle mirrors DesktopAgentSession: `open()` just marks the session open
 * (presence is the readiness check, done per-call in `browser()`), `close()`
 * marks it closed, `touch()` is a no-op, and ops are serialized behind a
 * private op chain.
 *
 * @module lib/environments/BrowserSession
 */

import { EventEmitter } from 'events';
import { requestDesktopRaw } from '../tools/native/desktop-request';
import { probeDesktopPresence, type LivenessResult } from './desktop-presence';
import { DesktopAgentError, ENV_OFFLINE, offlineMessage } from './DesktopAgentSession';
import type { IEnvironmentSession } from './IEnvironmentSession';
import type {
  IEnvironment,
  ExecOptions,
  ExecResult,
  SftpReadOptions,
  SftpWriteOptions,
  SftpStatResult,
  SftpDirEntry,
  EnvironmentLifecycleState,
} from './types';

/** One browser action frame sent to the extension (e.g. `{ action: 'snapshot' }`). */
export type BrowserRequest = {
  action: string;
  runId?: string;
  agentName?: string;
  [key: string]: unknown;
};

/** Per-call overrides for `BrowserSession.browser()`. */
export interface BrowserCallOptions {
  /** Relay wait for this call; defaults to the session's relay timeout. */
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/**
 * Thrown by the exec/sftp surface of a browser session. `code` is the stable
 * machine-readable `'unsupported'` so callers can branch on it instead of
 * matching the message.
 */
export class BrowserUnsupportedError extends Error {
  readonly code = 'unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'BrowserUnsupportedError';
  }
}

export class BrowserSession extends EventEmitter implements IEnvironmentSession {
  readonly environmentId: string;
  state: EnvironmentLifecycleState = 'closed';
  private opChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly env: IEnvironment,
    private readonly userId: string,
    private readonly installId: string,
    private readonly timeoutMs?: number,
  ) {
    super();
    this.environmentId = env.environmentId;
  }

  async open(): Promise<void> {
    // No socket. Presence is the readiness check (done per `browser()` call);
    // mark open so the pool treats us as live.
    this.transition('open');
  }

  async close(reason = 'explicit'): Promise<void> {
    this.transition('closed', reason);
  }

  /** Keepalive no-op — push sessions have no idle socket to keep warm. */
  touch(): void {
    /* intentional no-op */
  }

  // ── exec / sftp — NOT supported on a browser ─────────────────────────────
  // A browser profile has no shell and no filesystem to serve. These throw
  // (as rejected promises) rather than relaying an op the extension cannot
  // honour, so a generic env tool fails in one step with a clear reason.

  async exec(_command: string, _opts: ExecOptions = {}): Promise<ExecResult> {
    throw new BrowserUnsupportedError(
      'unsupported: browser environments have no exec/sftp — use the browser_* tools',
    );
  }

  async sftpRead(_path: string, _opts: SftpReadOptions = {}): Promise<Buffer> {
    throw new BrowserUnsupportedError(
      'unsupported: browser environments have no sftp — use the browser_* tools',
    );
  }

  async sftpWrite(_path: string, _content: Buffer | string, _opts: SftpWriteOptions = {}): Promise<void> {
    throw new BrowserUnsupportedError(
      'unsupported: browser environments have no sftp — use the browser_* tools',
    );
  }

  async sftpStat(_path: string): Promise<SftpStatResult> {
    throw new BrowserUnsupportedError(
      'unsupported: browser environments have no sftp — use the browser_* tools',
    );
  }

  async sftpReaddir(_path: string): Promise<SftpDirEntry[]> {
    throw new BrowserUnsupportedError(
      'unsupported: browser environments have no sftp — use the browser_* tools',
    );
  }

  // ── browser dispatch ──────────────────────────────────────────────────────

  /**
   * Dispatch ONE browser frame to the extension and return its full reply.
   *
   * Pre-flight: probe the hub's presence key for this install; an `offline`
   * verdict throws `DesktopAgentError(ENV_OFFLINE, …)` immediately instead of
   * burning the relay timeout (mirrors DesktopAgentSession's pre-flight).
   *
   * The reply is returned verbatim — including connector-level failures
   * (`reply.ok !== true`) — because callers read `ok`/`error` themselves;
   * this method does NOT throw on an `ok: false` reply. (requestDesktopRaw
   * itself is fail-safe and reports transport failures the same way.)
   */
  browser(request: BrowserRequest, opts: BrowserCallOptions = {}): Promise<Record<string, unknown>> {
    return this.serialize(async () => {
      const before = await this.probeLiveness();
      if (before.verdict === 'offline') {
        throw new DesktopAgentError(
          ENV_OFFLINE,
          offlineMessage(this.environmentId, before.offlineForSeconds),
        );
      }
      const reply = await requestDesktopRaw({
        userId: this.userId,
        installId: this.installId,
        kind: 'browser',
        payload: { request },
        timeoutMs: opts.timeoutMs ?? this.timeoutMs,
        abortSignal: opts.abortSignal,
      });
      return reply as Record<string, unknown>;
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Ask the hub whether this connector is still registered. Never throws. */
  private probeLiveness(): Promise<LivenessResult> {
    return probeDesktopPresence({
      userId: this.userId,
      installId: this.installId,
      lastSeenAt: this.env.lastSeenAt,
    });
  }

  private transition(to: EnvironmentLifecycleState, reason = ''): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.emit('lifecycle', { environmentId: this.environmentId, from, to, reason, at: new Date() });
  }

  /** Serialize ops behind any prior in-flight op (mirrors DesktopAgentSession). */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(() => op(), () => op());
    this.opChain = next.catch(() => undefined);
    return next;
  }
}
