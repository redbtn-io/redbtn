/**
 * Shared test helpers for the EnvironmentSession / EnvironmentManager suite.
 *
 * # MockSshClient
 *
 * A drop-in replacement for `ssh2.Client` that lets tests:
 *   - Resolve / reject the SSH handshake on demand
 *   - Simulate exec calls with controllable stdout/stderr/exitCode
 *   - Simulate SFTP read/write/stat/readdir
 *   - Trigger 'close' / 'error' / 'end' events to simulate drops
 *
 * The interface matches the subset of ssh2.Client that EnvironmentSession
 * actually uses (`connect`, `exec`, `sftp`, `end`, `removeAllListeners`,
 * `on`, `once`, `removeListener`, `emit`).
 *
 * # buildEnv() / buildSession()
 *
 * Helpers that produce sensible-default IEnvironment + EnvironmentSession
 * instances so tests can stay focused on the behaviour being asserted.
 */

import { EventEmitter } from 'events';
import type { IEnvironment } from '../../src/lib/environments/types';
import { EnvironmentSession } from '../../src/lib/environments/EnvironmentSession';
import { EnvironmentManager } from '../../src/lib/environments/EnvironmentManager';

// ---------------------------------------------------------------------------
// MockSshChannel — what ssh2.Client.exec() returns to its callback
// ---------------------------------------------------------------------------

