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
  desktopKey,
  desktopReadText,
  desktopFindText,
  desktopClickText,
  desktopFindImage,
  desktopWaitFor,
  desktopHover,
  desktopDrag,
  desktopBatch,
} from '../../src/lib/tools/native/desktop-computer';
import { formatToolResultForModel } from '../../src/lib/nodes/universal/executors/neuronExecutor';

function makeContext(userId = 'user_test'): NativeToolContext {
  return {
    publisher: { emit: vi.fn() },
    state: { userId },
    runId: 'run_test_1',
    nodeId: 'node_test_1',
    toolId: 'tool_test_1',
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
      userId: 'user_test',
      kind: 'desktop-agent',
      installId: 'install_uuid_123',
    },
    sshKey: '',
  });
  requestDesktopMock.mockResolvedValue({ kind: 'computer_result', id: 'req_1', ok: true });
});

describe('extended desktop actions (parity)', () => {
  test('desktop_click supports smooth, speed, and machine targeting', async () => {
    const res = await desktopClick.handler(
      { machine: 'env_desktop', x: 100, y: 200, smooth: true, speed: 'fast' },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        installId: 'install_uuid_123',
        request: expect.objectContaining({
          action: 'mouse',
          op: 'click',
          x: 100,
          y: 200,
          smooth: true,
          speed: 'fast',
        }),
      }),
    );
  });

  test('desktop_move supports relative movement, transport, and velocity parameters', async () => {
    const res = await desktopMove.handler(
      {
        environmentId: 'env_desktop',
        x: 0,
        y: 0,
        relative: true,
        dx: 25,
        dy: -40,
        transport: 'virtual-hid',
        smooth: true,
        speed: 'instant',
        durationMs: 150,
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'move',
          relative: true,
          dx: 25,
          dy: -40,
          transport: 'virtual-hid',
          smooth: true,
          speed: 'instant',
          durationMs: 150,
        }),
      }),
    );
  });

  test('desktop_key supports opMode (down/up/tap) and durationMs hold', async () => {
    const res = await desktopKey.handler(
      {
        environmentId: 'env_desktop',
        keys: ['shift', 'a'],
        opMode: 'down',
        durationMs: 500,
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'keyboard',
          op: 'down',
          opMode: 'down',
          keys: ['shift', 'a'],
          durationMs: 500,
        }),
      }),
    );
  });
});

describe('new desktop perception and input tools', () => {
  test('desktop_read_text invokes ocr read and returns structured text + geometry', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_ocr_1',
      ok: true,
      ocr: {
        text: 'Inventory\nSword',
        lines: [
          { text: 'Inventory', box: { x: 10, y: 20, w: 80, h: 25 } },
          { text: 'Sword', box: { x: 10, y: 50, w: 60, h: 25 } },
        ],
        clickSpace: { w: 1920, h: 1080 },
      },
    });

    const res = await desktopReadText.handler(
      { environmentId: 'env_desktop', region: { x: 0, y: 0, w: 500, h: 500 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.text).toBe('Inventory\nSword');
    expect(body.lines).toHaveLength(2);
    expect(body.clickSpace).toEqual({ w: 1920, h: 1080 });
  });

  test('desktop_find_text validates query and returns matches in click space', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_find_1',
      ok: true,
      ocr: {
        matches: [{ text: 'Submit', box: { x: 100, y: 200, w: 80, h: 30 }, center: { x: 140, y: 215 } }],
        clickSpace: { w: 1920, h: 1080 },
      },
    });

    const res = await desktopFindText.handler(
      { environmentId: 'env_desktop', text: 'Submit' },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.matches[0].center).toEqual({ x: 140, y: 215 });
  });

  test('desktop_click_text dispatches click_text action with offset and occurrence', async () => {
    const res = await desktopClickText.handler(
      {
        environmentId: 'env_desktop',
        text: 'Close',
        occurrence: 'first',
        offset: { x: 5, y: -5 },
        button: 'left',
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'ocr',
          op: 'click',
          text: 'Close',
          occurrence: 'first',
          offset: { x: 5, y: -5 },
        }),
      }),
    );
  });

  test('desktop_find_image dispatches template matching and returns candidates', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_img_1',
      ok: true,
      matches: [{ box: { x: 50, y: 60, w: 40, h: 40 }, center: { x: 70, y: 80 }, score: 0.95 }],
      clickSpace: { w: 1920, h: 1080 },
    });

    const res = await desktopFindImage.handler(
      { environmentId: 'env_desktop', template: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', threshold: 0.85 },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].score).toBe(0.95);
  });

  test('desktop_wait_for passes timeout margin and returns evidence image block on failure', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_wait_1',
      ok: false,
      error: { code: 'computer_failed', message: 'wait_for timed out after 5000ms' },
      result: {
        reason: 'timeout',
        elapsedMs: 5000,
        evidence: {
          format: 'png',
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          width: 100,
          height: 100,
        },
      },
    });

    const res = await desktopWaitFor.handler(
      { environmentId: 'env_desktop', text: 'Loading Complete', timeoutMs: 5000 },
      makeContext(),
    );

    // Timeout margin: 5000 + 5000 = 10000ms
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        timeoutMs: 10000,
      }),
    );
    expect(res.isError).toBe(true);
    const imgBlock = res.content.find((c) => c.type === 'image');
    expect(imgBlock).toBeDefined();
    expect(imgBlock?.mimeType).toBe('image/png');
  });

  test('desktop_hover sends hover action and returns region screenshot if requested', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_hover_1',
      ok: true,
      result: {
        op: 'hover',
        dwellMs: 400,
        screenshot: {
          format: 'png',
          base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          width: 200,
          height: 150,
        },
      },
    });

    const res = await desktopHover.handler(
      { environmentId: 'env_desktop', x: 250, y: 300, dwellMs: 400, region: { x: 200, y: 250, w: 200, h: 150 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const imgBlock = res.content.find((c) => c.type === 'image');
    expect(imgBlock).toBeDefined();
  });

  test('desktop_drag sends drag action with from and to coordinates', async () => {
    const res = await desktopDrag.handler(
      {
        environmentId: 'env_desktop',
        from: { x: 100, y: 100 },
        to: { x: 300, y: 400 },
        button: 'left',
        durationMs: 800,
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'drag',
          from: { x: 100, y: 100 },
          to: { x: 300, y: 400 },
          durationMs: 800,
        }),
      }),
    );
  });

  test('desktop_batch validates steps and routes atomic batch sequence', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_batch_1',
      ok: true,
      result: {
        completed: 2,
        total: 2,
        results: [
          { ok: true, op: 'click' },
          { ok: true, op: 'wait_for', result: { elapsedMs: 350 } },
        ],
      },
    });

    const steps = [
      { op: 'click' as const, x: 50, y: 50 },
      { op: 'wait_for' as const, text: 'Done' },
    ];
    const res = await desktopBatch.handler(
      { environmentId: 'env_desktop', steps, abortOnError: true },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.result.completed).toBe(2);
  });
});

