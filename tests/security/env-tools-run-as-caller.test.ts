/**
 * Run-as-caller delegation for the environment FILE and EXEC tools.
 *
 * # What is under test
 *
 * docs/RUN-AS-CALLER-DELEGATION-SPEC.md puts ENVIRONMENTS on the caller's side
 * of the line: an automation declared `executionIdentity:'caller'` +
 * `callerInvokable` is triggered by somebody who is not its owner, the hub puts
 * that VERIFIED caller on the run, and `buildInitialState` mirrors it onto
 * state as `callerUserId` (top level and `data.callerUserId`). LLM access, tier
 * gating and metering stay on the OWNER; anything the run reaches for on the
 * caller's behalf resolves as the CALLER.
 *
 * The ssh family already did that. Every other tool that touches an environment
 * did not, and production proved the split on 2026-09-16 in run
 * `run_1789534315735_ixbvhn`: a board owned by a second tenant dispatched a card
 * through an automation owned by George, `workspace_for_repo` correctly created
 * the workspace under the CALLER, and the runner environment `env_mdFnVzNuxppa`
 * belonged to the CALLER — so `ssh_run_async`, `ssh_tail` and `ssh_jobs` worked
 * while `run_command`, `read_file`, `write_file`, `edit_file`, `list_dir`,
 * `glob`, `grep_files` and `ssh_copy` each came back
 * `ENV_ACCESS_DENIED: User <owner> does not have access to environment
 * env_mdFnVzNuxppa`. One unlocked door, nine locked ones, on the same machine.
 *
 * So, for every one of those tools plus the desktop pair, this asserts the same
 * three things:
 *
 *   1. with `state.callerUserId` set, the environment is resolved as the CALLER;
 *   2. with only the `state.data.callerUserId` mirror set, likewise;
 *   3. with neither (an ordinary run), as the OWNER — the regression that
 *      matters most, because delegation must be invisible to normal runs.
 *
 * # How
 *
 * `loadAndResolveEnvironment` is the single chokepoint every one of these tools
 * goes through for the document lookup, the owner-or-public access check and
 * the `secretRef` resolution, so mocking it (the same way
 * `tests/tools/ssh-tail.test.ts` and `tests/tools/list-dir.test.ts` do) and
 * reading back its second argument IS reading the identity the tool acted as.
 * `environmentManager.acquire` is stubbed to reject, which both keeps the test
 * off the network and lets the fs tools' pool key be asserted too: a session
 * pooled under the wrong id would hand a later tool call the wrong connection.
 *
 * Hermetic: no Mongo, no Redis, no network, no ssh.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import { buildEnv } from '../environments/_helpers';

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/lib/environments/loadAndResolveEnvironment')
  >('../../src/lib/environments/loadAndResolveEnvironment');
  return { ...actual, loadAndResolveEnvironment: vi.fn() };
});

import { loadAndResolveEnvironment } from '../../src/lib/environments/loadAndResolveEnvironment';
import { environmentManager } from '../../src/lib/environments/EnvironmentManager';

import runCommandTool from '../../src/lib/tools/native/run-command';
import listDirTool from '../../src/lib/tools/native/list-dir';
import globTool from '../../src/lib/tools/native/glob';
import readFileTool from '../../src/lib/tools/native/read-file';
import writeFileTool from '../../src/lib/tools/native/write-file';
import editFileTool from '../../src/lib/tools/native/edit-file';
import grepFilesTool from '../../src/lib/tools/native/grep-files';
import sshCopyTool from '../../src/lib/tools/native/ssh-copy';
import alertDesktopTool from '../../src/lib/tools/native/alert-desktop';
import { desktopExec } from '../../src/lib/tools/native/desktop-computer';
import {
  resolveRunUserId,
  resolveRunOwnerUserId,
  resolveRunUserIdOrEmpty,
} from '../../src/lib/tools/native/_run-identity';

const OWNER = '69a0b790a0ae8660290a78da';
const CALLER = 'caller-tenant-user';
const ENV = 'env_mdFnVzNuxppa';

/** A run the hub delegated: owner on `userId`, verified caller on `callerUserId`. */
const delegated = () => ({
  userId: OWNER,
  callerUserId: CALLER,
  data: { userId: OWNER, callerUserId: CALLER, environmentId: ENV },
});

/** The same delegation seen only through the `state.data` mirror. */
const mirrored = () => ({
  userId: OWNER,
  data: { userId: OWNER, callerUserId: CALLER, environmentId: ENV },
});

