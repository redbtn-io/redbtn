/**
 * Vitest for native tool: validate_graph_config
 *
 * Per PLATFORM-PACK-HANDOFF.md §2 Phase C — happy path + validation error +
 * edge cases. The tool wraps the engine-side `validateGraphConfig` helper —
 * this file exercises the wrapper's input handling, the structural-error
 * pass-through, and the toolCheck integration.
 *
 * NB: this tool does NOT make any HTTP calls — it runs the validator in-
 * process. So no fetch mocking required (vs get-graph-compile-log.test.ts).
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import validateGraphConfigTool from '../../src/lib/tools/native/validate-graph-config';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

const validCfg = {
  graphId: 'test-graph',
  userId: 'u',
  isDefault: false,
  name: 'Test',
  description: 'desc',
  tier: 4,
  nodes: [
    { id: 'a', config: { nodeId: 'context' } },
    { id: 'b', config: { nodeId: 'respond' } },
  ],
  edges: [
    { from: '__start__', to: 'a' },
    { from: 'a', to: 'b' },
    { from: 'b', to: '__end__' },
  ],
};

describe('validate_graph_config — schema', () => {
  test('exposes the documented inputs', () => {
    expect(validateGraphConfigTool.description.toLowerCase()).toMatch(/validat|graph/);
    expect(validateGraphConfigTool.inputSchema.required).toEqual(['config']);
    expect(validateGraphConfigTool.inputSchema.properties.config).toBeDefined();
    expect(validateGraphConfigTool.server).toBe('platform');
  });
});

describe('validate_graph_config — validation', () => {
  test('missing config → isError + VALIDATION code', async () => {
    const r = await validateGraphConfigTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/config/);
  });

  test('non-object config → isError + VALIDATION', async () => {
    const r = await validateGraphConfigTool.handler(
      { config: 'not-an-object' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('array config → isError + VALIDATION', async () => {
    const r = await validateGraphConfigTool.handler(
      { config: [] },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });
});

describe('validate_graph_config — happy path', () => {
  test('clean graph returns valid:true with empty errors', async () => {
    const r = await validateGraphConfigTool.handler(
      { config: validCfg },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.valid).toBe(true);
    expect(body.errors).toEqual([]);
  });

  test('result preserves errors[] / warnings[] structure', async () => {
    const r = await validateGraphConfigTool.handler(
      { config: validCfg },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(Array.isArray(body.errors)).toBe(true);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(typeof body.valid).toBe('boolean');
  });
});

describe('validate_graph_config — surfaces errors', () => {
  test('missing nodes → valid:false with NO_NODES error', async () => {
    const r = await validateGraphConfigTool.handler(
      {
        config: {
          graphId: 'broken',
          userId: 'u',
          isDefault: false,
          name: 'X',
          description: '',
          tier: 4,
          nodes: [],
          edges: [],
        },
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy(); // tool itself succeeds; result reports invalid
    const body = JSON.parse(r.content[0].text);
    expect(body.valid).toBe(false);
    expect(body.errors.some((e: any) => e.code === 'NO_NODES')).toBe(true);
  });

  test('every error has severity / code / message', async () => {
    const r = await validateGraphConfigTool.handler(
      {
        config: {
          graphId: 'broken',
          userId: 'u',
          isDefault: false,
          name: '',
          description: '',
          tier: 4,
          nodes: [{ id: 'a', config: { nodeId: 'x' } }],
          edges: [{ from: '__start__', to: 'phantom' }],
        },
      },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.valid).toBe(false);
    for (const issue of body.errors) {
      expect(issue.severity).toBe('error');
      expect(typeof issue.code).toBe('string');
      expect(typeof issue.message).toBe('string');
      expect(issue.message.length).toBeGreaterThan(0);
    }
    for (const issue of body.warnings) {
      expect(issue.severity).toBe('warning');
    }
  });

  test('toolCheck via the native registry: unknown tool flagged as warning, not error', async () => {
    const r = await validateGraphConfigTool.handler(
      {
        config: {
          graphId: 'g',
          userId: 'u',
          isDefault: false,
          name: 'g',
          description: 'd',
          tier: 4,
          nodes: [
            {
              id: 'x',
              config: {
                nodeId: 'inline',
                steps: [
                  {
                    type: 'tool',
                    config: { toolName: 'this_tool_does_not_exist', outputField: 'r' },
                  },
                ],
              },
            },
            { id: 'y', config: { nodeId: 'respond' } },
          ],
          edges: [
            { from: '__start__', to: 'x' },
            { from: 'x', to: 'y' },
            { from: 'y', to: '__end__' },
          ],
        },
      },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    // Unknown tool → warning, not error (MCP tools may register at runtime)
    expect(body.warnings.some((w: any) => w.code === 'TOOL_UNKNOWN')).toBe(true);
    expect(body.errors.some((e: any) => e.code === 'TOOL_UNKNOWN')).toBe(false);
  });
});
