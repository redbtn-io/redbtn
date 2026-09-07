/**
 * Security comments must not promise more than the code delivers.
 *
 * # Why this file exists
 *
 * Round 1 of the review of PR #378 raised a MUST FIX purely about prose: a
 * security comment that overstates the guarantee is worse than no comment,
 * because the next reader stops looking. Round 2 found two of them still
 * standing:
 *
 *   1. `native-registry.ts` (the `untrustedCaller` docblock) and
 *      `caller-trust.ts` (its module header) both asserted that ANY step
 *      inside a model-invoked sub-graph is untrusted OUTRIGHT. That was false
 *      while `invoke_graph` — a registered native tool a model calls with a
 *      model-chosen `graphId`, which starts a child run through `run()` — left
 *      the child unmarked.
 *   2. `tool-resolver.ts`, the very file that stamps the taint, still carried
 *      "Graph `tool` steps (toolExecutor) do NOT set this: there a graph author
 *      fixed the arguments." Both halves are wrong: `toolExecutor` DOES set it,
 *      conditionally, and the author does not fix the arguments —
 *      `renderParameters` does.
 *
 * A prose assertion cannot be tested directly, so this file tests the thing the
 * prose claims: that every boundary the comment enumerates is really stamped in
 * the code, and that the retracted sentence has not come back. Delete the
 * `invoke_graph` stamp and the enumeration becomes a lie again — and this file
 * goes red.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { MODEL_DRIVEN_STATE_KEY } from '../../src/lib/tools/caller-trust';

const SRC = resolve(__dirname, '../../src');

function read(relative: string): string {
  return readFileSync(resolve(SRC, relative), 'utf8');
}

describe('the taint enumeration in the untrustedCaller docblock is backed by code', () => {
  /**
   * The three boundaries the docblock names. Each entry is the file that must
   * carry the marker and the symbol that proves it does.
   */
  const BOUNDARIES: Array<{ file: string; mustContain: string[] }> = [
    // A neuron invoking a published graph as a tool.
    { file: 'lib/tools/tool-resolver.ts', mustContain: ['markStateModelDriven'] },
    // The invoke_graph native tool — the boundary round 2 found unmarked.
    {
      file: 'lib/tools/native/invoke-graph.ts',
      mustContain: ['MODEL_DRIVEN_STATE_KEY', 'isModelDrivenState', 'childIsModelDriven'],
    },
    // Each nested sub-graph hop, including the inputMapping branch.
    {
      file: 'lib/nodes/universal/executors/graphExecutor.ts',
      mustContain: ['MODEL_DRIVEN_STATE_KEY', 'isModelDrivenState'],
    },
  ];

  test.each(BOUNDARIES)('$file stamps or propagates the marker', ({ file, mustContain }) => {
    const source = read(file);
    for (const symbol of mustContain) {
      expect(source, `${file} must reference ${symbol}`).toContain(symbol);
    }
  });

  test('the docblock names invoke_graph as one of the boundaries', () => {
    const registry = read('lib/tools/native-registry.ts');
    // The claim is only true because invoke_graph stamps the marker, so the
    // comment has to say so — a reader auditing a new sub-run path needs the
    // list to be complete.
    expect(registry).toContain('invoke_graph');
    expect(registry).toMatch(/must stamp it too/i);
  });

  test('caller-trust names BOTH graph-as-tool boundaries in its module header', () => {
    const header = read('lib/tools/caller-trust.ts').split('@module')[0];
    expect(header).toContain('resolveGraph');
    expect(header).toContain('invoke_graph');
  });

  test('the marker key itself has not drifted', () => {
    // The stamp and the read are in different files; a rename that touched
    // only one of them would silently untaint every child run.
    expect(MODEL_DRIVEN_STATE_KEY).toBe('_modelDrivenArgs');
    expect(read('lib/tools/native/invoke-graph.ts')).not.toContain("'_modelDrivenArgs'");
  });
});

describe('the retracted claims are gone', () => {
  test('tool-resolver no longer says a graph author fixed the arguments', () => {
    const source = read('lib/tools/tool-resolver.ts');
    expect(source).not.toMatch(/a graph author fixed the arguments/i);
    // ...and says what is actually true in its place.
    expect(source).toContain('resolveToolStepTrust');
  });

  test('no file claims a graph tool step is trusted outright', () => {
    for (const file of [
      'lib/tools/tool-resolver.ts',
      'lib/tools/native-registry.ts',
      'lib/tools/caller-trust.ts',
      'lib/nodes/universal/executors/toolExecutor.ts',
    ]) {
      expect(read(file), file).not.toMatch(/graph tool steps are trusted(?!")/i);
    }
  });

  test('the object-template hole is documented where the walker lives', () => {
    // The next person to "simplify" `canHideDestination` needs the reason in
    // front of them, with the shape that broke it.
    const source = read('lib/tools/caller-trust.ts');
    expect(source).toContain('invoke_tool');
    expect(source).toContain('canHideDestination');
  });
});
