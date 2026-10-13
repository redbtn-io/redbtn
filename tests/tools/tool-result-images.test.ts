/**
 * Image blocks returned by tools reach the MODEL (engine 0.0.300).
 *
 * tool-resolver used to unwrap every MCP-shaped result to its first text
 * block, so a tool returning {content:[{type:'image',data},{type:'text'}]}
 * (mcp-gateway redboard_attachment_view, gateway #124) reached the neuron as
 * "mind-light.png (image/png, 233885 bytes)" and the model never saw the
 * picture. Image-bearing results now stay raw, so
 * neuronExecutor.formatToolResultForModel builds the vision message from
 * them. Text-only results are unwrapped exactly as before.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resolveTools, hasImageBlock } from '../../src/lib/tools/tool-resolver';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { formatToolResultForModel } from '../../src/lib/nodes/universal/executors/neuronExecutor';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const IMAGE_RESULT = {
  content: [
    { type: 'image', data: PNG, mimeType: 'image/png' },
    { type: 'text', text: 'mind-light.png (image/png, 233885 bytes)' },
  ],
};
const ctx = (state: Any): Any => ({ state, runId: null, toolId: 't1', abortSignal: null });

beforeAll(() => {
  const reg = getNativeRegistry();
  if (!reg.has('test_image_tool')) {
    reg.register('test_image_tool', {
      description: 'Returns an image and a caption',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => structuredClone(IMAGE_RESULT) as Any,
    });
  }
  if (!reg.has('test_text_json_tool')) {
    reg.register('test_text_json_tool', {
      description: 'Returns JSON text',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: '{"ok":true,"n":2}' }] }),
    });
  }
});

describe('hasImageBlock', () => {
  it('needs an image block with data', () => {
    expect(hasImageBlock(IMAGE_RESULT)).toBe(true);
    expect(hasImageBlock({ content: [{ type: 'image', data: '' }] })).toBe(false);
    expect(hasImageBlock({ content: [{ type: 'text', text: 'x' }] })).toBe(false);
    expect(hasImageBlock(null)).toBe(false);
    expect(hasImageBlock('x')).toBe(false);
  });
});

describe('native tools in the neuron loop', () => {
  it('an image result is returned raw (image block kept)', async () => {
    const [t] = await resolveTools(['test_image_tool'], {});
    const out: Any = await t.invoke({}, ctx({}));
    expect(out).toEqual(IMAGE_RESULT);
  });

  it('a text-only result is still unwrapped and JSON-parsed', async () => {
    const [t] = await resolveTools(['test_text_json_tool'], {});
    expect(await t.invoke({}, ctx({}))).toEqual({ ok: true, n: 2 });
  });
});

describe('MCP tools in the neuron loop', () => {
  const mcpState = (result: unknown): Any => ({
    mcpClient: {
      findTool: () => ({ server: 'redboard', tool: { name: 'redboard_attachment_view', description: 'View an attachment', inputSchema: { type: 'object', properties: {} } } }),
      callTool: async () => structuredClone(result),
    },
  });

  it('an image result is returned raw (image block kept)', async () => {
    const state = mcpState(IMAGE_RESULT);
    const [t] = await resolveTools(['mcp:redboard_attachment_view'], state);
    expect(await t.invoke({ attachmentId: 'a1' }, ctx(state))).toEqual(IMAGE_RESULT);
  });

  it('a text-only result is still unwrapped', async () => {
    const state = mcpState({ content: [{ type: 'text', text: 'plain words' }] });
    const [t] = await resolveTools(['mcp:redboard_attachment_view'], state);
    expect(await t.invoke({}, ctx(state))).toBe('plain words');
  });
});

describe('formatToolResultForModel on the raw result', () => {
  it('routes the image to vision and keeps the caption as text', () => {
    const { text, images } = formatToolResultForModel(IMAGE_RESULT);
    expect(images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(text).toBe('mind-light.png (image/png, 233885 bytes)');
    expect(text).not.toContain(PNG);
  });
});