export class MockSshChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  signalled: string | null = null;
  closed = false;

  signal(sig: string): void { this.signalled = sig; }
  close(): void { this.closed = true; }
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  end(): void {}

  /** Push stdout chunks (string or Buffer). */
  pushStdout(chunk: string | Buffer): void {
    this.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  pushStderr(chunk: string | Buffer): void {
    this.stderr.emit('data', typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  finish(exitCode: number): void {
    this.emit('close', exitCode);
  }
  fail(err: Error): void {
    this.emit('error', err);
  }
}

// ---------------------------------------------------------------------------
// MockSftp — what ssh2.Client.sftp() callback receives
// ---------------------------------------------------------------------------

interface MockFile {
  content: Buffer;
  mode: number;
  modifiedAt: Date;
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  isBlockDevice: boolean;
  isCharacterDevice: boolean;
  isSocket: boolean;
  isFIFO: boolean;
}

interface MockDirEntry {
  filename: string;
  longname: string;
  attrs: MockStats;
}

interface MockStats {
  size: number;
  mode: number;
  mtime: number; // seconds since epoch
  atime: number;
  uid: number;
  gid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isSymbolicLink(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

export class MockSftp extends EventEmitter {
  // path -> file
  files = new Map<string, MockFile>();
  // path -> entry list
  directories = new Map<string, string[]>();

  /** Pre-populate a file. */
  putFile(path: string, content: string | Buffer, mode = 0o644): void {
    this.files.set(path, {
      content: typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
      mode,
      modifiedAt: new Date(),
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      isBlockDevice: false,
      isCharacterDevice: false,
      isSocket: false,
      isFIFO: false,
    });
  }

  putDir(path: string, entries: string[]): void {
    this.directories.set(path, entries);
    this.files.set(path, {
      content: Buffer.alloc(0),
      mode: 0o755,
      modifiedAt: new Date(),
      isDirectory: true,
      isFile: false,
      isSymbolicLink: false,
      isBlockDevice: false,
      isCharacterDevice: false,
      isSocket: false,
      isFIFO: false,
    });
  }

  // SFTP API the session uses ----------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readFile(path: string, _opts: unknown, cb: (err: Error | undefined, data: Buffer) => void): void {
    const file = this.files.get(path);
    if (!file) return cb(new Error(`ENOENT: ${path}`), Buffer.alloc(0));
    cb(undefined, file.content);
  }

  writeFile(path: string, data: string | Buffer, cb: (err?: Error | null) => void): void {
    this.files.set(path, {
      content: typeof data === 'string' ? Buffer.from(data, 'utf8') : data,
      mode: 0o644,
      modifiedAt: new Date(),
      isDirectory: false,
      isFile: true,
      isSymbolicLink: false,
      isBlockDevice: false,
      isCharacterDevice: false,
      isSocket: false,
      isFIFO: false,
    });
    cb();
  }

  rename(from: string, to: string, cb: (err?: Error | null) => void): void {
    const f = this.files.get(from);
    if (!f) return cb(new Error(`ENOENT: ${from}`));
    this.files.set(to, f);
    this.files.delete(from);
    cb();
  }

  unlink(path: string, cb: (err?: Error | null) => void): void {
    this.files.delete(path);
    cb();
  }

  chmod(path: string, mode: number, cb: (err?: Error | null) => void): void {
    const f = this.files.get(path);
    if (!f) return cb(new Error(`ENOENT: ${path}`));
    f.mode = mode;
    cb();
  }

  stat(path: string, cb: (err: Error | undefined, stats: MockStats) => void): void {
    const f = this.files.get(path);
    if (!f) return cb(new Error(`ENOENT: ${path}`), {} as MockStats);
    cb(undefined, this.toStats(f));
  }

  readdir(path: string, cb: (err: Error | undefined, list: MockDirEntry[]) => void): void {
    const entries = this.directories.get(path);
    if (!entries) return cb(new Error(`ENOENT: ${path}`), []);
    const list: MockDirEntry[] = entries.map((name) => {
      const childPath = `${path}/${name}`;
      const childFile = this.files.get(childPath);
      const stats = childFile ? this.toStats(childFile) : this.toStats({
        content: Buffer.alloc(0),
        mode: 0o644,
        modifiedAt: new Date(),
        isDirectory: false,
        isFile: true,
        isSymbolicLink: false,
        isBlockDevice: false,
        isCharacterDevice: false,
        isSocket: false,
        isFIFO: false,
      });
      return { filename: name, longname: name, attrs: stats };
    });
    cb(undefined, list);
  }

  private toStats(f: MockFile): MockStats {
    const mtime = Math.floor(f.modifiedAt.getTime() / 1000);
    return {
      size: f.content.length,
      mode: f.mode,
      mtime,
      atime: mtime,
      uid: 0,
      gid: 0,
      isDirectory: () => f.isDirectory,
      isFile: () => f.isFile,
      isBlockDevice: () => f.isBlockDevice,
      isCharacterDevice: () => f.isCharacterDevice,
      isSymbolicLink: () => f.isSymbolicLink,
      isFIFO: () => f.isFIFO,
      isSocket: () => f.isSocket,
    };
  }
}

// ---------------------------------------------------------------------------
// MockSshClient — what `new ssh2.Client()` constructs
// ---------------------------------------------------------------------------

export interface MockBehaviour {
  /**
   * If set, connect() will defer the 'ready' event until this resolves. If
   * the function rejects, an 'error' event is emitted with the rejection.
   */
  onConnect?: (client: MockSshClient) => Promise<void>;
  /**
   * If set, every exec() will call this with the command. The handler can
   * push output via the channel and call channel.finish().
   */
  onExec?: (command: string, channel: MockSshChannel) => void;
  /**
   * If set, sftp() will defer until this resolves. If it rejects, the sftp
   * callback receives the error.
   */
  onSftp?: () => Promise<void>;
  /**
   * Hand-out a custom MockSftp (so multiple clients can share state).
   */
  sftp?: MockSftp;
}

export class MockSshClient extends EventEmitter {
  /** Set by tests after construction so they can wire in a fresh sftp / exec handler per session. */
  behaviour: MockBehaviour = {};
  ended = false;
  connectCalls = 0;
  execCalls: string[] = [];
  sftpCalls = 0;

  /** All in-flight channels — used to fail them on simulateDrop / end. */
  private openChannels = new Set<MockSshChannel>();

  /**
   * The MockSftp this client returns from sftp(). Lazy-initialized so tests
   * can override before sftp() is called.
   */
  get sftp_(): MockSftp {
    if (!this.behaviour.sftp) this.behaviour.sftp = new MockSftp();
    return this.behaviour.sftp;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect(_config: any): this {
    this.connectCalls += 1;
    const fire = async () => {
      try {
        if (this.behaviour.onConnect) {
          await this.behaviour.onConnect(this);
        }
        if (!this.ended) this.emit('ready');
      } catch (err) {
        if (!this.ended) this.emit('error', err);
      }
    };
    // Defer to next tick so the caller can attach .once('ready') first.
    setImmediate(fire);
    return this;
  }

  exec(command: string, cbOrOpts: unknown, maybeCb?: unknown): this {
    this.execCalls.push(command);
    const cb = (typeof cbOrOpts === 'function' ? cbOrOpts : maybeCb) as (err: Error | undefined, channel: MockSshChannel) => void;
    if (!cb) throw new Error('mock: no exec callback');

    const channel = new MockSshChannel();
    this.openChannels.add(channel);
    // Auto-remove from tracking set on close/error so we don't double-fail.
    channel.once('close', () => this.openChannels.delete(channel));
    channel.once('error', () => this.openChannels.delete(channel));
    setImmediate(() => {
      try {
        cb(undefined, channel);
        if (this.behaviour.onExec) {
          this.behaviour.onExec(command, channel);
        } else {
          // Default: empty stdout, exit 0.
          setImmediate(() => channel.finish(0));
        }
      } catch (err) {
        cb(err as Error, channel);
      }
    });
    return this;
  }

  sftp(cb: (err: Error | undefined, sftp: MockSftp) => void): this {
    this.sftpCalls += 1;
    const fire = async () => {
      try {
        if (this.behaviour.onSftp) {
          await this.behaviour.onSftp();
        }
        cb(undefined, this.sftp_);
      } catch (err) {
        cb(err as Error, undefined as unknown as MockSftp);
      }
    };
    setImmediate(fire);
    return this;
  }

  end(): this {
    this.ended = true;
    setImmediate(() => this.emit('close'));
    return this;
  }

  /** Test hook — simulate an unexpected drop. */
  simulateDrop(reason: string = 'simulated'): void {
    // Step 1: emit the client-level 'close' synchronously — this is what
    // EnvironmentSession reacts to, transitioning state to 'degraded'.
    if (this.listenerCount('close') > 0) this.emit('close');
    if (this.listenerCount('error') > 0) this.emit('error', new Error(`drop: ${reason}`));
    // Step 2: fail every in-flight channel on a deferred tick so the
    // session has time to flip into degraded BEFORE the channel error
    // propagates back to the in-flight exec promise. This matches what
    // happens with real ssh2: socket drop is detected first, then channel
    // streams error out.
    const channels = Array.from(this.openChannels);
    for (const ch of channels) {
      setImmediate(() => {
        try { ch.fail(new Error(`drop: ${reason}`)); } catch { /* ignore */ }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Sensible defaults
// ---------------------------------------------------------------------------

export function buildEnv(overrides: Partial<IEnvironment> = {}): IEnvironment {
  return {
    environmentId: 'env_test',
    userId: 'user_test',
    name: 'Test Env',
    kind: 'self-hosted',
    host: '127.0.0.1',
    port: 22,
    user: 'tester',
    secretRef: 'TEST_KEY',
    workingDir: '/tmp',
    idleTimeoutMs: 5_000,
    maxLifetimeMs: 60_000,
    reconnect: {
      maxAttempts: 3,
      backoffMs: 50,
      maxBackoffMs: 500,
    },
    archiveOutputLogs: false,
    isPublic: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function buildSession(opts: {
  env?: Partial<IEnvironment>;
  client?: MockSshClient;
  onExecComplete?: Parameters<typeof EnvironmentSession.prototype['constructor']>[0]['onExecComplete'];
  runId?: string;
} = {}): { session: EnvironmentSession; client: MockSshClient } {
  const env = buildEnv(opts.env);
  const client = opts.client ?? new MockSshClient();
  const session = new EnvironmentSession({
    env,
    sshKey: 'ssh-key-bytes',
    userId: env.userId,
    clientFactory: () => client as unknown as ReturnType<NonNullable<Parameters<typeof EnvironmentSession.prototype['constructor']>[0]['clientFactory']>>,
    onExecComplete: opts.onExecComplete,
    runId: opts.runId,
  });
  return { session, client };
}

export function buildManager(opts: {
  clientFactory?: () => MockSshClient;
} = {}): EnvironmentManager {
  return new EnvironmentManager({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clientFactory: opts.clientFactory as any,
  });
}

/** Wait one micro-task tick, then a settle on setImmediate, then a setTimeout(0). */
export async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setTimeout(r, 0));
}

/** Sleep for n ms (real time). */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
