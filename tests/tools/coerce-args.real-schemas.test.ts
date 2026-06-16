/**
 * Integration tests: run the coercer against REAL native-tool inputSchemas
 * (not synthetic ones) so we know it behaves correctly for the schemas actually
 * shipped in the catalog — both coercing typed structured params and, critically,
 * NEVER touching legitimate string params (e.g. a chat message `content` that
 * happens to look like JSON).
 */
import { describe, it, expect } from 'vitest';
import { coerceArgsToSchema } from '../../src/lib/tools/coerce-args';

import createGraphTool from '../../src/lib/tools/native/create-graph';
import createNodeTool from '../../src/lib/tools/native/create-node';
import updateAutomationTool from '../../src/lib/tools/native/update-automation';
import storeMessageTool from '../../src/lib/tools/native/store-message';
import nodePatchTool from '../../src/lib/tools/native/node-patch';
import setGlobalStateTool from '../../src/lib/tools/native/set-global-state';

describe('coerceArgsToSchema against real tool schemas', () => {
  it('create_graph: stringified `config` object → object; `graphId` string untouched', () => {
    const out = coerceArgsToSchema(
      { graphId: 'g1', config: '{"name":"G","nodes":[]}' },
      createGraphTool.inputSchema,
    );
    expect(out.graphId).toBe('g1');
    expect(out.config).toEqual({ name: 'G', nodes: [] });
  });

  it('create_node: stringified `config` object → object', () => {
    const out = coerceArgsToSchema(
      { nodeId: 'n1', config: '{"steps":[]}' },
      createNodeTool.inputSchema,
    );
    expect(out.config).toEqual({ steps: [] });
  });

  it('update_automation: stringified array + object params coerced, incl. NESTED triggers[].config', () => {
    const out = coerceArgsToSchema(
      {
        automationId: 'a1',
        name: 'Daily', // legit string — must stay
        tags: '["x","y"]',
        defaultInput: '{"k":1}',
        configOverrides: '{"a":true}',
        triggers: [
          { id: 't1', type: 'schedule', config: '{"cron":"0 9 * * *"}' },
        ],
      },
      updateAutomationTool.inputSchema,
    );
    expect(out.name).toBe('Daily');
    expect(out.tags).toEqual(['x', 'y']);
    expect(out.defaultInput).toEqual({ k: 1 });
    expect(out.configOverrides).toEqual({ a: true });
    // nested object inside an array item
    expect((out.triggers as any[])[0].config).toEqual({ cron: '0 9 * * *' });
    expect((out.triggers as any[])[0].type).toBe('schedule');
  });

  it('store_message: REGRESSION GUARD — JSON-looking `content` string stays a string', () => {
    const out = coerceArgsToSchema(
      {
        conversationId: 'c1',
        role: 'assistant',
        // A message whose text literally looks like JSON must NOT be parsed —
        // content is declared type:'string'.
        content: '{"this is":"a literal message, not an object"}',
        metadata: '{"model":"x"}', // object param → coerced
      },
      storeMessageTool.inputSchema,
    );
    expect(typeof out.content).toBe('string');
    expect(out.content).toBe('{"this is":"a literal message, not an object"}');
    expect(out.metadata).toEqual({ model: 'x' });
  });

  it('node_patch: stringified `ops` array → array; any-typed op `value` left for the server', () => {
    const out = coerceArgsToSchema(
      {
        nodeId: 'n1',
        // whole ops array stringified
        ops: '[{"op":"set","path":"/a","value":"{\\"x\\":1}"}]',
      },
      nodePatchTool.inputSchema,
    );
    expect(Array.isArray(out.ops)).toBe(true);
    const op0 = (out.ops as any[])[0];
    expect(op0.op).toBe('set');
    expect(op0.path).toBe('/a');
    // `value` is any-typed in node-patch's schema → NOT coerced here (the
    // server/target decides). Stays a string.
    expect(op0.value).toBe('{"x":1}');
  });

  it('set_global_state: any-typed `value` is NOT coerced at dispatch (strict server gate decides)', () => {
    const out = coerceArgsToSchema(
      { namespace: 'ns', key: 'k', value: '{"a":1}' },
      setGlobalStateTool.inputSchema,
    );
    // value param declares all JSON types incl. string → left as-is.
    expect(out.value).toBe('{"a":1}');
    expect(out.namespace).toBe('ns');
  });
});
