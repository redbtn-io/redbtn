/**
 * Vitest for native tool: validate_graph_config (Phase A stub)
 *
 * Phase A ships this as a NOT_IMPLEMENTED stub. Phase C will replace the
 * implementation with a real engine-side dry-run validator.
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

describe('validate_graph_config — schema', () => {
  test('config required, server is platform', () => {
    expect(validateGraphConfigTool.server).toBe('platform');
    expect(validateGraphConfigTool.inputSchema.required).toEqual(['config']);
    expect(validateGraphConfigTool.inputSchema.properties.config).toBeDefined();
  });
});

describe('validate_graph_config — Phase A stub', () => {
  test('returns NOT_IMPLEMENTED isError', async () => {
    const r = await validateGraphConfigTool.handler({ config: { name: 'X' } }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('NOT_IMPLEMENTED');
    expect(parsed.error).toMatch(/Phase C/i);
  });

  test('returns NOT_IMPLEMENTED even with empty args', async () => {
    const r = await validateGraphConfigTool.handler({}, makeMockContext());
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('NOT_IMPLEMENTED');
  });
});
