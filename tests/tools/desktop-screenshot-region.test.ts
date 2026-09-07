/**
 * desktop_screenshot — zoom (`region` / `fullRes`).
 *
 * The desktop has always been able to crop at native resolution; the ENGINE
 * tool hid it, so every screenshot the model saw was the click-space downscale
 * and small text was unreadable. These tests pin the three things that make
 * zoom real: the schema advertises it, the built ComputerAction carries it
 * VERBATIM (no engine-side clamping — the desktop owns that), and the result
 * echoes which view the model is actually looking at.
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

import { desktopScreenshot } from '../../src/lib/tools/native/desktop-computer';

function makeContext(userId = 'user_a'): NativeToolContext {
  return {
    publisher: { emit: vi.fn() },
    state: { userId },
    runId: 'run_1',
    nodeId: 'node_1',
    toolId: 'tool_1',
    abortSignal: null,
  } as unknown as NativeToolContext;
}

function textBody(result: { content: Array<{ type: string; text?: string }> }) {
  const block = result.content.find((item) => item.type === 'text');
  if (!block?.text) throw new Error('missing text block');
  return JSON.parse(block.text);
}

function sentRequest() {
  return requestDesktopMock.mock.calls.at(-1)?.[0]?.request;
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
  requestDesktopMock.mockResolvedValue({
    kind: 'computer_result',
    id: 'req_1',
    ok: true,
    image: {
      format: 'png',
      base64: 'abc123',
      width: 480,
      height: 240,
      sourceWidth: 1920,
      sourceHeight: 1080,
      clickSpace: { w: 1366, h: 768 },
    },
  });
});

describe('desktop_screenshot — zoom schema', () => {
  test('advertises an optional integer region rectangle in click space', () => {
    const region = desktopScreenshot.inputSchema.properties?.region as {
      type: string;
      description: string;
      properties: Record<string, { type: string; minimum: number }>;
      required: string[];
    };

    expect(region).toBeDefined();
    expect(region.type).toBe('object');
    expect(region.required).toEqual(['x', 'y', 'w', 'h']);
    expect(region.properties.x).toMatchObject({ type: 'integer', minimum: 0 });
    expect(region.properties.y).toMatchObject({ type: 'integer', minimum: 0 });
    expect(region.properties.w).toMatchObject({ type: 'integer', minimum: 1 });
    expect(region.properties.h).toMatchObject({ type: 'integer', minimum: 1 });
    expect(desktopScreenshot.inputSchema.required).not.toContain('region');
  });

  test('region description names the click-space contract, native crop, and clamping', () => {
    const description = String(
      (desktopScreenshot.inputSchema.properties?.region as { description?: string })?.description,
    );
    expect(description).toContain('desktop_click');
    expect(description).toContain('desktop_move');
    expect(description).toMatch(/CLICK SPACE/i);
    expect(description).toMatch(/native/i);
    expect(description).toMatch(/clamp/i);
  });

  test('advertises an optional fullRes flag that warns about size', () => {
    const fullRes = desktopScreenshot.inputSchema.properties?.fullRes as {
      type: string;
      default: boolean;
      description: string;
    };

    expect(fullRes).toMatchObject({ type: 'boolean', default: false });
    expect(fullRes.description).toMatch(/large/i);
    expect(fullRes.description).toContain('region');
    expect(desktopScreenshot.inputSchema.required).not.toContain('fullRes');
  });

  test('the tool description tells the model it can zoom', () => {
    expect(desktopScreenshot.description).toMatch(/zoom/i);
    expect(desktopScreenshot.description).toContain('region');
    expect(desktopScreenshot.description).toContain('fullRes');
  });
});

describe('desktop_screenshot — zoom request passthrough', () => {
  test('forwards region verbatim, without engine-side clamping', async () => {
    // Deliberately absurd: far outside any click space. The desktop clamps
    // (computerUse.ts Math.max/Math.min); the engine must NOT rewrite it.
    await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: { x: 9000, y: 9000, w: 100000, h: 100000 } },
      makeContext(),
    );

    expect(sentRequest()).toEqual({
      action: 'screenshot',
      format: 'png',
      region: { x: 9000, y: 9000, w: 100000, h: 100000 },
    });
  });

  test('region composes with display and format', async () => {
    await desktopScreenshot.handler(
      {
        environmentId: 'env_desktop',
        display: 1,
        format: 'jpeg',
        region: { x: 10, y: 20, w: 300, h: 200 },
      },
      makeContext(),
    );

    expect(sentRequest()).toEqual({
      action: 'screenshot',
      format: 'jpeg',
      display: 1,
      region: { x: 10, y: 20, w: 300, h: 200 },
    });
  });

  test('fullRes:true is forwarded; false/omitted is not sent at all', async () => {
    await desktopScreenshot.handler(
      { environmentId: 'env_desktop', fullRes: true },
      makeContext(),
    );
    expect(sentRequest()).toEqual({ action: 'screenshot', format: 'png', fullRes: true });

    await desktopScreenshot.handler(
      { environmentId: 'env_desktop', fullRes: false },
      makeContext(),
    );
    expect(sentRequest()).toEqual({ action: 'screenshot', format: 'png' });

    await desktopScreenshot.handler({ environmentId: 'env_desktop' }, makeContext());
    expect(sentRequest()).toEqual({ action: 'screenshot', format: 'png' });
  });

  test('zero-origin region is legal (x/y may be 0)', async () => {
    await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: { x: 0, y: 0, w: 1, h: 1 } },
      makeContext(),
    );

    expect(sentRequest()).toMatchObject({ region: { x: 0, y: 0, w: 1, h: 1 } });
  });
});

describe('desktop_screenshot — zoom validation', () => {
  const bad: Array<[string, unknown]> = [
    ['non-object', 'left half'],
    ['array', [0, 0, 100, 100]],
    ['missing w/h', { x: 0, y: 0 }],
    ['negative x', { x: -1, y: 0, w: 10, h: 10 }],
    ['negative y', { x: 0, y: -5, w: 10, h: 10 }],
    ['zero width', { x: 0, y: 0, w: 0, h: 10 }],
    ['zero height', { x: 0, y: 0, w: 10, h: 0 }],
    ['fractional x', { x: 1.5, y: 0, w: 10, h: 10 }],
    ['fractional w', { x: 0, y: 0, w: 10.25, h: 10 }],
    ['numeric strings', { x: '0', y: '0', w: '10', h: '10' }],
    ['NaN', { x: Number.NaN, y: 0, w: 10, h: 10 }],
  ];

  test.each(bad)('rejects %s without touching the desktop', async (_label, region) => {
    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(textBody(result)).toEqual({
      ok: false,
      error: {
        code: 'computer_failed',
        message:
          'region must be { x, y, w, h } integers in click space with x >= 0, y >= 0, w >= 1, h >= 1',
      },
    });
    expect(requestDesktopMock).not.toHaveBeenCalled();
  });

  test('region:null means "no region", not an invalid one', async () => {
    await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: null },
      makeContext(),
    );

    expect(sentRequest()).toEqual({ action: 'screenshot', format: 'png' });
  });
});

describe('desktop_screenshot — result echoes the view', () => {
  test('a zoomed capture echoes the requested region and fullRes:false', async () => {
    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: { x: 100, y: 50, w: 400, h: 200 } },
      makeContext(),
    );

    expect(textBody(result)).toMatchObject({
      ok: true,
      region: { x: 100, y: 50, w: 400, h: 200 },
      fullRes: false,
      width: 480,
      height: 240,
      sourceWidth: 1920,
      sourceHeight: 1080,
      clickSpace: { w: 1366, h: 768 },
    });
  });

  test('a fullRes capture echoes fullRes:true and region:null', async () => {
    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', fullRes: true },
      makeContext(),
    );

    expect(textBody(result)).toMatchObject({ ok: true, region: null, fullRes: true });
  });

  test('the default overview echoes region:null, fullRes:false', async () => {
    const result = await desktopScreenshot.handler({ environmentId: 'env_desktop' }, makeContext());

    expect(textBody(result)).toMatchObject({ ok: true, region: null, fullRes: false });
  });

  test('region wins over fullRes in the echo, matching the desktop crop path', async () => {
    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: { x: 1, y: 2, w: 3, h: 4 }, fullRes: true },
      makeContext(),
    );

    expect(textBody(result)).toMatchObject({ region: { x: 1, y: 2, w: 3, h: 4 }, fullRes: false });
  });

  test('the image content block path is unchanged by zoom', async () => {
    const result = await desktopScreenshot.handler(
      { environmentId: 'env_desktop', region: { x: 0, y: 0, w: 100, h: 100 } },
      makeContext(),
    );

    expect(result.content[0]).toEqual({ type: 'image', data: 'abc123', mimeType: 'image/png' });
    expect(result.content[1]?.type).toBe('text');
    expect(textBody(result)).toMatchObject({
      mimeType: 'image/png',
      base64: 'abc123',
      dataUrl: 'data:image/png;base64,abc123',
    });
  });
});
