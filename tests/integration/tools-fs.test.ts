/**
 * Integration test for the native fs pack (Env Phase C).
 *
 * Per ENVIRONMENT-HANDOFF.md §6.2 — "full file lifecycle on a real repo
 * (read → edit → glob → grep → list_dir)" smoke after the phase deploys.
 *
 * This unit-style integration uses an in-memory fake EnvironmentSession (the
 * SFTP "filesystem" is just a `Map<path, string>`) so it can run anywhere
 * without touching real SSH. The chain it walks:
 *
 *   1. write_file       — create three files in the in-memory FS
 *   2. read_file        — read one back, verify line-numbered output
 *   3. edit_file        — find/replace inside a file (unique-match)
 *   4. read_file        — verify the edit landed
 *   5. glob             — list the .txt files (drives the bash script via
 *                          a fake exec that interprets a tiny subset)
 *   6. grep_files       — search for a token (grep fallback path)
 *   7. list_dir         — enumerate the FS root via sftpReaddir
 *
 * The point isn't to faithfully simulate SSH/SFTP — it's to confirm that
 * each tool produces the exact downstream-shape another tool would consume
 * without any glue code in between. Per-tool semantics (line numbering,
 * unique-match contract, etc.) are covered exhaustively in the per-tool
 * unit tests; this file validates registration + chained execution +
 * shape-compatibility.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';
import { buildEnv } from '../environments/_helpers';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/environments/loadAndResolveEnvironment')>(
    '../../src/lib/environments/loadAndResolveEnvironment',
  );
  return { ...actual, loadAndResolveEnvironment: vi.fn() };
});

import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run the .js paths don't exist
// next to the .ts modules, so we register the TS modules directly.
import readFileTool from '../../src/lib/tools/native/read-file';
import writeFileTool from '../../src/lib/tools/native/write-file';
import editFileTool from '../../src/lib/tools/native/edit-file';
import globTool from '../../src/lib/tools/native/glob';
import grepFilesTool from '../../src/lib/tools/native/grep-files';
import listDirTool from '../../src/lib/tools/native/list-dir';

// ---------------------------------------------------------------------------
// In-memory fake environment session
// ---------------------------------------------------------------------------

type EntryType = 'file' | 'dir' | 'link' | 'other';

interface FakeFile {
  content: Buffer;
  modifiedAt: Date;
}

class InMemoryFs {
  private readonly files = new Map<string, FakeFile>();
  private readonly dirs = new Set<string>(['/repo']);

  putFile(path: string, content: string): void {
    this.files.set(path, { content: Buffer.from(content, 'utf8'), modifiedAt: new Date() });
    // Auto-create parent dir for listing convenience
    const parent = path.substring(0, path.lastIndexOf('/')) || '/';
    this.dirs.add(parent);
  }

  hasFile(path: string): boolean {
    return this.files.has(path);
  }

  read(path: string): Buffer {
    const f = this.files.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.content;
  }

  write(path: string, content: Buffer | string): void {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    this.files.set(path, { content: buf, modifiedAt: new Date() });
  }

  rename(from: string, to: string): void {
    const f = this.files.get(from);
    if (!f) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, f);
    this.files.delete(from);
  }

  unlink(path: string): void {
    this.files.delete(path);
  }

  listDir(path: string): { name: string; type: EntryType; size: number; modifiedAt: Date }[] {
    if (!this.dirs.has(path) && !this.files.has(path)) {
      throw new Error(`ENOENT: ${path}`);
    }
    const prefix = path.endsWith('/') ? path : `${path}/`;
    const out: { name: string; type: EntryType; size: number; modifiedAt: Date }[] = [];
    const seen = new Set<string>();
    for (const [filePath, file] of this.files) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        // Direct file child
        if (seen.has(rest)) continue;
        seen.add(rest);
        out.push({ name: rest, type: 'file', size: file.content.length, modifiedAt: file.modifiedAt });
      } else {
        const dirName = rest.slice(0, slash);
        if (seen.has(dirName)) continue;
        seen.add(dirName);
        out.push({ name: dirName, type: 'dir', size: 0, modifiedAt: file.modifiedAt });
      }
    }
    return out;
  }

  /**
   * Tiny exec interpreter: handles the two shapes our fs tools emit:
   *  - bash glob script: `bash -c 'shopt ...; printf "%s\n" <pattern>'`
   *  - grep fallback:    `grep -r -n -H -E ... -e <pattern> <target>`
   *  - rg probe:          `command -v rg`
   */
  exec(command: string, opts: { cwd?: string }): { stdout: string; stderr: string; exitCode: number; durationMs: number; truncated: boolean } {
    const cwd = opts.cwd || '/repo';

    // rg probe: pretend rg isn't installed → forces grep fallback path
    if (command === 'command -v rg') {
      return { stdout: '', stderr: '', exitCode: 1, durationMs: 1, truncated: false };
    }

    // Glob: the shell-escape produces `'\''pattern'\''` for the pattern slot.
    // Strip those escape sequences and match anything-but-single-quote inside.
    const globMatch = /printf "%s\\n"\s+'\\''([^']+)'\\''/.exec(command);
    if (command.includes('shopt') && globMatch) {
      const pattern = globMatch[1];
      const matches: string[] = [];
      // Naive matching: `*.txt` → all .txt files in cwd; `**/*.txt` → recursive
      const isRecursive = pattern.includes('**');
      const ext = pattern.startsWith('*.') ? pattern.slice(1) : null;
      if (ext) {
        const cwdPrefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
        for (const filePath of this.files.keys()) {
          if (!filePath.endsWith(ext)) continue;
          if (isRecursive) {
            if (!filePath.startsWith(cwdPrefix)) continue;
            matches.push(filePath.slice(cwdPrefix.length));
          } else {
            const rest = filePath.slice(cwdPrefix.length);
            if (!rest.includes('/')) matches.push(rest);
          }
        }
      }
      matches.sort();
      return { stdout: matches.join('\n') + (matches.length ? '\n' : ''), stderr: '', exitCode: 0, durationMs: 1, truncated: false };
    }

    // grep fallback: extract pattern (single-quoted after `-e `) and target
    // (single-quoted at the end of the line).
    const grepMatch = /grep .* -e '([^']+)' '([^']+)'/.exec(command);
    if (command.startsWith('grep ') && grepMatch) {
      const pattern = grepMatch[1];
      const target = grepMatch[2];
      const cwdPrefix = target === '.' ? (cwd.endsWith('/') ? cwd : `${cwd}/`) : `${target}/`;
      const re = new RegExp(pattern);
      const out: string[] = [];
      for (const [filePath, file] of this.files) {
        const inScope = filePath.startsWith(cwdPrefix);
        if (!inScope) continue;
        const lines = file.content.toString('utf8').split('\n');
        const display = filePath; // grep -H shows full path
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) {
            out.push(`${display}:${i + 1}:${lines[i]}`);
          }
        }
      }
      return {
        stdout: out.join('\n') + (out.length ? '\n' : ''),
        stderr: '',
        exitCode: out.length > 0 ? 0 : 1,
        durationMs: 1,
        truncated: false,
      };
    }

    return { stdout: '', stderr: `unknown command: ${command}`, exitCode: 127, durationMs: 1, truncated: false };
  }
}

