/**
 * Repository hygiene — what the engine repo is allowed to track.
 *
 * Two real incidents are pinned here:
 *
 *   1. Three Claude Code worktrees (`.claude/worktrees/agent-a97d3f52`,
 *      `agent-run-history`, `agent-stream-archival`) were swept into 7ba0e6c as
 *      gitlinks (mode 160000) with no `.gitmodules` entry. Every
 *      `actions/checkout` on the engine then logged
 *      `##[error]fatal: no submodule mapping found in .gitmodules for path
 *      '.claude/worktrees/…'` — non-fatal, but noise on every run, and fatal
 *      the moment a checkout asks for `submodules: true`.
 *
 *   2. `node_modules` was tracked as a symlink (mode 120000) pointing at a
 *      developer's home directory. `.gitignore` said `node_modules/`, and a
 *      pattern with a trailing slash only ever matches a *directory* — so the
 *      symlink was not ignored and a `git add -A` on any checkout silently
 *      committed a symlink change.
 *
 * The first two suites assert the index itself is clean. The third proves the
 * `.gitignore` rules (not luck) are what keeps it clean, by replaying both
 * mechanisms in a throwaway repo — once with this repo's `.gitignore`, once
 * without it as a control.
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Repo root, or null when the tests run outside a git work tree (packed tarball). */
function repoRoot(): string | null {
  try {
    return git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  } catch {
    return null;
  }
}

const ROOT = repoRoot();

interface IndexEntry {
  mode: string;
  objectPath: string;
}

function indexEntries(root: string): IndexEntry[] {
  // `-z` so paths with spaces/quoting never need unescaping.
  const raw = git(['ls-files', '-s', '-z'], root);
  return raw
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => {
      // "<mode> <object> <stage>\t<path>"
      const tab = line.indexOf('\t');
      const meta = line.slice(0, tab).split(' ');
      return { mode: meta[0], objectPath: line.slice(tab + 1) };
    });
}

const describeRepo = ROOT ? describe : describe.skip;

describeRepo('repo hygiene — the index', () => {
  it('tracks no gitlinks (mode 160000)', () => {
    const gitlinks = indexEntries(ROOT!).filter((e) => e.mode === '160000');
    expect(
      gitlinks.map((e) => e.objectPath),
      'gitlinks with no .gitmodules entry make every actions/checkout log ' +
        '"fatal: no submodule mapping found in .gitmodules"',
    ).toEqual([]);
  });

  it('has no .gitmodules — the engine has no submodules at all', () => {
    expect(fs.existsSync(path.join(ROOT!, '.gitmodules'))).toBe(false);
  });

  it('tracks nothing under .claude/ (Claude Code local state)', () => {
    const claudePaths = indexEntries(ROOT!)
      .map((e) => e.objectPath)
      .filter((p) => p === '.claude' || p.startsWith('.claude/'));
    expect(claudePaths).toEqual([]);
  });

  it('tracks nothing named node_modules, in any form', () => {
    const nodeModulePaths = indexEntries(ROOT!)
      .map((e) => e.objectPath)
      .filter((p) => p === 'node_modules' || p.split('/').includes('node_modules'));
    expect(nodeModulePaths).toEqual([]);
  });
});

describeRepo('repo hygiene — .gitignore rules', () => {
  const ignored = (relPath: string): boolean => {
    try {
      // --no-index: ask the rules, not the index, so the answer does not change
      // once a path has (wrongly) been added.
      git(['check-ignore', '--no-index', '-q', relPath], ROOT!);
      return true;
    } catch {
      return false;
    }
  };

  it('ignores .claude/ and everything under it', () => {
    expect(ignored('.claude/worktrees/agent-a97d3f52')).toBe(true);
    expect(ignored('.claude/settings.local.json')).toBe(true);
  });

  it('ignores node_modules with a bare pattern, not the directory form', () => {
    // Asserted on the rule text rather than via check-ignore: `node_modules/`
    // and `node_modules` answer identically for a path that exists as a real
    // directory (which it does after `npm ci`), and differ only for the symlink
    // case — which the scratch-repo suite below exercises for real.
    const rules = fs
      .readFileSync(path.join(ROOT!, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
    expect(rules).toContain('node_modules');
    expect(rules).not.toContain('node_modules/');
  });
});

describeRepo('repo hygiene — .gitignore actually stops `git add -A`', () => {
  let scratch: string;

  const ident = [
    '-c',
    'user.email=hygiene@test.invalid',
    '-c',
    'user.name=Repo Hygiene Test',
    '-c',
    'commit.gpgsign=false',
  ];

  /**
   * Builds a throwaway repo containing exactly the two hazards, runs
   * `git add -A`, and returns the resulting index entries.
   */
  function replayHazards(gitignoreContent: string | null): IndexEntry[] {
    const repo = fs.mkdtempSync(path.join(scratch, 'repo-'));
    git(['init', '-q'], repo);
    if (gitignoreContent !== null) {
      fs.writeFileSync(path.join(repo, '.gitignore'), gitignoreContent);
    }

    // Hazard 1: a Claude Code worktree — a nested git repo with a commit, which
    // is what `git add -A` turns into a gitlink.
    const worktree = path.join(repo, '.claude', 'worktrees', 'agent-a97d3f52');
    fs.mkdirSync(worktree, { recursive: true });
    git(['init', '-q'], worktree);
    fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'agent scratch\n');
    git([...ident, 'add', '-A'], worktree);
    git([...ident, 'commit', '-q', '-m', 'scratch'], worktree);

    // Hazard 2: node_modules as a symlink into someone's home directory.
    fs.symlinkSync('/home/alpha/code/redbtn/node_modules', path.join(repo, 'node_modules'));

    // Something legitimate, so an empty index can never be a false pass.
    fs.writeFileSync(path.join(repo, 'index.ts'), 'export const ok = true;\n');

    git([...ident, 'add', '-A'], repo);
    return indexEntries(repo);
  }

  beforeAll(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'redbtn-hygiene-'));
  });

  afterAll(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  });

  it('control: without the rules, `git add -A` commits a gitlink and the symlink', () => {
    const entries = replayHazards(null);
    const modes = new Map(entries.map((e) => [e.objectPath, e.mode]));
    expect(modes.get('.claude/worktrees/agent-a97d3f52')).toBe('160000');
    expect(modes.get('node_modules')).toBe('120000');
  });

  it("with this repo's .gitignore, neither hazard reaches the index", () => {
    const entries = replayHazards(fs.readFileSync(path.join(ROOT!, '.gitignore'), 'utf8'));
    const paths = entries.map((e) => e.objectPath);
    expect(paths).toContain('index.ts');
    expect(paths.filter((p) => p.startsWith('.claude'))).toEqual([]);
    expect(paths.filter((p) => p.startsWith('node_modules'))).toEqual([]);
    expect(entries.filter((e) => e.mode === '160000' || e.mode === '120000')).toEqual([]);
  });
});
