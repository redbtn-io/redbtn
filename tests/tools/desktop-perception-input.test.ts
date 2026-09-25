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
  desktopReadText,
  desktopFindText,
  desktopClickText,
  desktopFindImage,
  desktopWaitFor,
  desktopHover,
  desktopDrag,
  desktopBatch,
  desktopListWindows,
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

  test('desktop_drag sends drag action with normalized nx and ny coordinates', async () => {
    const res = await desktopDrag.handler(
      {
        environmentId: 'env_desktop',
        window: 'Game App',
        from: { nx: 0.2, ny: 0.3 },
        to: { nx: 0.7, ny: 0.8 },
        button: 'left',
        durationMs: 500,
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'drag',
          window: 'Game App',
          from: { nx: 0.2, ny: 0.3 },
          to: { nx: 0.7, ny: 0.8 },
          durationMs: 500,
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

describe('desktop screenshot around and action screenshot parity (Addendum 2)', () => {
  const dummyB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

  test('desktop_screenshot supports around: {x,y} and size: {w,h}', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_shot_1',
      ok: true,
      image: { format: 'png', base64: dummyB64, width: 300, height: 150 },
    });
    const res = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', around: { x: 500, y: 300 }, size: { w: 300, h: 150 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'screenshot',
          around: { x: 500, y: 300 },
          size: { w: 300, h: 150 },
        }),
      }),
    );
    const body = textBody(res);
    expect(body.around).toEqual({ x: 500, y: 300 });
    expect(body.size).toEqual({ w: 300, h: 150 });
  });

  test('desktop_screenshot supports around: "cursor"', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_shot_2',
      ok: true,
      image: { format: 'png', base64: dummyB64, width: 400, height: 200 },
    });
    const res = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', around: 'cursor' },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'screenshot',
          around: 'cursor',
        }),
      }),
    );
    const body = textBody(res);
    expect(body.around).toBe('cursor');
  });

  test('desktop_click forwards screenshot:true and size, returning extracted MCP image block', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_click_1',
      ok: true,
      result: {
        op: 'click',
        x: 200,
        y: 400,
        image: {
          format: 'png',
          base64: dummyB64,
          width: 400,
          height: 200,
        },
      },
    });

    const res = await desktopClick.handler(
      { environmentId: 'env_desktop', x: 200, y: 400, screenshot: true, size: { w: 400, h: 200 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'click',
          screenshot: true,
          size: { w: 400, h: 200 },
        }),
      }),
    );
    expect(res.content.some((b) => b.type === 'image' && (b as any).data === dummyB64)).toBe(true);
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.result.image?.base64).toBeUndefined(); // base64 stripped from text JSON
    expect(body.result.image?.width).toBe(400);
  });

  test('desktop_hover forwards screenshot:true and size', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_hover_1',
      ok: true,
      result: {
        op: 'hover',
        x: 150,
        y: 250,
        image: {
          format: 'png',
          base64: dummyB64,
          width: 300,
          height: 150,
        },
      },
    });

    const res = await desktopHover.handler(
      { environmentId: 'env_desktop', x: 150, y: 250, screenshot: true, size: { w: 300, h: 150 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'hover',
          screenshot: true,
          size: { w: 300, h: 150 },
        }),
      }),
    );
    expect(res.content.some((b) => b.type === 'image' && (b as any).data === dummyB64)).toBe(true);
  });

  test('desktop_drag forwards screenshot:true and size', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_drag_1',
      ok: true,
      result: {
        op: 'drag',
        image: {
          format: 'png',
          base64: dummyB64,
          width: 400,
          height: 200,
        },
      },
    });

    const res = await desktopDrag.handler(
      { environmentId: 'env_desktop', to: { x: 300, y: 300 }, screenshot: true, size: { w: 400, h: 200 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'drag',
          screenshot: true,
          size: { w: 400, h: 200 },
        }),
      }),
    );
    expect(res.content.some((b) => b.type === 'image' && (b as any).data === dummyB64)).toBe(true);
  });

  test('desktop_click_text forwards screenshot:true and size', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_click_text_1',
      ok: true,
      result: {
        op: 'click',
        image: {
          format: 'png',
          base64: dummyB64,
          width: 400,
          height: 200,
        },
      },
    });

    const res = await desktopClickText.handler(
      { environmentId: 'env_desktop', text: 'Submit', screenshot: true, size: { w: 400, h: 200 } },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'ocr',
          op: 'click',
          screenshot: true,
          size: { w: 400, h: 200 },
        }),
      }),
    );
    expect(res.content.some((b) => b.type === 'image' && (b as any).data === dummyB64)).toBe(true);
  });

  test('desktop_find_image and desktop_wait_for accept templateBase64 alias', async () => {
    await desktopFindImage.handler(
      { environmentId: 'env_desktop', templateBase64: dummyB64 },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'find_image',
          template: dummyB64,
        }),
      }),
    );

    await desktopWaitFor.handler(
      { environmentId: 'env_desktop', templateBase64: dummyB64 },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'wait_for',
          template: dummyB64,
        }),
      }),
    );
  });

  test('desktop_batch normalizes action -> op, templateBase64 -> template and extracts images', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_batch_1',
      ok: true,
      result: {
        results: [
          { ok: true, op: 'click', image: { format: 'png', base64: dummyB64 } },
        ],
      },
    });

    const res = await desktopBatch.handler(
      {
        environmentId: 'env_desktop',
        steps: [
          { action: 'click', x: 100, y: 100, screenshot: true },
          { action: 'wait_for', templateBase64: dummyB64 },
        ],
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'batch',
          steps: [
            expect.objectContaining({ op: 'click', x: 100, y: 100, screenshot: true }),
            expect.objectContaining({ op: 'wait_for', template: dummyB64 }),
          ],
        }),
      }),
    );
    expect(res.content.some((b) => b.type === 'image' && (b as any).data === dummyB64)).toBe(true);
  });

  test('desktop_list_windows dispatches list_windows action and returns windows', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_win_1',
      ok: true,
      windows: [
        {
          id: 1234,
          title: 'Black Desert',
          bounds: { x: 100, y: 100, width: 1920, height: 1080 },
          display: 0,
          focused: true,
          minimized: false,
        },
      ],
    });

    const res = await desktopListWindows.handler(
      { environmentId: 'env_desktop' },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: { action: 'list_windows' },
      }),
    );
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0].title).toBe('Black Desert');
  });

  test('desktop_screenshot supports window targeting, normalized region, and reports captureMode and windowRect', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      id: 'req_shot_1',
      ok: true,
      image: {
        format: 'png',
        base64: dummyB64,
        width: 800,
        height: 600,
        captureMode: 'display-crop',
        windowRect: { x: 50, y: 50, width: 800, height: 600 },
        clickSpace: { w: 800, h: 600 },
      },
    });

    const res = await desktopScreenshot.handler(
      {
        environmentId: 'env_desktop',
        window: 'Black Desert',
        region: { nx: 0.1, ny: 0.1, nw: 0.8, nh: 0.8 },
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'screenshot',
          window: 'Black Desert',
          region: { nx: 0.1, ny: 0.1, nw: 0.8, nh: 0.8 },
        }),
      }),
    );
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.captureMode).toBe('display-crop');
    expect(body.windowRect).toEqual({ x: 50, y: 50, width: 800, height: 600 });
    expect(body.window).toBe('Black Desert');
  });

  test('desktop_screenshot does not invent captureMode when desktop does not report one', async () => {
    requestDesktopMock.mockResolvedValueOnce({
      kind: 'computer_result',
      ok: true,
      image: {
        format: 'jpeg',
        base64: dummyB64,
        width: 800,
        height: 600,
        clickSpace: { w: 800, h: 600 },
      },
    });

    const res = await desktopScreenshot.handler(
      {
        environmentId: 'env_desktop',
        window: 'Terminal',
      },
      makeContext(),
    );
    expect(res.isError).toBeFalsy();
    const body = textBody(res);
    expect(body.ok).toBe(true);
    expect(body.captureMode).toBeNull();
    expect(body.window).toBe('Terminal');
  });

  test('desktop_click and desktop_move support window targeting and normalized nx, ny coordinates', async () => {
    await desktopClick.handler(
      { environmentId: 'env_desktop', window: { id: 42 }, nx: 0.5, ny: 0.75 },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'click',
          window: { id: 42 },
          nx: 0.5,
          ny: 0.75,
        }),
      }),
    );

    await desktopMove.handler(
      { environmentId: 'env_desktop', window: 'GameWindow', nx: 0.2, ny: 0.3 },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'move',
          window: 'GameWindow',
          nx: 0.2,
          ny: 0.3,
        }),
      }),
    );
  });

  test('desktop_read_text, desktop_find_text, desktop_click_text, desktop_hover, desktop_drag, and desktop_wait_for forward window parameter', async () => {
    await desktopReadText.handler(
      { environmentId: 'env_desktop', window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'ocr',
          op: 'read',
          window: 'GameWindow',
        }),
      }),
    );

    await desktopFindText.handler(
      { environmentId: 'env_desktop', text: 'Start', window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'ocr',
          op: 'find',
          text: 'Start',
          window: 'GameWindow',
        }),
      }),
    );

    await desktopClickText.handler(
      { environmentId: 'env_desktop', text: 'Play', window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'ocr',
          op: 'click',
          text: 'Play',
          window: 'GameWindow',
        }),
      }),
    );

    await desktopHover.handler(
      { environmentId: 'env_desktop', x: 200, y: 300, window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'hover',
          x: 200,
          y: 300,
          window: 'GameWindow',
        }),
      }),
    );

    await desktopDrag.handler(
      { environmentId: 'env_desktop', to: { x: 500, y: 500 }, window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'drag',
          to: { x: 500, y: 500 },
          window: 'GameWindow',
        }),
      }),
    );

    await desktopWaitFor.handler(
      { environmentId: 'env_desktop', text: 'Ready', window: 'GameWindow' },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'wait_for',
          text: 'Ready',
          window: 'GameWindow',
        }),
      }),
    );
  });

  test('desktop_batch forwards batch-level window and inherits onto child steps', async () => {
    await desktopBatch.handler(
      {
        environmentId: 'env_desktop',
        window: 'GameWindow',
        steps: [
          { action: 'click', nx: 0.5, ny: 0.5 },
          { action: 'move', x: 100, y: 100, window: 'OtherWindow' },
        ],
      },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'batch',
          window: 'GameWindow',
          steps: [
            expect.objectContaining({ op: 'click', nx: 0.5, ny: 0.5, window: 'GameWindow' }),
            expect.objectContaining({ op: 'move', x: 100, y: 100, window: 'OtherWindow' }),
          ],
        }),
      }),
    );
  });

  test('desktop tools forward bringToFront and window targeting', async () => {
    await desktopClick.handler(
      { environmentId: 'env_desktop', x: 10, y: 20, window: 'Editor', bringToFront: true },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'click',
          window: 'Editor',
          bringToFront: true,
        }),
      }),
    );

    await desktopType.handler(
      { environmentId: 'env_desktop', text: 'Hello', window: 'Editor', bringToFront: true },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'keyboard',
          op: 'type',
          text: 'Hello',
          window: 'Editor',
          bringToFront: true,
        }),
      }),
    );

    await desktopKey.handler(
      { environmentId: 'env_desktop', keys: ['enter'], window: 'Editor', bringToFront: true },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'keyboard',
          keys: ['enter'],
          window: 'Editor',
          bringToFront: true,
        }),
      }),
    );

    await desktopScroll.handler(
      { environmentId: 'env_desktop', dy: 100, window: 'Editor', bringToFront: true },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'scroll',
          window: 'Editor',
          bringToFront: true,
        }),
      }),
    );

    await desktopDrag.handler(
      { environmentId: 'env_desktop', to: { x: 50, y: 50 }, window: 'Editor', bringToFront: true },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'mouse',
          op: 'drag',
          window: 'Editor',
          bringToFront: true,
        }),
      }),
    );
  });

  test('desktop_batch forwards bringToFront at batch level and defaults to steps', async () => {
    await desktopBatch.handler(
      {
        environmentId: 'env_desktop',
        window: 'AppWindow',
        bringToFront: true,
        steps: [
          { action: 'click', nx: 0.1, ny: 0.2 },
          { action: 'type', text: 'abc', bringToFront: false },
        ],
      },
      makeContext(),
    );
    expect(requestDesktopMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          action: 'batch',
          window: 'AppWindow',
          bringToFront: true,
          steps: [
            expect.objectContaining({ op: 'click', nx: 0.1, ny: 0.2, window: 'AppWindow', bringToFront: true }),
            expect.objectContaining({ op: 'type', text: 'abc', window: 'AppWindow', bringToFront: false }),
          ],
        }),
      }),
    );
  });
});