/** An ordinary, undelegated run — only the owner is on it. */
const plain = () => ({ userId: OWNER, data: { userId: OWNER, environmentId: ENV } });

const ctx = (state: Record<string, unknown>): NativeToolContext =>
  ({
    publisher: null,
    state,
    runId: 'run_1789534315735_ixbvhn',
    nodeId: 'n',
    toolId: 't',
    abortSignal: null,
  }) as NativeToolContext;

/**
 * Every tool that reaches an environment for something other than an ssh
 * session, with the smallest argument set that gets it past validation and to
 * the `loadAndResolveEnvironment` call.
 */
const TOOLS: Array<{ name: string; call: (c: NativeToolContext) => Promise<unknown> }> = [
  { name: 'run_command', call: (c) => runCommandTool.handler({ environmentId: ENV, command: 'echo hi' }, c) },
  { name: 'list_dir', call: (c) => listDirTool.handler({ environmentId: ENV, path: '/srv/app' }, c) },
  { name: 'glob', call: (c) => globTool.handler({ environmentId: ENV, pattern: '**/*.ts' }, c) },
  { name: 'read_file', call: (c) => readFileTool.handler({ environmentId: ENV, path: '/srv/app/a.ts' }, c) },
  { name: 'write_file', call: (c) => writeFileTool.handler({ environmentId: ENV, path: '/srv/app/a.ts', content: 'x' }, c) },
  {
    name: 'edit_file',
    call: (c) => editFileTool.handler({ environmentId: ENV, path: '/srv/app/a.ts', oldString: 'a', newString: 'b' }, c),
  },
  { name: 'grep_files', call: (c) => grepFilesTool.handler({ environmentId: ENV, pattern: 'needle' }, c) },
  { name: 'ssh_copy', call: (c) => sshCopyTool.handler({ environmentId: ENV, remotePath: '/tmp/a.txt', content: 'x' }, c) },
  { name: 'alert_desktop', call: (c) => alertDesktopTool.handler({ environmentId: ENV, title: 't', body: 'b' }, c) },
  { name: 'desktop_exec', call: (c) => desktopExec.handler({ environmentId: ENV, command: 'whoami' }, c) },
];

/** The fs/exec tools that also pool a session; the desktop pair does not. */
const POOLING = new Set(['run_command', 'list_dir', 'glob', 'read_file', 'write_file', 'edit_file', 'grep_files']);

let acquireSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(loadAndResolveEnvironment).mockReset();
  vi.mocked(loadAndResolveEnvironment).mockResolvedValue({
    env: buildEnv({ environmentId: ENV, userId: CALLER }),
    sshKey: 'k',
  });
  // Stop each tool right after it has declared its identity: nothing here may
  // open a socket. ENV_ACQUIRE_FAILED is a fine place to end.
  acquireSpy = vi
    .spyOn(environmentManager, 'acquire')
    .mockRejectedValue(new Error('acquire stubbed in test')) as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The identity a tool passed to `loadAndResolveEnvironment`. */
function resolvedAs(): string | undefined {
  const calls = vi.mocked(loadAndResolveEnvironment).mock.calls;
  expect(calls.length, 'the tool never reached loadAndResolveEnvironment').toBeGreaterThan(0);
  return calls[calls.length - 1][1] as string | undefined;
}

/** The identity a tool pooled its session under. */
function acquiredAs(): string | undefined {
  expect(acquireSpy).toHaveBeenCalled();
  const calls = acquireSpy.mock.calls;
  return calls[calls.length - 1][2] as string | undefined;
}

describe('environment file/exec tools — the identity they act as', () => {
  test.each(TOOLS)('$name resolves the environment as the delegated CALLER', async ({ name, call }) => {
    await call(ctx(delegated()));
    expect(resolvedAs()).toBe(CALLER);
    if (POOLING.has(name)) expect(acquiredAs()).toBe(CALLER);
  });

  test.each(TOOLS)('$name accepts the state.data.callerUserId mirror alone', async ({ name, call }) => {
    await call(ctx(mirrored()));
    expect(resolvedAs()).toBe(CALLER);
    if (POOLING.has(name)) expect(acquiredAs()).toBe(CALLER);
  });

  test.each(TOOLS)('$name still resolves as the OWNER on an undelegated run', async ({ name, call }) => {
    await call(ctx(plain()));
    expect(resolvedAs()).toBe(OWNER);
    if (POOLING.has(name)) expect(acquiredAs()).toBe(OWNER);
  });

  test.each(TOOLS)('$name falls back to the nested state.data.userId owner', async ({ call }) => {
    await call(ctx({ data: { userId: OWNER, environmentId: ENV } }));
    expect(resolvedAs()).toBe(OWNER);
  });
});

