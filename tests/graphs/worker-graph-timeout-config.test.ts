import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateGraphConfig } from '../../src/lib/graphs/validateGraphConfig';
import type { GraphConfig } from '../../src/lib/types/graph';

describe('worker-style graph timeout config', () => {
  test('claude-agent seed keeps a generous run timeout and validates', async () => {
    const graphPath = resolve(__dirname, '../../data/graphs/claude-agent.json');
    const config = JSON.parse(readFileSync(graphPath, 'utf8')) as GraphConfig;

    expect(config.graphId).toBe('claude-agent');
    expect(config.config?.timeout).toBe(21_600);
    expect(config.config?.timeout).toBeGreaterThanOrEqual(6 * 60 * 60);

    const result = await validateGraphConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
