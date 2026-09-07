/**
 * Fence: native tool dispatch must go through `NativeToolRegistry.callTool`.
 *
 * `callTool` is where `enforceToolCapability` (fail-closed for
 * exec/computer/environment) and `runExecGuard` (exec kill switch,
 * `EXEC_RATE_MAX`, fail-closed audit) run, and it is where the
 * `NativeToolContext` — `untrustedCaller` included — is passed intact. A
 * `def.handler(args, ctx)` call somewhere else silently opts that call site out
 * of every one of those controls.
 *
 * Two call sites had done exactly that:
 *   - `toolExecutor.ts` — the stream-parser tool callback, with a literally
 *     empty context (`tool.handler(params, {})`), so a parser-dispatched
 *     `fetch_url` attached `X-Internal-Key` from `process.env` and a
 *     parser-dispatched `run_command` ran with no exec gate at all.
 *   - `neuronExecutor.ts` — the same callback on the neuron side. It set
 *     `untrustedCaller`, but still bypassed both gates.
 *
 * `neuronExecutor.executeNeuron` needs a live neuron registry and model to
 * drive, so its callback cannot be exercised the way `toolExecutor`'s is in
 * `tests/nodes/tool-executor-caller-trust.test.ts`. This source-level fence
 * covers it, and covers any NEW executor that reaches for the handler.
 *
 * Only two call sites are allowed to name `.handler(`:
 *   - `native-registry.ts`, which is the chokepoint;
 *   - `invoke-tool.ts`, whose gap is documented in its own module header and in
 *     the PR risk list (routing meta dispatch through `callTool` would deny
 *     exec fail-closed for every unprofiled agent that uses it, so it needs its
 *     own change and its own release window).
 * `tts-synthesize.ts` composes a sibling tool in-process rather than
 * dispatching a model-named tool, so it is listed explicitly too.
 */

import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '../../src');

/** Files permitted to call a tool definition's handler directly. */
const ALLOWED = new Set([
  'lib/tools/native-registry.ts',
  'lib/tools/native/invoke-tool.ts',
  'lib/tools/native/tts-synthesize.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip comments so a doc-comment mentioning `.handler(` is not a finding. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('native dispatch chokepoint', () => {
  test('no engine source calls a tool handler directly outside the allowed sites', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      code.split('\n').forEach((line, i) => {
        if (/\.handler\s*\(/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, 'route these through getNativeRegistry().callTool(...) instead').toEqual([]);
  });

  test('the parser tool callbacks route through callTool with untrustedCaller set', () => {
    // Belt to the fence above: assert the shape at both call sites, so a
    // refactor that reaches `callTool` but drops the flag is caught too.
    for (const rel of [
      'lib/nodes/universal/executors/toolExecutor.ts',
      'lib/nodes/universal/executors/neuronExecutor.ts',
    ]) {
      const code = readFileSync(path.join(SRC, rel), 'utf8');
      const callSite = code.match(/callTool\([^)]*?\{[\s\S]{0,600}?\}\s*\)/g) || [];
      const parserCall = callSite.find((s) => s.includes('untrustedCaller: true'));
      expect(parserCall, `${rel} must dispatch parser tool calls with untrustedCaller: true`).toBeTruthy();
      expect(parserCall).toMatch(/state/);
    }
  });

  test('the neuron tool-use loop still marks itself untrusted', () => {
    const code = readFileSync(path.join(SRC, 'lib/tools/tool-resolver.ts'), 'utf8');
    expect(code).toMatch(/untrustedCaller: true/);
    // ...and taints the sub-graph it starts, so trust does not leak across the
    // graph-as-tool boundary.
    expect(code).toMatch(/markStateModelDriven\(/);
  });
});
