/**
 * State Records — registration + permission wiring.
 *
 * A native tool that exists but isn't registered is invisible; one that's
 * registered but missing from DATA_TOOL_RULES is invisible to the capability
 * JAIL, which is worse — an agent scoped to namespace X could touch records
 * anywhere. Both are silent failures, so they get a test.
 */

import { describe, test, expect } from 'vitest';
import { DATA_TOOL_RULES } from '../../src/lib/permissions/tool-map';
import { MCP_EXPOSED_TOOLS } from '../../src/lib/tools/native-registry';

const RECORD_TOOLS = [
  'create_state_record',
  'get_state_record',
  'query_state_records',
  'update_state_record',
  'delete_state_record',
] as const;

describe('State Records — capability jail', () => {
  test('every record tool is mapped in DATA_TOOL_RULES', () => {
    for (const name of RECORD_TOOLS) {
      expect(DATA_TOOL_RULES[name], `${name} is missing from DATA_TOOL_RULES`).toBeDefined();
      expect(DATA_TOOL_RULES[name].resource).toBe('state');
    }
  });

  test('each tool is mapped to the right action', () => {
    expect(DATA_TOOL_RULES.get_state_record.action).toBe('read');
    expect(DATA_TOOL_RULES.query_state_records.action).toBe('read');
    expect(DATA_TOOL_RULES.create_state_record.action).toBe('write');
    expect(DATA_TOOL_RULES.update_state_record.action).toBe('write');
    expect(DATA_TOOL_RULES.delete_state_record.action).toBe('delete');
  });

  test('records are addressed by NAMESPACE, so an existing namespace jail covers them', () => {
    // The whole point of reusing `stateNamespace`: a selector that already
    // confines an agent to namespace "alpha" confines its records too, with no
    // new grant syntax to learn (and no gap to forget).
    for (const name of RECORD_TOOLS) {
      const extracted = DATA_TOOL_RULES[name].extract({ namespace: 'alpha', recordId: 'rec_1' });
      expect(extracted.addresses).toEqual(['alpha']);
      expect(extracted.unscoped).toBeFalsy();
    }
  });

  test('a call with no namespace is UNSCOPED (needs a wildcard grant)', () => {
    for (const name of RECORD_TOOLS) {
      const extracted = DATA_TOOL_RULES[name].extract({});
      expect(extracted.addresses).toEqual([]);
      expect(extracted.unscoped).toBe(true);
    }
  });
});

describe('State Records — MCP exposure', () => {
  test('all five are exposed as remote MCP tools', () => {
    // They're thin proxies over webapp REST endpoints that do their own auth,
    // which is exactly the criterion MCP_EXPOSED_TOOLS documents.
    for (const name of RECORD_TOOLS) {
      expect(MCP_EXPOSED_TOOLS.has(name), `${name} is not MCP-exposed`).toBe(true);
    }
  });
});
