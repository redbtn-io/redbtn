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
  desktopMove,
  desktopType,
  desktopKey,
  desktopScroll,
  desktopScreenInfo,
  desktopExec,
  desktopSettings,
  desktopPing,
} from '../../src/lib/tools/native/desktop-computer';
import alertDesktopTool from '../../src/lib/tools/native/alert-desktop';

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

function textBody(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content.find((item) => item.type === 'text');
  if (!block?.text) throw new Error('missing text block');
  return JSON.parse(block.text);
}

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
  requestDesktopMock.mockResolvedValue({ kind: 'computer_result', id: 'req_1', ok: true });
  requestDesktopRawMock.mockResolvedValue({ ok: true, result: { stdout: '', stderr: '', exitCode: 0 } });
});

describe('desktop tools — schema targeting', () => {
  test('all desktop action tools require environmentId', () => {
    expect(desktopScreenshot.inputSchema.required).toEqual(['environmentId']);
    expect(desktopClick.inputSchema.required).toEqual(['environmentId', 'x', 'y']);
    expect(desktopMove.inputSchema.required).toEqual(['environmentId', 'x', 'y']);
    expect(desktopType.inputSchema.required).toEqual(['environmentId', 'text']);
    expect(desktopKey.inputSchema.required).toEqual(['environmentId', 'keys']);
    expect(desktopScroll.inputSchema.required).toEqual(['environmentId']);
    expect(desktopScreenInfo.inputSchema.required).toEqual(['environmentId']);
    expect(desktopExec.inputSchema.required).toEqual(['environmentId', 'command']);
    expect(desktopSettings.inputSchema.required).toEqual(['environmentId', 'op']);
    expect(desktopPing.inputSchema.required).toEqual(['environmentId']);
    expect(alertDesktopTool.inputSchema.required).toEqual(['environmentId', 'title', 'body']);
  });
});

describe('desktop computer-use tools — strict target handling', () => {
  test('missing environmentId fails before resolving or publishing', async () => {
    const result = await desktopScreenInfo.handler({}, makeContext());

    expect(textBody(result)).toEqual({
      ok: false,
      error: {
        code: 'computer_failed',
        message: 'environmentId is required to target a desktop instance.',
      },
    });
    expect(loadAndResolveEnvironmentMock).not.toHaveBeenCalled();
    expect(requestDesktopMock).not.toHaveBeenCalled();
  });

  test('missing installId fails without publishing', async () => {
    loadAndResolveEnvironmentMock.mockResolvedValueOnce({
      env: { environmentId: 'env_desktop', userId: 'user_a', kind: 'desktop-agent' },
      sshKey: '',
    });

    const result = await desktopClick.handler(
      { environmentId: 'env_desktop', x: 10, y: 20 },
      makeContext(),
    );

    expect(textBody(result)).toEqual({
      ok: false,
      error: {
        code: 'computer_failed',
        message: 'Target environment env_desktop does not have an active desktop connection (missing installId).',
      },
    });
    expect(requestDesktopMock).not.toHaveBeenCalled();
  });

  test('resolves environmentId and passes installId to requestDesktop', async () => {
    await desktopClick.handler(
      { environmentId: 'env_desktop', x: 10, y: 20, button: 'right', timeoutMs: 5000 },
      makeContext(),
    );

    expect(loadAndResolveEnvironmentMock).toHaveBeenCalledWith('env_desktop', 'user_a');
    expect(requestDesktopMock).toHaveBeenCalledWith({
      userId: 'user_a',
      installId: 'install_123',
      timeoutMs: 5000,
      request: {
        action: 'mouse',
        op: 'click',
        x: 10,
        y: 20,
        button: 'right',
        double: false,
      },
    });
  });

  test('screenshot returns image content after targeted request succeeds', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_1',
      ok: true,
      image: { format: 'jpeg', base64: 'abc123', width: 640, height: 360 },
    });

    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', format: 'jpeg' },
      makeContext(),
    );

    expect(result.content[0]).toEqual({ type: 'image', data: 'abc123', mimeType: 'image/jpeg' });
    expect(textBody(result)).toMatchObject({
      ok: true,
      format: 'jpeg',
      width: 640,
      height: 360,
      mimeType: 'image/jpeg',
      base64: 'abc123',
    });
  });
});

describe('desktop exec/settings tools — strict target handling', () => {
  test('desktop_exec resolves target and passes installId to requestDesktopRaw', async () => {
    await desktopExec.handler(
      {
        environmentId: 'env_desktop',
        command: 'echo',
        args: ['hello'],
        cwd: '/tmp',
        timeoutMs: 7000,
      },
      makeContext(),
    );

    expect(requestDesktopRawMock).toHaveBeenCalledWith({
      userId: 'user_a',
      installId: 'install_123',
      kind: 'exec',
      timeoutMs: 7000,
      payload: {
        command: 'echo',
        args: ['hello'],
        cwd: '/tmp',
        timeoutMs: 7000,
      },
    });
  });

  test('desktop_settings resolves target and passes installId to requestDesktopRaw', async () => {
    await desktopSettings.handler(
      {
        environmentId: 'env_desktop',
        op: 'set',
        patch: { computerUseEnabled: true },
      },
      makeContext(),
    );

    expect(requestDesktopRawMock).toHaveBeenCalledWith({
      userId: 'user_a',
      installId: 'install_123',
      kind: 'settings',
      timeoutMs: undefined,
      payload: {
        op: 'set',
        patch: { computerUseEnabled: true },
      },
    });
  });
});

describe('alert_desktop — strict target handling', () => {
  test('missing environmentId fails validation', async () => {
    const result = await alertDesktopTool.handler({ title: 'Hi', body: 'There' }, makeContext());

    expect(result.isError).toBe(true);
    expect(textBody(result)).toEqual({
      code: 'VALIDATION',
      error: 'environmentId, title, and body are required non-empty strings',
    });
    expect(loadAndResolveEnvironmentMock).not.toHaveBeenCalled();
  });
});

describe('desktop_ping tool', () => {
  test('ping success returns latency and ok', async () => {
    requestDesktopRawMock.mockResolvedValueOnce({
      ok: true,
      settings: { computerUseRequireConsent: false },
    });

    const result = await desktopPing.handler(
      { environmentId: 'env_desktop', timeoutMs: 5000 },
      makeContext(),
    );

    expect(requestDesktopRawMock).toHaveBeenCalledWith({
      userId: 'user_a',
      installId: 'install_123',
      kind: 'settings',
      payload: { op: 'get' },
      timeoutMs: 5000,
    });
    const body = textBody(result);
    expect(body.ok).toBe(true);
    expect(body.latencyMs).toBeLessThanOrEqual(1000);
    expect(body.message).toContain('Pong!');
  });
});
