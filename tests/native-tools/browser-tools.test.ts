/**
 * Browser native tools — unit tests.
 *
 * Asserts the tool catalog shape (all 21 browser_* tools, server:'browser',
 * object schemas, handlers), that every targeted tool accepts `browser` and
 * `environmentId`, and that handlers fail safe (browser_failed, isError)
 * without a userId — without touching Mongo/Redis.
 */

import { describe, test, expect } from 'vitest';

import { BROWSER_TOOLS } from '../../src/lib/tools/native/browser-tools';
import { BROWSER_TOOL_NAMES } from '../../src/lib/tools/native/browser-types';

function makeContext(): any {
  return { publisher: null, state: {}, runId: 'r1', nodeId: null, toolId: null, abortSignal: null };
}

describe('browser native tools', () => {
  test('BROWSER_TOOLS keys deep-equal BROWSER_TOOL_NAMES', () => {
    expect(Object.keys(BROWSER_TOOLS).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
  });

  test('every definition is well-formed', () => {
    for (const name of BROWSER_TOOL_NAMES) {
      const def = (BROWSER_TOOLS as any)[name];
      expect(def, name).toBeTruthy();
      expect(def.server, name).toBe('browser');
      expect(typeof def.description, name).toBe('string');
      expect(def.description.length, name).toBeGreaterThan(0);
      expect(def.inputSchema?.type, name).toBe('object');
      expect(typeof def.handler, name).toBe('function');
    }
  });

  test('every targeted tool accepts browser and environmentId props', () => {
    for (const name of BROWSER_TOOL_NAMES) {
      if (name === 'browser_list') continue;
      const def = (BROWSER_TOOLS as any)[name];
      const props = def.inputSchema?.properties ?? {};
      expect(props, name).toHaveProperty('browser');
      expect(props, name).toHaveProperty('environmentId');
    }
  });

  test('every array property declares items', () => {
    for (const name of BROWSER_TOOL_NAMES) {
      const def = (BROWSER_TOOLS as any)[name];
      const props = def.inputSchema?.properties ?? {};
      for (const [propName, prop] of Object.entries<any>(props)) {
        if ((prop as any)?.type === 'array') {
          expect((prop as any).items, `${name}.${propName}`).toBeTruthy();
        }
      }
    }
  });

  test('browser_snapshot handler fails safe without userId', async () => {
    const result: any = await BROWSER_TOOLS.browser_snapshot.handler({}, makeContext());
    expect(result.isError).toBe(true);
    const text = result.content?.map((c: any) => c.text ?? '').join('') ?? '';
    expect(text).toContain('browser_failed');
  });

  test('browser_tabs handler fails safe without userId', async () => {
    const result: any = await BROWSER_TOOLS.browser_tabs.handler({}, makeContext());
    expect(result.isError).toBe(true);
    const text = result.content?.map((c: any) => c.text ?? '').join('') ?? '';
    expect(text).toContain('browser_failed');
  });
});
