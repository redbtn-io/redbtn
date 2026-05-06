/**
 * @file Tool Resolver Tests
 * @description Verify resolveTools handles native, MCP-stub, and graph refs.
 *
 * The resolver itself is tested in isolation — we don't actually invoke any
 * tools. We just verify the resolved shape (name, description, source,
 * inputSchema, invoke fn presence).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  resolveTools,
  toBindToolsPayload,
} from '../../src/lib/tools/tool-resolver';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';

describe('resolveTools', () => {
  beforeAll(() => {
    // Register a fake native tool we can resolve against without depending on
    // any of the heavyweight built-ins.
    const reg = getNativeRegistry();
    if (!reg.has('test_echo_tool')) {
      reg.register('test_echo_tool', {
        description: 'Echo the input back as a string',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
        handler: async (args) => ({
          content: [{ type: 'text', text: String(args.value ?? '') }],
        }),
      });
    }
  });

  describe('native resolution', () => {
    it('resolves a bare string ref via native registry', async () => {
      const resolved = await resolveTools(['test_echo_tool'], {});
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('test_echo_tool');
      expect(resolved[0].source).toBe('native');
      expect(resolved[0].description).toContain('Echo');
      expect(resolved[0].inputSchema).toEqual({
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      });
      expect(typeof resolved[0].invoke).toBe('function');
    });

    it('honors object-form description override', async () => {
      const resolved = await resolveTools(
        [{ name: 'test_echo_tool', description: 'My custom description' }],
        {},
      );
      expect(resolved[0].description).toBe('My custom description');
    });

    it('throws when native tool is not registered', async () => {
      await expect(resolveTools(['definitely_not_a_real_tool'], {})).rejects.toThrow(
        /native tool 'definitely_not_a_real_tool' not found/,
      );
    });

    it('forces native source via object form', async () => {
      const resolved = await resolveTools(
        [{ name: 'test_echo_tool', source: 'native' }],
        {},
      );
      expect(resolved[0].source).toBe('native');
    });
  });

  describe('MCP resolution', () => {
    it('resolves a mcp: prefixed ref', async () => {
      // MCP resolution is lazy — we don't fail at resolve time when the
      // registry isn't in state, only when invoke is called.
      const resolved = await resolveTools(['mcp:my-server.lookup'], {});
      expect(resolved).toHaveLength(1);
      expect(resolved[0].source).toBe('mcp');
      // LLM-facing name uses double-underscore separator to avoid colliding
      // with the dot-separated server.tool form
      expect(resolved[0].name).toBe('my-server__lookup');
    });

    it('resolves a mcp ref without server prefix', async () => {
      const resolved = await resolveTools(['mcp:standalone_tool'], {});
      expect(resolved[0].name).toBe('standalone_tool');
      expect(resolved[0].source).toBe('mcp');
    });

    it('invoke throws when McpRegistry is missing from state', async () => {
      const resolved = await resolveTools(['mcp:my-server.lookup'], {});
      await expect(
        resolved[0].invoke({}, {
          state: {},
          runId: null,
          toolId: 'test',
          abortSignal: null,
        }),
      ).rejects.toThrow(/McpRegistry not available/);
    });
  });

  describe('graph resolution', () => {
    it('throws when GraphRegistry is missing from state', async () => {
      await expect(
        resolveTools(['graph:my-research'], {}),
      ).rejects.toThrow(/GraphRegistry not available/);
    });

    it('throws when graph is not published as tool', async () => {
      const fakeRegistry = {
        getConfig: async () => ({
          graphId: 'my-graph',
          // publishAsTool not set
        }),
      };
      await expect(
        resolveTools(['graph:my-graph'], { _graphRegistry: fakeRegistry, data: { userId: 'u1' } }),
      ).rejects.toThrow(/not published as a tool/);
    });

    it('resolves a published graph as a tool', async () => {
      const fakeRegistry = {
        getConfig: async () => ({
          graphId: 'my-research',
          publishAsTool: true,
          toolDescription: 'Research a topic in depth',
          inputSchema: {
            type: 'object',
            properties: { topic: { type: 'string' } },
            required: ['topic'],
          },
        }),
      };
      const resolved = await resolveTools(
        ['graph:my-research'],
        { _graphRegistry: fakeRegistry, data: { userId: 'u1' } },
      );
      expect(resolved).toHaveLength(1);
      expect(resolved[0].name).toBe('my-research');
      expect(resolved[0].source).toBe('graph');
      expect(resolved[0].description).toBe('Research a topic in depth');
      expect(resolved[0].inputSchema).toEqual({
        type: 'object',
        properties: { topic: { type: 'string' } },
        required: ['topic'],
      });
    });
  });

  describe('mixed resolution', () => {
    it('resolves a mix of native, mcp, and graph refs', async () => {
      const fakeRegistry = {
        getConfig: async () => ({
          graphId: 'my-research',
          publishAsTool: true,
          toolDescription: 'Do research',
          inputSchema: { type: 'object', properties: {} },
        }),
      };
      const resolved = await resolveTools(
        ['test_echo_tool', 'mcp:foo.bar', 'graph:my-research'],
        { _graphRegistry: fakeRegistry, data: { userId: 'u1' } },
      );
      expect(resolved.map((r) => r.source)).toEqual(['native', 'mcp', 'graph']);
    });
  });
});

describe('toBindToolsPayload', () => {
  it('converts ResolvedTool[] to LangChain bindTools shape', async () => {
    const resolved = await resolveTools(['test_echo_tool'], {});
    const payload = toBindToolsPayload(resolved);
    expect(payload).toEqual([
      {
        name: 'test_echo_tool',
        description: 'Echo the input back as a string',
        schema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ]);
  });
});