describe('neuronExecutor formatToolResultForModel image delivery', () => {
  const dummyB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='.repeat(3);

  test('extracts top-level image from unwrapped screenshot result and strips base64 from text', () => {
    const unwrapped = {
      ok: true,
      format: 'png',
      width: 1920,
      height: 1080,
      mimeType: 'image/png',
      base64: dummyB64,
      dataUrl: `data:image/png;base64,${dummyB64}`,
    };
    const formatted = formatToolResultForModel(unwrapped);
    expect(formatted.images).toHaveLength(1);
    expect(formatted.images[0]).toContain('data:image/png;base64,');
    expect(formatted.text).not.toContain(dummyB64);
    expect(formatted.text).toContain('"ok":true');
  });

  test('extracts nested hover screenshot image from unwrapped result', () => {
    const unwrapped = {
      ok: true,
      result: {
        op: 'hover',
        dwellMs: 300,
        image: {
          format: 'png',
          width: 200,
          height: 100,
          base64: dummyB64,
        },
      },
    };
    const formatted = formatToolResultForModel(unwrapped);
    expect(formatted.images).toHaveLength(1);
    expect(formatted.images[0]).toContain('data:image/png;base64,');
    expect(formatted.text).not.toContain(dummyB64);
    expect(formatted.text).toContain('"op":"hover"');
  });

  test('extracts nested wait_for timeout evidence from unwrapped error result', () => {
    const unwrapped = {
      ok: false,
      error: { code: 'computer_failed', message: 'timeout' },
      result: {
        reason: 'timeout',
        elapsedMs: 5000,
        evidence: {
          format: 'png',
          width: 300,
          height: 200,
          base64: dummyB64,
        },
      },
    };
    const formatted = formatToolResultForModel(unwrapped);
    expect(formatted.images).toHaveLength(1);
    expect(formatted.images[0]).toContain('data:image/png;base64,');
    expect(formatted.text).not.toContain(dummyB64);
    expect(formatted.text).toContain('"reason":"timeout"');
  });

  test('extracts step images from unwrapped batch results', () => {
    const unwrapped = {
      ok: true,
      result: {
        results: [
          { ok: true, op: 'click' },
          { ok: true, op: 'screenshot', result: { format: 'png', width: 800, height: 600, base64: dummyB64 } },
        ],
      },
    };
    const formatted = formatToolResultForModel(unwrapped);
    expect(formatted.images).toHaveLength(1);
    expect(formatted.images[0]).toContain('data:image/png;base64,');
    expect(formatted.text).not.toContain(dummyB64);
  });
});
