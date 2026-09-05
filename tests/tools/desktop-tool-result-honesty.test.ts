/**
 * desktop tools — a result must never claim an action that did not happen.
 *
 * The incident these tests exist for: a voice agent ran
 * screenshot → exec google-chrome → click → ctrl+A → type "funny cats" → Enter,
 * narrated a working YouTube session, and NOTHING had happened. Three separate
 * lies made that possible, and two of them were in this file's subject:
 *
 *   - `desktop_exec` set `isError` from `reply.ok` alone, so a command that ran
 *     and exited non-zero (`failed: true`) reached the model as a success.
 *   - `desktop_type` / `desktop_key` / `desktop_scroll` rebuilt the reply as
 *     `{ok, error?}`, discarding the connector's evidence — so a DRY RUN that
 *     synthesized no keystroke at all was byte-identical to a real one.
 *
 * Every test below is written against the payload the MODEL sees.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

const requestDesktopMock = vi.hoisted(() => vi.fn());
const requestDesktopRawMock = vi.hoisted(() => vi.fn());
const loadAndResolveEnvironmentMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/tools/native/desktop-request', () => ({
  requestDesktop: requestDesktopMock,
  requestDesktopRaw: requestDesktopRawMock,
}));

vi.mock('../../src/lib/environments/loadAndResolveEnvironment', () => ({
  loadAndResolveEnvironment: loadAndResolveEnvironmentMock,
}));

import {
  desktopScreenshot,
  desktopClick,
  desktopType,
  desktopKey,
  desktopScroll,
  desktopScreenInfo,
  desktopExec,
  desktopSettings,
} from '../../src/lib/tools/native/desktop-computer';

type McpResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

function makeContext(userId = 'user_a'): NativeToolContext {
  return {
    publisher: { emit: vi.fn() },
    state: { userId },
    runId: 'run_1',
    nodeId: 'node_1',
    toolId: 'tool_1',
    abortSignal: null,
  };
}

function body(result: McpResult): Record<string, unknown> {
  const block = result.content.find((item) => item.type === 'text');
  if (!block?.text) throw new Error('missing text block');
  return JSON.parse(block.text);
}

const TARGET = { environmentId: 'env_desktop' };

beforeEach(() => {
  requestDesktopMock.mockReset();
  requestDesktopRawMock.mockReset();
  loadAndResolveEnvironmentMock.mockReset();
  loadAndResolveEnvironmentMock.mockResolvedValue({
    env: {
      environmentId: 'env_desktop',
      userId: 'user_a',
      kind: 'desktop-agent',
      installId: 'install_123',
    },
    sshKey: '',
  });
});

// ─── desktop_exec: ok:true is not the same as "it worked" ────────────────────

describe('desktop_exec — a command that RAN and FAILED is an error', () => {
  test('exit 127 with failed:true reaches the model as an error, evidence intact', async () => {
    // What redbtn-desktop's executor resolves for `google-chrome` on a box that
    // has no chrome: an exit status came back (ok), and it means failure.
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: true,
      result: {
        stdout: '',
        stderr: 'sh: 1: google-chrome: not found',
        exitCode: 127,
        durationMs: 8,
        truncated: false,
        failed: true,
      },
    });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'google-chrome' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    const payload = body(result);
    expect(payload.error).toMatchObject({ code: 'exec_nonzero_exit' });
    expect(String((payload.error as Record<string, unknown>).message)).toContain('exit 127');
    expect(String((payload.error as Record<string, unknown>).message)).toContain('google-chrome: not found');
    // The connector's own reply is passed through, not replaced by the error.
    expect(payload.result).toMatchObject({ exitCode: 127, failed: true });
  });

  test('a connector build with no `failed` field is still caught by exitCode', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: true,
      result: { stdout: '', stderr: 'not found', exitCode: 127, durationMs: 5, truncated: false },
    });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'notacommand' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    expect((body(result).error as Record<string, unknown>).code).toBe('exec_nonzero_exit');
  });

  test('failed:false wins over a non-zero exitCode (the connector is the authority)', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: true,
      result: { stdout: '', stderr: '', exitCode: 1, durationMs: 5, truncated: false, failed: false },
    });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'grep', args: ['x', 'f'] },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result).error).toBeUndefined();
  });

  test('exit 0 stays a success and is not decorated with an error', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: true,
      result: { stdout: 'hello\n', stderr: '', exitCode: 0, durationMs: 4, truncated: false, failed: false },
    });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'echo', args: ['hello'] },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ ok: true, result: { stdout: 'hello\n', exitCode: 0 } });
    expect(body(result).error).toBeUndefined();
  });

  test('a timeout is an error and keeps both the reason and the partial stdout', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: false,
      result: { stdout: 'partial', stderr: '', exitCode: null, durationMs: 5000, truncated: false, failed: true },
      error: { code: 'exec_timeout', message: 'killed after 5000ms (SIGKILL) — the command did NOT run to completion' },
    });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'sleep', args: ['99'] },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    const payload = body(result);
    // The connector already named the reason; we do NOT overwrite it.
    expect(payload.error).toMatchObject({ code: 'exec_timeout' });
    expect(payload.result).toMatchObject({ stdout: 'partial' });
  });

  test('a refusal with no error detail still becomes a named error', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({ ok: false });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'whoami' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    expect((body(result).error as Record<string, unknown>).code).toBe('desktop_failed');
  });
});

// ─── input tools: a dry run is not a keystroke ───────────────────────────────

describe('desktop input tools — a DRY RUN is an error, not a success', () => {
  const dryRunReplies: Array<[string, () => Promise<unknown>, Record<string, unknown>]> = [
    [
      'desktop_type',
      () => desktopType.handler({ ...TARGET, text: 'funny cats' }, makeContext()),
      { dryRun: true, op: 'type', typed: 10, text: 'funny cats', keys: [] },
    ],
    [
      'desktop_key',
      () => desktopKey.handler({ ...TARGET, keys: ['enter'] }, makeContext()),
      { dryRun: true, op: 'tap', typed: 0, keys: ['Enter'] },
    ],
    [
      'desktop_click',
      () => desktopClick.handler({ ...TARGET, x: 10, y: 20 }, makeContext()),
      { dryRun: true, op: 'click' },
    ],
    [
      'desktop_scroll',
      () => desktopScroll.handler({ ...TARGET, dy: 3 }, makeContext()),
      { dryRun: true, op: 'scroll' },
    ],
  ];

  for (const [name, invoke, evidence] of dryRunReplies) {
    test(`${name} reports a dry run as a failure and keeps the evidence`, async () => {
      requestDesktopMock.mockResolvedValueOnce({
        kind: 'computer_result',
        id: 'req_1',
        ok: true, // the connector's own claim — it acknowledged the request
        result: evidence,
      });

      const result = (await invoke()) as McpResult;

      expect(result.isError).toBe(true);
      const payload = body(result);
      expect(payload.ok).toBe(false);
      expect((payload.error as Record<string, unknown>).code).toBe('capability_disabled');
      expect(String((payload.error as Record<string, unknown>).message)).toContain('NOTHING HAPPENED');
      // The connector's claim is forwarded, never hidden behind our verdict.
      expect(payload.result).toMatchObject(evidence);
    });
  }
});

describe('desktop input tools — real input carries the evidence to the model', () => {
  test('desktop_type forwards typed / text / foregroundWindow', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: true,
      result: {
        dryRun: false,
        op: 'type',
        typed: 10,
        text: 'funny cats',
        keys: [],
        foregroundWindow: 'YouTube - Google Chrome',
      },
    });

    const result = (await desktopType.handler(
      { ...TARGET, text: 'funny cats' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({
      ok: true,
      result: {
        dryRun: false,
        op: 'type',
        typed: 10,
        text: 'funny cats',
        keys: [],
        foregroundWindow: 'YouTube - Google Chrome',
      },
    });
  });

  test('desktop_key forwards unknownKeys — a partial chord is visible', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: true,
      result: { dryRun: false, op: 'tap', typed: 0, keys: ['LeftControl'], unknownKeys: ['F13'] },
    });

    const result = (await desktopKey.handler(
      { ...TARGET, keys: ['ctrl', 'f13'] },
      makeContext(),
    )) as McpResult;

    expect(body(result).result).toMatchObject({ keys: ['LeftControl'], unknownKeys: ['F13'] });
  });

  test('an older connector that sends no evidence still returns a plain ok', async () => {
    requestDesktopMock.mockResolvedValueOnce({ kind: 'computer_result', id: 'req_1', ok: true });

    const result = (await desktopType.handler(
      { ...TARGET, text: 'hi' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({ ok: true });
  });

  test('a refused keystroke is an error envelope, not a plain result', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: false,
      error: { code: 'consent_denied', message: 'user denied the request' },
    });

    const result = (await desktopKey.handler(
      { ...TARGET, keys: ['enter'] },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    expect(body(result)).toEqual({
      ok: false,
      error: { code: 'consent_denied', message: 'user denied the request' },
    });
  });
});

// ─── read-only tools ─────────────────────────────────────────────────────────

describe('desktop read tools — a failed read is an error envelope', () => {
  test('a screenshot that returned no image is an error, not ok-shaped JSON', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: false,
      error: { code: 'computer_failed', message: 'No desktop responded within 12000ms' },
    });

    const result = (await desktopScreenshot.handler(TARGET, makeContext())) as McpResult;

    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ ok: false, error: { code: 'computer_failed' } });
  });

  test('desktop_screen_info marks a failed enumeration as an error', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: false,
      error: { code: 'computer_failed', message: 'no desktop' },
    });

    const result = (await desktopScreenInfo.handler(TARGET, makeContext())) as McpResult;

    expect(result.isError).toBe(true);
  });

  test('a successful screen_info is still a plain result', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: true,
      screen: { displays: [{ id: 1, width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, primary: true }] },
    });

    const result = (await desktopScreenInfo.handler(TARGET, makeContext())) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result)).toMatchObject({ ok: true });
  });
});

// ─── the connector stays the authority on its own wording ────────────────────

describe('desktop tools — a connector error is never overwritten', () => {
  test('a string error survives instead of being replaced by a generic line', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({ ok: false, error: 'exec is disabled on this machine' });

    const result = (await desktopExec.handler(
      { ...TARGET, command: 'ls' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    expect(body(result).error).toBe('exec is disabled on this machine');
  });

  test('desktop_settings surfaces a refusal as an error envelope', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: false,
      error: { code: 'desktop_failed', message: 'settings are locked' },
    });

    const result = (await desktopSettings.handler(
      { ...TARGET, op: 'get' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBe(true);
    expect(body(result).error).toMatchObject({ code: 'desktop_failed', message: 'settings are locked' });
  });

  test('desktop_settings success is untouched', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({ ok: true, settings: { execEnabled: true } });

    const result = (await desktopSettings.handler(
      { ...TARGET, op: 'get' },
      makeContext(),
    )) as McpResult;

    expect(result.isError).toBeUndefined();
    expect(body(result)).toEqual({ ok: true, settings: { execEnabled: true } });
  });
});