class FakeSession {
  constructor(private readonly fs: InMemoryFs) {}

  async sftpRead(path: string): Promise<Buffer> {
    return this.fs.read(path);
  }

  async sftpWrite(path: string, content: Buffer | string): Promise<void> {
    // The real session uses temp + rename internally — we just write directly
    // since the in-memory FS is atomic anyway.
    this.fs.write(path, content);
  }

  async sftpReaddir(path: string) {
    return this.fs.listDir(path);
  }

  async exec(command: string, opts: { cwd?: string }) {
    return this.fs.exec(command, opts);
  }
}

function makeContext(userId: string): NativeToolContext {
  return {
    publisher: null,
    state: { userId },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool',
    abortSignal: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fs pack — registration', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('read_file')) registry.register('read_file', readFileTool);
    if (!registry.has('write_file')) registry.register('write_file', writeFileTool);
    if (!registry.has('edit_file')) registry.register('edit_file', editFileTool);
    if (!registry.has('glob')) registry.register('glob', globTool);
    if (!registry.has('grep_files')) registry.register('grep_files', grepFilesTool);
    if (!registry.has('list_dir')) registry.register('list_dir', listDirTool);
  });

  test('all 6 fs-pack tools are registered with the singleton', () => {
    const registry = getNativeRegistry();
    for (const name of ['read_file', 'write_file', 'edit_file', 'glob', 'grep_files', 'list_dir']) {
      expect(registry.has(name)).toBe(true);
    }
  });

  test('all 6 tools share the "fs" server label', () => {
    for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, grepFilesTool, listDirTool]) {
      expect(tool.server).toBe('fs');
    }
  });

  test('all 6 tools require environmentId', () => {
    for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, grepFilesTool, listDirTool]) {
      expect(tool.inputSchema.required).toContain('environmentId');
    }
  });
});