describe('ssh_copy — the Knowledge Library read is access-checked as the caller', () => {
  /**
   * The other half of `ssh_copy`. With an owner-resolved library header and a
   * caller-resolved environment, a delegated run would read the OWNER's private
   * documents and write them onto the CALLER's own host. Both ends move
   * together or the tool becomes an exfiltration path.
   */
  const seen: Array<Record<string, string>> = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    seen.length = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { headers?: Record<string, string> }) => {
      seen.push({ ...(init?.headers ?? {}) });
      // Non-ok ends the tool before GridFS — the identity is already recorded.
      return { ok: false, status: 403, statusText: 'Forbidden', text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('sends the CALLER as X-User-Id on a delegated run', async () => {
    await sshCopyTool.handler({ environmentId: ENV, remotePath: '/tmp/out/', libraryId: 'lib_1' }, ctx(delegated()));
    expect(seen.at(-1)?.['X-User-Id']).toBe(CALLER);
  });

  test('sends the OWNER as X-User-Id on an undelegated run', async () => {
    await sshCopyTool.handler({ environmentId: ENV, remotePath: '/tmp/out/', libraryId: 'lib_1' }, ctx(plain()));
    expect(seen.at(-1)?.['X-User-Id']).toBe(OWNER);
  });
});

describe('a missing identity still fails the way each tool already failed', () => {
  test('run_command returns NO_USER rather than acting as nobody', async () => {
    const r = await runCommandTool.handler({ environmentId: ENV, command: 'echo hi' }, ctx({ data: {} }));
    const body = JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
    expect(body.code).toBe('NO_USER');
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });

  test('read_file returns NO_USER rather than acting as nobody', async () => {
    const r = await readFileTool.handler({ environmentId: ENV, path: '/a' }, ctx({ data: {} }));
    const body = JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
    expect(body.code).toBe('NO_USER');
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });

  test('alert_desktop keeps its fail-safe delivered:0 note', async () => {
    const r = await alertDesktopTool.handler({ environmentId: ENV, title: 't', body: 'b' }, ctx({ data: {} }));
    const body = JSON.parse((r as { content: Array<{ text: string }> }).content[0].text);
    expect(body.delivered).toBe(0);
    expect(body.note).toMatch(/No userId available/);
    expect(loadAndResolveEnvironment).not.toHaveBeenCalled();
  });
});

describe('_run-identity — the one definition of the precedence', () => {
  test('prefers a top-level callerUserId over the owner', () => {
    expect(resolveRunUserId(ctx(delegated()))).toBe(CALLER);
  });

  test('prefers the data.callerUserId mirror when only it is set', () => {
    expect(resolveRunUserId(ctx(mirrored()))).toBe(CALLER);
  });

  test('falls back to the owner chain on an undelegated run', () => {
    expect(resolveRunUserId(ctx(plain()))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ data: { options: { userId: OWNER } } }))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ data: {} }))).toBeNull();
  });

  test('ignores an empty or non-string caller rather than acting as nobody', () => {
    expect(resolveRunUserId(ctx({ userId: OWNER, callerUserId: '' }))).toBe(OWNER);
    expect(resolveRunUserId(ctx({ userId: OWNER, callerUserId: { id: CALLER } }))).toBe(OWNER);
  });

  test('resolveRunOwnerUserId stays owner-only — billing must not follow the caller', () => {
    expect(resolveRunOwnerUserId(ctx(delegated()))).toBe(OWNER);
    expect(resolveRunOwnerUserId(ctx({ callerUserId: CALLER, data: {} }))).toBeNull();
  });

  test('resolveRunUserIdOrEmpty is the same rule with a string floor', () => {
    expect(resolveRunUserIdOrEmpty(ctx(delegated()))).toBe(CALLER);
    expect(resolveRunUserIdOrEmpty(ctx({ data: {} }))).toBe('');
  });

  test('workspace-common re-exports the same rule, not a copy of it', async () => {
    const wc = await import('../../src/lib/tools/native/workspace-common');
    expect(wc.resolveRunUserId(ctx(delegated()))).toBe(CALLER);
    expect(wc.resolveRunUserId(ctx(plain()))).toBe(OWNER);
    expect(wc.resolveRunOwnerUserId(ctx(delegated()))).toBe(OWNER);
  });
});
