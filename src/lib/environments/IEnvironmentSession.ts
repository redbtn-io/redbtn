/**
 * IEnvironmentSession — the transport-agnostic environment session surface
 * (exec-binding Goal 4).
 *
 * Both `EnvironmentSession` (SSH/ssh2) and `DesktopAgentSession` (push connector
 * over the /ws/desktop relay) implement this. The native env tools
 * (`run_command`, `ssh_shell` environmentId-mode, `read_file`, `ssh_copy`)
 * consume the session THROUGH this interface, so they work identically against
 * an SSH box or a push connector with NO tool-source changes — the concrete
 * session class is chosen by `env.kind` in `EnvironmentManager.acquire`.
 *
 * @module lib/environments/IEnvironmentSession
 */

import type { EventEmitter } from 'node:events';
import type {
  ExecOptions,
  ExecResult,
  SftpReadOptions,
  SftpWriteOptions,
  SftpStatResult,
  SftpDirEntry,
  EnvironmentLifecycleState,
} from './types';

export interface IEnvironmentSession extends EventEmitter {
  /** The environment this session targets. */
  readonly environmentId: string;

  /** Lifecycle state — the pool keeps live sessions and evicts on `closed`. */
  readonly state: EnvironmentLifecycleState;

  /** Reset the idle timer (keepalive) so a caller's use keeps the session warm. */
  touch(): void;

  /** Open/ready the session (SSH: connect; push: presence-check, no socket to open). */
  open(): Promise<void>;

  /** Run a command; returns buffered stdout/stderr/exitCode. Emits live output events. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;

  /** Read a file (optionally a byte range). */
  sftpRead(path: string, opts?: SftpReadOptions): Promise<Buffer>;

  /** Write a file (atomic where supported; optional mode). */
  sftpWrite(path: string, content: Buffer | string, opts?: SftpWriteOptions): Promise<void>;

  /** Stat a path. */
  sftpStat(path: string): Promise<SftpStatResult>;

  /** List a directory. */
  sftpReaddir(path: string): Promise<SftpDirEntry[]>;

  /** Tear down the session. */
  close(reason?: string): Promise<void>;
}
