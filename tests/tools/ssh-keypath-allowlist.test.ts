/**
 * SSH key-path allowlist — security regression suite.
 *
 * Covers the shared guard (`readAllowlistedSshKey`) plus its wiring into both
 * `ssh_shell` and `ssh_copy`. The guard replaces the old arbitrary-file-read
 * primitive where a caller-supplied `sshKeyPath` was `fs.readFileSync`'d off the
 * worker host with no bounds.
 *
 * Acceptance criteria exercised here:
 *  - allowlist unset  → sshKeyPath refused, error names SSH_KEY_PATH_ALLOWED_DIRS,
 *    no connection attempted (ssh_shell + ssh_copy).
 *  - allowlist set     → a regular key file inside it is read by both tools.
 *  - rejected          → `..` escape, symlink escaping an allowed dir, sibling
 *    dir sharing a name prefix, and a non-regular-file target.
 *  - both tools route through the shared helper (no bare readFileSync remains).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readAllowlistedSshKey,
  SSH_KEY_PATH_ALLOWLIST_ENV,
} from '../../src/lib/tools/native/ssh-key-path';
import sshShellTool, { __setSshClientFactoryForTests } from '../../src/lib/tools/native/ssh-shell';
import sshCopyTool, { __setSshCopyClientFactoryForTests } from '../../src/lib/tools/native/ssh-copy';
import { MockSshClient } from '../environments/_helpers';

function parseToolResult(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** Minimal SSH client that records the config it was handed, then errors out. */
class CapturingClient extends EventEmitter {
  connectCalls = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lastConfig: any = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connect(config: any): this {
    this.connectCalls += 1;
    this.lastConfig = config;
    // Fire an error AFTER the key has been read + placed on the config, so the
    // handler settles cleanly without needing a real network or SFTP mock.
    setImmediate(() => this.emit('error', new Error('capture-stop')));
    return this;
  }
  end(): this {
    return this;
  }
}

