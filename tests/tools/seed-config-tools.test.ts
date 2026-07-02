import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

function collectToolNames(value: unknown, out = new Set<string>()): Set<string> {
  if (!value || typeof value !== 'object') return out;

  if (Array.isArray(value)) {
    for (const item of value) collectToolNames(item, out);
    return out;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.toolName === 'string') {
    out.add(record.toolName);
  }
  for (const child of Object.values(record)) {
    collectToolNames(child, out);
  }
  return out;
}

function registeredNativeTools(): Set<string> {
  const registryPath = path.join(repoRoot, 'redbtn/src/lib/tools/native-registry.ts');
  const source = fs.readFileSync(registryPath, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/registry\.register\(\s*['"]([^'"]+)['"]/g)) {
    names.add(match[1]);
  }
  return names;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

describe('seed node configs', () => {
  test('only reference registered native tool names', () => {
    const registered = registeredNativeTools();
    const seedFiles = [
      path.join(repoRoot, 'data/nodes.json'),
      ...fs
        .readdirSync(path.join(repoRoot, 'data/nodes'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(repoRoot, 'data/nodes', name)),
    ];

    const unknown = new Map<string, string[]>();
    for (const file of seedFiles) {
      const toolNames = collectToolNames(readJson(file));
      const missing = [...toolNames].filter((name) => !registered.has(name));
      if (missing.length > 0) {
        unknown.set(path.relative(repoRoot, file), missing);
      }
    }

    expect(Object.fromEntries(unknown)).toEqual({});
  });
});
