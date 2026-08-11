/**
 * ssh_shell — remote process-group kill semantics (live sshd).
 *
 * Regression tests for the 2026-08-10 Become Agent incident: an interrupted
 * run's remote `claude` process survived because
 *   1. RunControlRegistry.cancel() aborted the controller BEFORE firing the
 *      tool cancel callbacks — the tool's abortSignal listener settled
 *      (conn.end()) synchronously and the kill callback's settled-guard
 *      skipped the remote kill entirely; and
 *   2. even when the kill side-channel was dispatched, settle() tore the
 *      connection down 50ms later, before the remote kill executed; and
 *   3. the timeout path never attempted a kill at all.
 *
 * These tests drive the REAL tool handler against a REAL sshd and assert the
 * remote process group actually dies. They probe sshd availability first and
 * skip when unreachable (same pattern as native-tools.test.ts, which needs
 * live services too). Port defaults to 22 (CI runners); override with
 * SSH_TEST_PORT (e.g. 2222 on alphaSystem/WSL).
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';

import sshShellTool from '../../src/lib/tools/native/ssh-shell';
import { runControlRegistry } from '../../src/lib/run/RunControlRegistry';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const SSH_HOST = process.env.SSH_TEST_HOST || 'localhost';
const SSH_PORT = Number(process.env.SSH_TEST_PORT || 22);
const SSH_USER = process.env.SSH_TEST_USER || 'alpha';
const SSH_KEY_PATH = process.env.SSH_TEST_KEY || '/home/alpha/s';

let sshAvailable = false;

/**
 * The victim command embeds a unique marker so we can watch the remote
 * process group from the outside via pgrep. The pgrep pattern uses a
 * character class (`SSHKILL[_]...`) so the pgrep/sh command lines never
 * match themselves.
 */
function marker(tag: string): { cmdMarker: string; pgrepPattern: string } {
  const m = `SSHKILL_${tag}_${process.pid}`;
  return { cmdMarker: m, pgrepPattern: m.replace('SSHKILL_', 'SSHKILL[_]') };
}

function remoteAlive(pgrepPattern: string): boolean {
  try {
    const out = execSync(
      `ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${SSH_USER}@${SSH_HOST} 'pgrep -f "${pgrepPattern}" | wc -l'`,
      { timeout: 15000 },
    ).toString().trim();
    return parseInt(out, 10) > 0;
  } catch {
    return false;
  }
}

function cleanupRemote(pgrepPattern: string): void {
  try {
    execSync(
      `ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} -o StrictHostKeyChecking=no ${SSH_USER}@${SSH_HOST} 'pkill -f "${pgrepPattern}" || true'`,
      { timeout: 15000 },
    );
  } catch { /* best-effort */ }
}

async function waitFor(cond: () => boolean, timeoutMs: number, intervalMs = 250): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return cond();
}

function makeCtx(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: null,
    nodeId: 'kill-test-node',
    toolId: 'kill-test-tool',
    abortSignal: null,
    ...overrides,
  } as NativeToolContext;
}

beforeAll(() => {
  try {
    if (!fs.existsSync(SSH_KEY_PATH)) {
      console.log(`[probe] sshd: skipped — no key at ${SSH_KEY_PATH}`);
      return;
    }
    execSync(
      `ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${SSH_USER}@${SSH_HOST} 'echo ok'`,
      { timeout: 15000 },
    );
    sshAvailable = true;
    console.log(`[probe] sshd ${SSH_USER}@${SSH_HOST}:${SSH_PORT}: available`);
  } catch (err: unknown) {
    console.log(`[probe] sshd: unavailable — ${err instanceof Error ? err.message : err}`);
  }
});

describe('ssh_shell — remote kill on interrupt/timeout', () => {
  afterAll(() => {
    cleanupRemote('SSHKILL[_]');
  });

  test('run interrupt kills the remote process group (full toolExecutor-style wiring)', async (t) => {
    if (!sshAvailable) return t.skip();

    const { cmdMarker, pgrepPattern } = marker('interrupt');
    const runId = `kill-test-run-${Date.now()}`;

    // Mirror toolExecutor's wiring: the tool receives a LOCAL controller's
    // signal, chained off the run controller — the exact setup under which
    // the old code settled before killing.
    const runCtx = runControlRegistry.register(runId, 'kill-test-worker');
    const local = new AbortController();
    runCtx.controller.signal.addEventListener('abort', () => local.abort(), { once: true });

    const resultPromise = sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `sleep 300 && echo ${cmdMarker}`,
      },
      makeCtx({ runId, abortSignal: local.signal }),
    );

    try {
      // Wait until the remote process group is confirmed running.
      expect(await waitFor(() => remoteAlive(pgrepPattern), 15000)).toBe(true);

      // Fire the interrupt the way the run pipeline does.
      const ack = runControlRegistry.cancel(runId, 'kill-test');
      expect(ack.ack).toBe(true);

      // The tool must settle as an error mentioning the interrupt…
      const result = await resultPromise;
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(String(body.error)).toContain('cancelled by run interrupt');

      // …and the REMOTE process group must actually be dead.
      expect(await waitFor(() => !remoteAlive(pgrepPattern), 8000)).toBe(true);
    } finally {
      runControlRegistry.unregister(runId);
      cleanupRemote(pgrepPattern);
    }
  }, 60000);

  test('timeout kills the remote process group', async (t) => {
    if (!sshAvailable) return t.skip();

    const { cmdMarker, pgrepPattern } = marker('timeout');

    const resultPromise = sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `sleep 300 && echo ${cmdMarker}`,
        timeout: 4000,
      },
      makeCtx(),
    );

    try {
      expect(await waitFor(() => remoteAlive(pgrepPattern), 15000)).toBe(true);

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(String(body.error)).toContain('timed out');

      expect(await waitFor(() => !remoteAlive(pgrepPattern), 8000)).toBe(true);
    } finally {
      cleanupRemote(pgrepPattern);
    }
  }, 60000);

  test('abort without a registered run still kills the remote process group', async (t) => {
    if (!sshAvailable) return t.skip();

    const { cmdMarker, pgrepPattern } = marker('abort');
    const controller = new AbortController();

    const resultPromise = sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `sleep 300 && echo ${cmdMarker}`,
      },
      makeCtx({ abortSignal: controller.signal }),
    );

    try {
      expect(await waitFor(() => remoteAlive(pgrepPattern), 15000)).toBe(true);

      controller.abort();

      const result = await resultPromise;
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(String(body.error)).toContain('aborted by caller');

      expect(await waitFor(() => !remoteAlive(pgrepPattern), 8000)).toBe(true);
    } finally {
      cleanupRemote(pgrepPattern);
    }
  }, 60000);
});
