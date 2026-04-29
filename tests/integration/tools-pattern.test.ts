/**
 * Integration test for the native pattern pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a
 * small graph using the new tools end-to-end."
 *
 * The pattern pack is unique among the packs in that none of its tools talk
 * to a backing API — they're pure utilities. The integration scenario here
 * therefore exercises the canonical chain a graph would actually run:
 *
 *   1. extract_thinking   — strip the <think>…</think> tags off a raw LLM
 *                            response, producing the visible content.
 *   2. strip_formatting   — convert that markdown content to plain text.
 *   3. count_tokens       — measure the plain text for context-budget logic.
 *   4. regex_match (all)  — pull out every URL the assistant mentioned.
 *   5. json_query         — query the resulting structured payload.
 *
 * The chain validates:
 *   - All 5 tools are registered with the singleton.
 *   - Output of one tool is a valid input shape for the next one.
 *   - Failure in a single tool does not crash the chain (we test isError
 *     surfacing on a deliberate bad input).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
} from 'vitest';
import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';

// In production, native-registry.ts uses `require('./native/foo.js')` to load
// each tool from the dist directory. In a vitest run executing the TS sources
// directly, those .js paths don't exist next to the .ts module — the catch
// block silently swallows the failure. We work around it by importing the TS
// modules and explicitly re-registering them with the singleton, which is
// exactly what the dist-build path does at runtime.
import regexMatchTool from '../../src/lib/tools/native/regex-match';
import jsonQueryTool from '../../src/lib/tools/native/json-query';
import extractThinkingTool from '../../src/lib/tools/native/extract-thinking';
import stripFormattingTool from '../../src/lib/tools/native/strip-formatting';
import countTokensTool from '../../src/lib/tools/native/count-tokens';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('pattern pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('regex_match'))
      registry.register('regex_match', regexMatchTool);
    if (!registry.has('json_query'))
      registry.register('json_query', jsonQueryTool);
    if (!registry.has('extract_thinking'))
      registry.register('extract_thinking', extractThinkingTool);
    if (!registry.has('strip_formatting'))
      registry.register('strip_formatting', stripFormattingTool);
    if (!registry.has('count_tokens'))
      registry.register('count_tokens', countTokensTool);
  });

  test('NativeToolRegistry has all 5 pattern tools registered', () => {
    const registry = getNativeRegistry();
    for (const name of [
      'regex_match',
      'json_query',
      'extract_thinking',
      'strip_formatting',
      'count_tokens',
    ]) {
      expect(registry.has(name)).toBe(true);
    }

    const all = registry.listTools().map((t) => t.name);
    expect(all).toEqual(
      expect.arrayContaining([
        'regex_match',
        'json_query',
        'extract_thinking',
        'strip_formatting',
        'count_tokens',
      ]),
    );

    // All five share the 'pattern' server label
    for (const name of [
      'regex_match',
      'json_query',
      'extract_thinking',
      'strip_formatting',
      'count_tokens',
    ]) {
      expect(registry.get(name)?.server).toBe('pattern');
    }
  });

  test('end-to-end: extract_thinking → strip_formatting → count_tokens → regex_match → json_query', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Simulated raw LLM output: thinking + markdown + URLs.
    const rawLlmOutput =
      '<think>The user asked for the project pages. Let me list them.</think>' +
      '## Project pages\n\n' +
      'Here are the pages I found:\n\n' +
      '- [Docs](https://docs.example.com)\n' +
      '- [Blog](https://blog.example.com)\n' +
      '- [Status](https://status.example.com)\n\n' +
      'Also see `https://example.com/changelog` for the latest **changes**.';

    // 1. extract_thinking
    const extractResult = await registry.callTool(
      'extract_thinking',
      { text: rawLlmOutput },
      ctx,
    );
    expect(extractResult.isError).toBeFalsy();
    const extracted = JSON.parse(extractResult.content[0].text);
    expect(extracted.thinking).toMatch(/list them/i);
    expect(extracted.content).toContain('Project pages');
    expect(extracted.content).not.toContain('<think>');

    // 2. strip_formatting on the markdown content
    const stripResult = await registry.callTool(
      'strip_formatting',
      { text: extracted.content, format: 'markdown' },
      ctx,
    );
    expect(stripResult.isError).toBeFalsy();
    const stripped = JSON.parse(stripResult.content[0].text);
    expect(stripped.text).toContain('Project pages');
    expect(stripped.text).not.toContain('##');
    expect(stripped.text).not.toContain('**');
    expect(stripped.text).not.toContain('`');
    // Inline link [Docs](url) → "Docs"; URL no longer in the text body
    expect(stripped.text).toContain('Docs');

    // 3. count_tokens on the plain text
    const countResult = await registry.callTool(
      'count_tokens',
      { text: stripped.text },
      ctx,
    );
    expect(countResult.isError).toBeFalsy();
    const counted = JSON.parse(countResult.content[0].text);
    expect(counted.tokens).toBeGreaterThan(0);
    expect(counted.model).toBe('gpt-4');

    // 4. regex_match — extract every URL from the original (markdown) content
    const regexResult = await registry.callTool(
      'regex_match',
      {
        text: extracted.content,
        // Match any http(s) URL; capture the host as group 1
        pattern: 'https?://([^\\s)`]+)',
        mode: 'all',
      },
      ctx,
    );
    expect(regexResult.isError).toBeFalsy();
    const matched = JSON.parse(regexResult.content[0].text);
    expect(matched.matches.length).toBeGreaterThanOrEqual(4);
    const urls: string[] = matched.matches.map((m: any) => m.match);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://docs.example.com',
        'https://blog.example.com',
        'https://status.example.com',
        'https://example.com/changelog',
      ]),
    );
    // Captured groups should hold the host part
    const hosts: string[] = matched.matches.map((m: any) => m.groups[0]);
    expect(hosts).toEqual(
      expect.arrayContaining([
        'docs.example.com',
        'blog.example.com',
        'status.example.com',
      ]),
    );

    // 5. json_query — assemble the chain output into a structured payload, then
    // pull a specific value out via JSONPath.
    const payload = {
      summary: { tokens: counted.tokens, urlCount: matched.matches.length },
      thinking: extracted.thinking,
      urls: urls,
    };

    const jsonResult = await registry.callTool(
      'json_query',
      { data: payload, path: '$.urls[1]' },
      ctx,
    );
    expect(jsonResult.isError).toBeFalsy();
    const queried = JSON.parse(jsonResult.content[0].text);
    expect(queried.value).toBe(urls[1]);

    // And: a deeper path
    const jsonResult2 = await registry.callTool(
      'json_query',
      { data: payload, path: '$.summary.urlCount' },
      ctx,
    );
    expect(jsonResult2.isError).toBeFalsy();
    expect(JSON.parse(jsonResult2.content[0].text).value).toBe(
      matched.matches.length,
    );

    // And: a missing path returns null cleanly
    const jsonResult3 = await registry.callTool(
      'json_query',
      { data: payload, path: '$.nonexistent.field' },
      ctx,
    );
    expect(jsonResult3.isError).toBeFalsy();
    expect(JSON.parse(jsonResult3.content[0].text).value).toBeNull();
  });

  test('end-to-end: chain handles a tool-level error gracefully', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    // Feed regex_match a deliberately broken pattern and confirm the rest of
    // the chain can keep running with a fallback.
    const badRegex = await registry.callTool(
      'regex_match',
      { text: 'foo bar', pattern: '[unclosed' },
      ctx,
    );
    expect(badRegex.isError).toBe(true);
    const badBody = JSON.parse(badRegex.content[0].text);
    expect(badBody.code).toBe('VALIDATION');

    // And the next tool still works with normal inputs after the failure.
    const tokens = await registry.callTool(
      'count_tokens',
      { text: 'hello world' },
      ctx,
    );
    expect(tokens.isError).toBeFalsy();
    expect(JSON.parse(tokens.content[0].text).tokens).toBeGreaterThan(0);
  });

  test('end-to-end: unicode survives the full chain', async () => {
    const registry = getNativeRegistry();
    const ctx = makeMockContext();

    const text =
      '<think>考虑中…</think>**こんにちは** 🌍 see https://example.jp/コード';

    const stage1 = JSON.parse(
      (
        await registry.callTool('extract_thinking', { text }, ctx)
      ).content[0].text,
    );
    expect(stage1.thinking).toContain('考虑中');
    expect(stage1.content).toContain('🌍');

    const stage2 = JSON.parse(
      (
        await registry.callTool(
          'strip_formatting',
          { text: stage1.content, format: 'markdown' },
          ctx,
        )
      ).content[0].text,
    );
    expect(stage2.text).toContain('こんにちは');
    expect(stage2.text).not.toContain('**');

    const stage3 = JSON.parse(
      (
        await registry.callTool('count_tokens', { text: stage2.text }, ctx)
      ).content[0].text,
    );
    expect(stage3.tokens).toBeGreaterThan(0);

    const stage4 = JSON.parse(
      (
        await registry.callTool(
          'regex_match',
          { text: stage1.content, pattern: 'https?://\\S+', mode: 'all' },
          ctx,
        )
      ).content[0].text,
    );
    expect(stage4.matches.length).toBeGreaterThanOrEqual(1);
    expect(stage4.matches[0].match).toContain('example.jp');
  });
});
