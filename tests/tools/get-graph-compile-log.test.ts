/**
 * Vitest for native tool: get_graph_compile_log (Phase A stub)
 *
 * Phase A ships this as a NOT_IMPLEMENTED stub. Phase C will replace the
 * implementation with a real proxy to GET /api/v1/graphs/:graphId/compile-log.
 */

import { describe, test, expect } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getGraphCompileLogTool from '../../src/lib/tools/native/get-graph-compile-log';

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

describe('get_graph_compile_log — schema', () => {
  test('graphId required, server is platform', () => {
    expect(getGraphCompileLogTool.server).toBe('platform');
    expect(getGraphCompileLogTool.inputSchema.required).toEqual(['graphId']);
  });
});

describe('get_graph_compile_log — Phase A stub', () => {
  test('returns NOT_IMPLEMENTED isError', async () => {
    const r = await getGraphCompileLogTool.handler({ graphId: 'g1' }, makeMockContext());
    expect(r.isError).toBe(true);
    const parsed = JSON.parse(r.content[0].text);
    expect(parsed.code).toBe('NOT_IMPLEMENTED');
    expect(parsed.error).toMatch(/Phase C/i);
  });
});
