/**
 * ssh_shell — long-command stdin transport (live sshd).
 *
 * Regression tests for the 2026-08-24 Become Agent incident: SSH exec
 * command strings traverse the remote host's process-spawn machinery, which
 * on Windows OpenSSH (cmd/Git-Bash marshalling) silently truncates around
 * 8191 chars — chopping the closing quote off the `exec bash -c '…'` wrapper
 * and failing the run with "unexpected EOF while looking for matching `'`".
 * A long Discord message + attachment URLs pushed the cli-agent graph's
 * PowerShell -EncodedCommand blob to ~12KB and every delivery failed.
 *
 * Fix: above STDIN_EXEC_THRESHOLD the tool sends a fixed-size
 * `exec bash -s` and streams the script over the channel's stdin, which has
 * no length cliff (verified 40KB+ through the affected Windows sshd).
 *
 * These tests drive the REAL tool handler against a REAL sshd (probe-and-skip
 * pattern shared with ssh-shell-kill.test.ts). A Linux sshd never truncated
 * in the first place, so what they lock in is that the stdin path executes
 * correctly end-to-end: full script runs, stdout intact, exit code captured,
 * and special characters survive un-mangled.
 */

import { describe, test, expect, beforeAll } from 'vitest';
import { execSync } from 'child_process';
import * as fs from 'fs';

import sshShellTool from '../../src/lib/tools/native/ssh-shell';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const SSH_HOST = process.env.SSH_TEST_HOST || 'localhost';
const SSH_PORT = Number(process.env.SSH_TEST_PORT || 22);
const SSH_USER = process.env.SSH_TEST_USER || 'alpha';
const SSH_KEY_PATH = process.env.SSH_TEST_KEY || '/home/alpha/s';

let sshAvailable = false;

function makeCtx(): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: null,
    nodeId: 'long-cmd-test-node',
    toolId: 'long-cmd-test-tool',
    abortSignal: null,
  } as NativeToolContext;
}

beforeAll(() => {
  try {
    execSync(
      `ssh -i ${SSH_KEY_PATH} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o ConnectTimeout=5 ${SSH_USER}@${SSH_HOST} 'echo ok'`,
      { timeout: 15000 },
    );
    sshAvailable = true;
  } catch {
    sshAvailable = false;
    console.warn('[ssh-shell-long-command.test] sshd unreachable — skipping live tests');
  }
});

describe('ssh_shell — long commands go via stdin (bash -s)', () => {
  test('a >6000-char command executes fully and returns intact output', async (t) => {
    if (!sshAvailable) return t.skip();

    // Mimic the failing shape: one long single-command line whose tail
    // matters. If any layer truncated it, the end marker would be lost or
    // bash would die parsing.
    const filler = 'A'.repeat(9000);
    const result = await sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `PAYLOAD='${filler}'; echo "LEN=\${#PAYLOAD}"; echo LONG_CMD_END_MARKER`,
        timeout: 20000,
      },
      makeCtx(),
    );

    expect(result.isError ?? false).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('LEN=9000');
    expect(body.stdout).toContain('LONG_CMD_END_MARKER');
    // And no bash parse error — the exact incident signature.
    expect(String(body.stderr || '')).not.toMatch(/unexpected EOF/i);
  });

  test('special characters survive the stdin path un-mangled', async (t) => {
    if (!sshAvailable) return t.skip();

    // Backticks, $, quotes — everything shQuote used to protect must remain
    // literal on the stdin path too (bash -s executes the raw script, so the
    // script itself is what the graph built; here the graph-built command
    // quotes its own payload, exactly like printf %s '<prompt>' | cli -).
    const pad = 'B'.repeat(7000);
    const result = await sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `IGNORE='${pad}'; printf %s 'tick \`date\` dollar $HOME quote "x" done' ; echo; echo SPECIALS_OK`,
        timeout: 20000,
      },
      makeCtx(),
    );

    expect(result.isError ?? false).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('tick `date` dollar $HOME quote "x" done');
    expect(body.stdout).toContain('SPECIALS_OK');
  });

  test('short commands keep the classic exec path (control)', async (t) => {
    if (!sshAvailable) return t.skip();

    const result = await sshShellTool.handler(
      {
        host: SSH_HOST,
        port: SSH_PORT,
        user: SSH_USER,
        sshKey: fs.readFileSync(SSH_KEY_PATH, 'utf8'),
        command: `echo SHORT_PATH_OK`,
        timeout: 15000,
      },
      makeCtx(),
    );

    expect(result.isError ?? false).toBe(false);
    const body = JSON.parse(result.content[0].text);
    expect(body.exitCode).toBe(0);
    expect(body.stdout).toContain('SHORT_PATH_OK');
  });
});