describe('ssh key-path allowlist', () => {
  let tmp: string;
  let savedAllow: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-keypath-'));
    savedAllow = process.env[SSH_KEY_PATH_ALLOWLIST_ENV];
    delete process.env[SSH_KEY_PATH_ALLOWLIST_ENV];
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (savedAllow === undefined) delete process.env[SSH_KEY_PATH_ALLOWLIST_ENV];
    else process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = savedAllow;
    __setSshClientFactoryForTests(null);
    __setSshCopyClientFactoryForTests(null);
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Helper — default-deny
  // -------------------------------------------------------------------------
  describe('readAllowlistedSshKey — default deny', () => {
    it('refuses a readable key file and names the env var when the allowlist is unset', () => {
      const key = path.join(tmp, 'id_ed25519');
      fs.writeFileSync(key, 'PRIVATE-KEY-BYTES');
      expect(() => readAllowlistedSshKey(key)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('refuses even a readable non-key path like /etc/passwd when unset', () => {
      expect(() => readAllowlistedSshKey('/etc/passwd')).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('refuses when the allowlist is only whitespace/empty entries', () => {
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = '   ,  ';
      const key = path.join(tmp, 'id');
      fs.writeFileSync(key, 'K');
      expect(() => readAllowlistedSshKey(key)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('refuses when every allowlist entry is unusable (relative / missing)', () => {
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = `relative/dir, ${path.join(tmp, 'missing')}`;
      const key = path.join(tmp, 'id');
      fs.writeFileSync(key, 'K');
      expect(() => readAllowlistedSshKey(key)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('treats an allowlist entry that is a file (not a directory) as unusable', () => {
      const fileEntry = path.join(tmp, 'a-file');
      fs.writeFileSync(fileEntry, 'x');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = fileEntry;
      const key = path.join(tmp, 'id');
      fs.writeFileSync(key, 'K');
      expect(() => readAllowlistedSshKey(key)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });
  });

  // -------------------------------------------------------------------------
  // Helper — allowed reads
  // -------------------------------------------------------------------------
  describe('readAllowlistedSshKey — allowed', () => {
    it('reads a regular key file inside an allowlisted directory', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const key = path.join(allowed, 'id_ed25519');
      fs.writeFileSync(key, 'PRIVATE-KEY-BYTES');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(readAllowlistedSshKey(key).toString()).toBe('PRIVATE-KEY-BYTES');
    });

    it('reads a key nested in a subdirectory of an allowlisted directory', () => {
      const allowed = path.join(tmp, 'allowed');
      const sub = path.join(allowed, 'nested', 'deeper');
      fs.mkdirSync(sub, { recursive: true });
      const key = path.join(sub, 'id');
      fs.writeFileSync(key, 'NESTED');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(readAllowlistedSshKey(key).toString()).toBe('NESTED');
    });

    it('honors a valid entry even when other entries in the list are unusable', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const key = path.join(allowed, 'id');
      fs.writeFileSync(key, 'K');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] =
        `relative/dir, ${path.join(tmp, 'missing')}, ${allowed}`;
      expect(readAllowlistedSshKey(key).toString()).toBe('K');
    });

    it('expands a leading ~ for both the allowlist entry and the candidate path', () => {
      const home = path.join(tmp, 'home');
      fs.mkdirSync(home);
      const key = path.join(home, 'id_ed25519');
      fs.writeFileSync(key, 'HOMEKEY');
      // os.homedir() honors $HOME on POSIX — cheaper + more robust than spying
      // on a non-configurable ESM export.
      const savedHome = process.env.HOME;
      process.env.HOME = home;
      try {
        process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = '~';
        expect(readAllowlistedSshKey('~/id_ed25519').toString()).toBe('HOMEKEY');
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Helper — rejections (traversal / symlink / prefix / non-file)
  // -------------------------------------------------------------------------
  describe('readAllowlistedSshKey — rejects escapes', () => {
    it('rejects a path escaping the allowlist via ..', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const secret = path.join(tmp, 'secret.key');
      fs.writeFileSync(secret, 'SECRET');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      const escape = path.join(allowed, '..', 'secret.key');
      expect(() => readAllowlistedSshKey(escape)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('rejects a symlink inside an allowed dir whose target is outside it', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const outside = path.join(tmp, 'outside.key');
      fs.writeFileSync(outside, 'OUTSIDE');
      const link = path.join(allowed, 'link.key');
      fs.symlinkSync(outside, link);
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(() => readAllowlistedSshKey(link)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('rejects a sibling directory sharing a name prefix with an allowed entry', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const sibling = path.join(tmp, 'allowed-evil');
      fs.mkdirSync(sibling);
      const key = path.join(sibling, 'id');
      fs.writeFileSync(key, 'EVIL');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(() => readAllowlistedSshKey(key)).toThrow(SSH_KEY_PATH_ALLOWLIST_ENV);
    });

    it('rejects a non-regular-file target (a directory) even inside the allowlist', () => {
      const allowed = path.join(tmp, 'allowed');
      const sub = path.join(allowed, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(() => readAllowlistedSshKey(sub)).toThrow(/not a regular file/);
    });

    it('rejects a non-existent path inside the allowlist', () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      expect(() => readAllowlistedSshKey(path.join(allowed, 'nope'))).toThrow(/Cannot resolve/);
    });
  });

  // -------------------------------------------------------------------------
  // ssh_shell integration
  // -------------------------------------------------------------------------
  describe('ssh_shell wiring', () => {
    it('refuses a sshKeyPath naming the env var and never connects when allowlist is unset', async () => {
      const key = path.join(tmp, 'id');
      fs.writeFileSync(key, 'K');
      let client: MockSshClient | null = null;
      __setSshClientFactoryForTests(() => {
        client = new MockSshClient();
        return client as unknown as ReturnType<NonNullable<Parameters<typeof __setSshClientFactoryForTests>[0]>>;
      });

      const result = await sshShellTool.handler(
        { host: 'localhost', user: 'alpha', command: 'true', sshKeyPath: key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      const body = parseToolResult(result);

      expect(result.isError).toBeTruthy();
      expect(body.error).toContain(SSH_KEY_PATH_ALLOWLIST_ENV);
      expect(client!.connectCalls).toBe(0);
    });

    it('refuses an absolute path like /etc/passwd when allowlist is unset', async () => {
      let client: MockSshClient | null = null;
      __setSshClientFactoryForTests(() => {
        client = new MockSshClient();
        return client as unknown as ReturnType<NonNullable<Parameters<typeof __setSshClientFactoryForTests>[0]>>;
      });

      const result = await sshShellTool.handler(
        { host: 'localhost', user: 'alpha', command: 'true', sshKeyPath: '/etc/passwd' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      const body = parseToolResult(result);

      expect(result.isError).toBeTruthy();
      expect(body.error).toContain(SSH_KEY_PATH_ALLOWLIST_ENV);
      expect(client!.connectCalls).toBe(0);
    });

    it('reads an allowlisted key and runs the command', async () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const key = path.join(allowed, 'id');
      fs.writeFileSync(key, 'PRIV');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      __setSshClientFactoryForTests(
        () => new MockSshClient() as unknown as ReturnType<NonNullable<Parameters<typeof __setSshClientFactoryForTests>[0]>>,
      );

      const result = await sshShellTool.handler(
        { host: 'localhost', user: 'alpha', command: 'echo hi', sshKeyPath: key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      const body = parseToolResult(result);

      expect(result.isError).toBeFalsy();
      expect(body.success).toBe(true);
      expect(body.exitCode).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // ssh_copy integration
  // -------------------------------------------------------------------------
  describe('ssh_copy wiring', () => {
    it('refuses a sshKeyPath naming the env var and never connects when allowlist is unset', async () => {
      const key = path.join(tmp, 'id');
      fs.writeFileSync(key, 'K');
      let client: MockSshClient | null = null;
      __setSshCopyClientFactoryForTests(() => {
        client = new MockSshClient();
        return client as unknown as ReturnType<NonNullable<Parameters<typeof __setSshCopyClientFactoryForTests>[0]>>;
      });

      const result = await sshCopyTool.handler(
        { host: 'localhost', user: 'alpha', remotePath: '/tmp/out.txt', content: 'hello', sshKeyPath: key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      const body = parseToolResult(result);

      expect(result.isError).toBeTruthy();
      expect(body.error).toContain(SSH_KEY_PATH_ALLOWLIST_ENV);
      expect(client!.connectCalls).toBe(0);
    });

    it('reads an allowlisted key and hands the exact bytes to the ssh client', async () => {
      const allowed = path.join(tmp, 'allowed');
      fs.mkdirSync(allowed);
      const key = path.join(allowed, 'id');
      fs.writeFileSync(key, 'PRIVATE-COPY-KEY');
      process.env[SSH_KEY_PATH_ALLOWLIST_ENV] = allowed;
      const client = new CapturingClient();
      __setSshCopyClientFactoryForTests(
        () => client as unknown as ReturnType<NonNullable<Parameters<typeof __setSshCopyClientFactoryForTests>[0]>>,
      );

      const result = await sshCopyTool.handler(
        { host: 'localhost', user: 'alpha', remotePath: '/tmp/out.txt', content: 'hello', sshKeyPath: key },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
      const body = parseToolResult(result);

      // The connection was reached (proving the key read succeeded) and the
      // exact allowlisted key bytes were placed on the ssh2 config.
      expect(result.isError).toBeTruthy();
      expect(body.error).toContain('capture-stop');
      expect(client.connectCalls).toBe(1);
      expect(Buffer.isBuffer(client.lastConfig.privateKey)).toBe(true);
      expect(client.lastConfig.privateKey.toString()).toBe('PRIVATE-COPY-KEY');
    });
  });

  // -------------------------------------------------------------------------
  // Static guard — no bare caller-supplied readFileSync remains
  // -------------------------------------------------------------------------
  describe('source wiring', () => {
    it('routes both tools through the shared helper with no bare fs.readFileSync', () => {
      const shellSrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/lib/tools/native/ssh-shell.ts'),
        'utf-8',
      );
      const copySrc = fs.readFileSync(
        path.resolve(__dirname, '../../src/lib/tools/native/ssh-copy.ts'),
        'utf-8',
      );
      expect(shellSrc).toContain('readAllowlistedSshKey');
      expect(copySrc).toContain('readAllowlistedSshKey');
      expect(shellSrc).not.toMatch(/fs\.readFileSync/);
      expect(copySrc).not.toMatch(/fs\.readFileSync/);
    });
  });
});
