/**
 * DesktopAgentSession — an IEnvironmentSession over the push-connector relay
 * (exec-binding Goal 4, P4b).
 *
 * Implements the SAME surface as `EnvironmentSession` but instead of an ssh2
 * socket it round-trips through the existing `/ws/desktop` gateway relay
 * (`requestDesktopRaw` → `desktop:cmd:{userId}:{installId}` → `desktop:reply:{id}`).
 * So the env tools (`run_command`/`ssh_shell`/`read_file`/`ssh_copy`) work against
 * a `desktop-agent`/`cli` connector with NO tool changes — the concrete class is
 * chosen by `env.kind` in `EnvironmentManager.acquire` (P4c).
 *
 * MVP is BUFFERED exec (reuses the existing `desktop_exec` wire shape). Live
 * streaming (`desktop:stream:{id}` chunks, D15) layers on in P4d once the gateway
 * forwards `exec_chunk` and the connector emits them — buffered is the degrade path.
 *
 * SFTP rides new relay kinds (`sftp_read`/`sftp_write`/`sftp_stat`/`sftp_readdir`)
 * the connector implements in Goal 5. Payloads are base64; a single sftp payload is
 * capped (EXEC_SFTP_MAX_BYTES) — larger reads/writes must chunk via offset/length.
 *
 * There is no socket to hold open: presence is the readiness check and the relay's
 * timeout is the presence detector. `open()`/`close()` just manage lifecycle state
 * so the manager pool evicts correctly.
 *
 * @module lib/environments/DesktopAgentSession
 */

import { EventEmitter } from 'events';
import { requestDesktopRaw } from '../tools/native/desktop-request';
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

/** Max bytes for a single sftp payload over the relay (Redis pub/sub, not a stream). */
const SFTP_MAX_BYTES = (() => {
  const v = parseInt(process.env.EXEC_SFTP_MAX_BYTES ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 8 * 1024 * 1024; // 8 MB
})();

/** Error thrown when a relay op fails (connector error, timeout, oversized). */
export class DesktopAgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'DesktopAgentError';
  }
}

export class DesktopAgentSession extends EventEmitter implements IEnvironmentSession {
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
    // No socket. Presence is the readiness check; the relay timeout is the
    // detector. Mark open so the pool treats us as live.
    this.transition('open');
  }

  async close(reason = 'explicit'): Promise<void> {
    this.transition('closed', reason);
  }

  /** Keepalive no-op — push sessions have no idle socket to keep warm. */
  touch(): void {
    /* intentional no-op */
  }

  // ── exec ────────────────────────────────────────────────────────────────
  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return this.serialize(async () => {
      const reply = await requestDesktopRaw({
        userId: this.userId,
        installId: this.installId,
        kind: 'exec',
        timeoutMs: opts.timeout ?? this.timeoutMs,
        payload: {
          command,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.env ? { env: opts.env } : {}),
          ...(opts.timeout ? { timeoutMs: opts.timeout } : {}),
        },
      });
      if (!reply || reply.ok !== true) {
        throw this.replyError(reply, 'exec');
      }
      const r = (reply.result ?? {}) as Partial<ExecResult>;
      return {
        stdout: typeof r.stdout === 'string' ? r.stdout : '',
        stderr: typeof r.stderr === 'string' ? r.stderr : '',
        exitCode: typeof r.exitCode === 'number' ? r.exitCode : (reply.ok ? 0 : 1),
        durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
        truncated: r.truncated === true,
      };
    });
  }

  // ── sftp ──────────────────────────────────────────────────────────────────
  sftpRead(path: string, opts: SftpReadOptions = {}): Promise<Buffer> {
    return this.serialize(async () => {
      const reply = await this.relay('sftp_read', { path, ...opts });
      const b64 = (reply.result as { contentB64?: string } | undefined)?.contentB64 ?? '';
      const buf = Buffer.from(b64, 'base64');
      if (buf.length > SFTP_MAX_BYTES) {
        throw new DesktopAgentError('payload_too_large',
          `sftpRead of ${path} exceeds ${SFTP_MAX_BYTES} bytes; read a byte range (offset/length).`);
      }
      return buf;
    });
  }

  sftpWrite(path: string, content: Buffer | string, opts: SftpWriteOptions = {}): Promise<void> {
    return this.serialize(async () => {
      const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
      if (buf.length > SFTP_MAX_BYTES) {
        throw new DesktopAgentError('payload_too_large',
          `sftpWrite of ${path} exceeds ${SFTP_MAX_BYTES} bytes; write in chunks.`);
      }
      await this.relay('sftp_write', {
        path,
        contentB64: buf.toString('base64'),
        ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
      });
    });
  }

  sftpStat(path: string): Promise<SftpStatResult> {
    return this.serialize(async () => {
      const reply = await this.relay('sftp_stat', { path });
      const s = (reply.result ?? {}) as Record<string, unknown>;
      return {
        size: Number(s.size ?? 0),
        mode: Number(s.mode ?? 0),
        modifiedAt: s.modifiedAt ? new Date(s.modifiedAt as string | number) : new Date(0),
        isDirectory: s.isDirectory === true,
        isFile: s.isFile === true,
        isSymbolicLink: s.isSymbolicLink === true,
      };
    });
  }

  sftpReaddir(path: string): Promise<SftpDirEntry[]> {
    return this.serialize(async () => {
      const reply = await this.relay('sftp_readdir', { path });
      const entries = ((reply.result as { entries?: unknown[] } | undefined)?.entries ?? []) as Record<string, unknown>[];
      return entries.map((e) => ({
        name: String(e.name ?? ''),
        type: (['file', 'dir', 'link', 'other'].includes(String(e.type)) ? e.type : 'other') as SftpDirEntry['type'],
        size: Number(e.size ?? 0),
        modifiedAt: e.modifiedAt ? new Date(e.modifiedAt as string | number) : new Date(0),
      }));
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Round-trip a relay op; throw a mapped error on failure. */
  private async relay(kind: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reply = await requestDesktopRaw({
      userId: this.userId,
      installId: this.installId,
      kind,
      timeoutMs: this.timeoutMs,
      payload,
    });
    if (!reply || reply.ok !== true) throw this.replyError(reply, kind);
    return reply as Record<string, unknown>;
  }

  private replyError(reply: Record<string, unknown> | null | undefined, kind: string): DesktopAgentError {
    const err = (reply?.error ?? {}) as { code?: string; message?: string };
    return new DesktopAgentError(err.code ?? 'desktop_failed',
      err.message ?? `${kind} failed on desktop-agent environment ${this.environmentId}`);
  }

  private transition(to: EnvironmentLifecycleState, reason = ''): void {
    const from = this.state;
    if (from === to) return;
    this.state = to;
    this.emit('lifecycle', { environmentId: this.environmentId, from, to, reason, at: new Date() });
  }

  /** Serialize ops behind any prior in-flight op (mirrors EnvironmentSession). */
  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const next = this.opChain.then(() => op(), () => op());
    this.opChain = next.catch(() => undefined);
    return next;
  }
}