describe('fs pack — chained execution against an in-memory fake environment', () => {
  let fs: InMemoryFs;
  let session: FakeSession;

  beforeEach(() => {
    environmentManager.__reset();
    fs = new InMemoryFs();
    session = new FakeSession(fs);
    vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
      env: buildEnv({ environmentId: 'env_int', userId: 'user_a', workingDir: '/repo' }),
      sshKey: 'k',
    });
    vi.spyOn(environmentManager, 'acquire').mockResolvedValue(session as unknown as Awaited<ReturnType<typeof environmentManager.acquire>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('full lifecycle: write → read → edit → read → glob → grep → list_dir', async () => {
    const ctx = makeContext('user_a');

    // 1. write three files
    const writeR1 = await writeFileTool.handler(
      { environmentId: 'env_int', path: '/repo/a.txt', content: 'hello world\nsecond line' },
      ctx,
    );
    expect(writeR1.isError).toBeUndefined();
    const writeBody1 = JSON.parse(writeR1.content[0].text);
    expect(writeBody1.ok).toBe(true);
    expect(writeBody1.bytes).toBeGreaterThan(0);
    expect(fs.hasFile('/repo/a.txt')).toBe(true);

    await writeFileTool.handler(
      { environmentId: 'env_int', path: '/repo/b.txt', content: 'TODO: implement' },
      ctx,
    );
    await writeFileTool.handler(
      { environmentId: 'env_int', path: '/repo/notes.md', content: '# Notes' },
      ctx,
    );

    // 2. read one back — confirm line-numbered output
    const readR1 = await readFileTool.handler(
      { environmentId: 'env_int', path: '/repo/a.txt' },
      ctx,
    );
    expect(readR1.isError).toBeUndefined();
    const readBody1 = JSON.parse(readR1.content[0].text);
    expect(readBody1.totalLines).toBe(2);
    expect(readBody1.lineCount).toBe(2);
    expect(readBody1.content).toBe('1\thello world\n2\tsecond line');

    // 3. edit (unique match) — replace "world" with "planet"
    const editR1 = await editFileTool.handler(
      { environmentId: 'env_int', path: '/repo/a.txt', oldString: 'hello world', newString: 'hello planet' },
      ctx,
    );
    expect(editR1.isError).toBeUndefined();
    const editBody1 = JSON.parse(editR1.content[0].text);
    expect(editBody1.ok).toBe(true);
    expect(editBody1.replacements).toBe(1);

    // 4. read again — confirm the edit landed
    const readR2 = await readFileTool.handler(
      { environmentId: 'env_int', path: '/repo/a.txt' },
      ctx,
    );
    const readBody2 = JSON.parse(readR2.content[0].text);
    expect(readBody2.content).toBe('1\thello planet\n2\tsecond line');

    // 5. glob — list .txt files
    const globR = await globTool.handler(
      { environmentId: 'env_int', pattern: '*.txt', basePath: '/repo' },
      ctx,
    );
    expect(globR.isError).toBeUndefined();
    const globBody = JSON.parse(globR.content[0].text);
    expect(globBody.paths.sort()).toEqual(['a.txt', 'b.txt']);
    expect(globBody.total).toBe(2);

    // 6. grep — search for "TODO"
    const grepR = await grepFilesTool.handler(
      { environmentId: 'env_int', pattern: 'TODO', path: '/repo' },
      ctx,
    );
    expect(grepR.isError).toBeUndefined();
    const grepBody = JSON.parse(grepR.content[0].text);
    expect(grepBody.engine).toBe('grep');
    expect(grepBody.matches.length).toBe(1);
    expect(grepBody.matches[0].file).toBe('/repo/b.txt');
    expect(grepBody.matches[0].content).toBe('TODO: implement');

    // 7. list_dir — enumerate /repo
    const listR = await listDirTool.handler(
      { environmentId: 'env_int', path: '/repo' },
      ctx,
    );
    expect(listR.isError).toBeUndefined();
    const listBody = JSON.parse(listR.content[0].text);
    const names = listBody.entries.map((e: { name: string }) => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'notes.md']);
  });

  test('edit_file ambiguous match leaves the file untouched (chain-friendly contract)', async () => {
    const ctx = makeContext('user_a');
    await writeFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt', content: 'foo\nfoo\nfoo' },
      ctx,
    );

    const editR = await editFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt', oldString: 'foo', newString: 'bar' },
      ctx,
    );
    expect(editR.isError).toBe(true);
    const editBody = JSON.parse(editR.content[0].text);
    expect(editBody.code).toBe('AMBIGUOUS_MATCH');

    // Subsequent read should show the file UNCHANGED.
    const readR = await readFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt' },
      ctx,
    );
    const readBody = JSON.parse(readR.content[0].text);
    expect(readBody.content).toBe('1\tfoo\n2\tfoo\n3\tfoo');
  });

  test('edit_file replaceAll handles multi-match cleanly', async () => {
    const ctx = makeContext('user_a');
    await writeFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt', content: 'foo and foo and foo' },
      ctx,
    );
    const editR = await editFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt', oldString: 'foo', newString: 'bar', replaceAll: true },
      ctx,
    );
    expect(editR.isError).toBeUndefined();
    expect(JSON.parse(editR.content[0].text).replacements).toBe(3);

    const readR = await readFileTool.handler(
      { environmentId: 'env_int', path: '/repo/dup.txt' },
      ctx,
    );
    const readBody = JSON.parse(readR.content[0].text);
    expect(readBody.content).toBe('1\tbar and bar and bar');
  });
});
