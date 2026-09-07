/**
 * caller-trust — deciding `untrustedCaller` for a graph `tool` step.
 *
 * # What this defends
 *
 * `NativeToolContext.untrustedCaller` gates whether `fetch_url` attaches the
 * run's `Authorization` / `X-User-Id` and the platform's `X-Internal-Key`. On
 * the webapp side `X-Internal-Key` + `X-User-Id` is an ADMIN request
 * impersonating that user, so anything that lets a model choose the URL of a
 * TRUSTED call is a privilege escalation.
 *
 * The first version of this patch trusted every graph `tool` step on the
 * grounds that "a graph author wrote the parameters". That was wrong twice
 * over, and both holes are covered here:
 *
 *   1. `toolExecutor` renders parameters with `renderParameters(config.
 *      parameters, state)`, so `{ url: '{{data.answer}}' }` is a model-chosen
 *      URL in a trusted context.
 *   2. `untrustedCaller` is a per-call flag and does not cross a graph-as-tool
 *      boundary, so a neuron could re-escalate through any published sub-graph
 *      that fetches a templated URL.
 *
 * A regression in either re-opens the escalation, so these are security tests.
 */

import { describe, test, expect } from 'vitest';
import {
  MODEL_DRIVEN_STATE_KEY,
  URL_BEARING_PARAMS,
  findInterpolatedUrlParam,
  isModelDrivenState,
  isTemplatedValue,
  isUrlBearingParam,
  markStateModelDriven,
  resolveToolStepTrust,
} from '../../src/lib/tools/caller-trust';

describe('caller-trust — isUrlBearingParam', () => {
  test('knows the named URL parameter of every URL-fetching tool', () => {
    expect(isUrlBearingParam('fetch_url', 'url')).toBe(true);
    expect(isUrlBearingParam('scrape_url', 'url')).toBe(true);
    expect(isUrlBearingParam('ssh_copy', 'sourceUrl')).toBe(true);
    expect(isUrlBearingParam('send_webhook', 'url')).toBe(true);
    // Every entry in the map must be recognised under its own tool name.
    for (const [tool, params] of Object.entries(URL_BEARING_PARAMS)) {
      for (const param of params) expect(isUrlBearingParam(tool, param)).toBe(true);
    }
  });

  test('recognises URL-shaped names on tools not in the map', () => {
    for (const name of ['url', 'URL', 'uri', 'href', 'endpoint', 'sourceUrl', 'source_url', 'callbackUrl', 'webhook_url']) {
      expect(isUrlBearingParam('some_future_tool', name), name).toBe(true);
    }
  });

  test('recognises a value that is an absolute http(s) URL whatever the key is called', () => {
    expect(isUrlBearingParam('send_email', 'target', 'https://app.redbtn.io/api/v1/graphs')).toBe(true);
    expect(isUrlBearingParam('send_email', 'target', '  http://example.com/x')).toBe(true);
  });

  test('leaves ordinary parameters alone', () => {
    expect(isUrlBearingParam('fetch_url', 'body', 'a summary of the thread')).toBe(false);
    expect(isUrlBearingParam('fetch_url', 'method', 'POST')).toBe(false);
    expect(isUrlBearingParam('send_email', 'subject', 'see https://example.com later')).toBe(false);
    expect(isUrlBearingParam('run_command', 'command', 'ls -la')).toBe(false);
  });
});

describe('caller-trust — isTemplatedValue', () => {
  test('any {{ ... }} form counts, nothing else does', () => {
    expect(isTemplatedValue('{{state.target}}')).toBe(true);
    expect(isTemplatedValue('https://app.redbtn.io/api/v1/users/{{state.userId}}')).toBe(true);
    expect(isTemplatedValue('{{ (state.a || state.b) }}')).toBe(true);
    expect(isTemplatedValue('https://app.redbtn.io/api/v1/graphs')).toBe(false);
    expect(isTemplatedValue(42)).toBe(false);
    expect(isTemplatedValue(null)).toBe(false);
  });
});

describe('caller-trust — findInterpolatedUrlParam', () => {
  test('flags the exact breaking input from the review', () => {
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: '{{data.answer}}' },
        { url: 'https://app.redbtn.io/api/v1/graphs' },
      ),
    ).toBe('url');
  });

  test('flags a partially interpolated URL — a fixed host is not enough', () => {
    // The host is the author's, but the path is the model's: still reaches an
    // internal API the author never named.
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: 'https://app.redbtn.io/api/v1/{{state.path}}' },
        { url: 'https://app.redbtn.io/api/v1/graphs/xyz/invoke' },
      ),
    ).toBe('url');
  });

  test('does NOT flag a literal URL', () => {
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: 'https://app.redbtn.io/api/v1/graphs' },
        { url: 'https://app.redbtn.io/api/v1/graphs' },
      ),
    ).toBeNull();
  });

  test('does NOT flag a templated BODY behind a literal URL — the common trusted case', () => {
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: 'https://app.redbtn.io/api/v1/state', method: 'POST', body: '{{state.summary}}' },
        { url: 'https://app.redbtn.io/api/v1/state', method: 'POST', body: 'the summary' },
      ),
    ).toBeNull();
  });

  test('does NOT flag a MIXED template that failed to resolve — nothing from state reached the URL', () => {
    // `renderTemplate` hands an unresolved `{{...}}` back unchanged inside a
    // mixed string, so rendered === configured and the URL is still the
    // author's literal text.
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: 'https://app.redbtn.io/api/v1/{{state.missing}}' },
        { url: 'https://app.redbtn.io/api/v1/{{state.missing}}' },
      ),
    ).toBeNull();
  });

  test('DOES flag a PURE template that failed to resolve — it renders to undefined', () => {
    // `resolveValue` falls through to `new Function('state', 'return (state.missing)')`
    // for a pure `{{state.x}}` and yields `undefined`, which is not
    // distinguishable from a resolved value here. Reporting it as interpolated
    // is the safe direction, and the request has no URL to send anyway.
    expect(
      findInterpolatedUrlParam('fetch_url', { url: '{{state.missing}}' }, { url: undefined }),
    ).toBe('url');
  });

  test('flags a URL that only looks like one after rendering', () => {
    expect(
      findInterpolatedUrlParam(
        'some_future_tool',
        { target: '{{state.x}}' },
        { target: 'https://app.redbtn.io/api/v1/graphs' },
      ),
    ).toBe('target');
  });

  test('walks nested parameter objects', () => {
    expect(
      findInterpolatedUrlParam(
        'ssh_copy',
        { options: { sourceUrl: '{{state.x}}' } },
        { options: { sourceUrl: 'https://app.redbtn.io/api/v1/graphs' } },
      ),
    ).toBe('options.sourceUrl');
  });

  test('walks nested parameter ARRAYS, keeping the container name', () => {
    // `isUrlBearingParam` would see the key '0', which reads as nothing, so an
    // array element inherits its container's name for the name test. The
    // reported path keeps the index.
    expect(
      findInterpolatedUrlParam(
        'ssh_copy',
        { sourceUrl: ['{{state.x}}'] },
        { sourceUrl: ['https://app.redbtn.io/api/v1/graphs'] },
      ),
    ).toBe('sourceUrl.0');
  });

  test('flags a templated leaf that rendered to an OBJECT — the round-2 blocker', () => {
    // The walker recursed into config objects but classified a templated LEAF
    // with a heuristic that only reads strings, so an object render hid the
    // URL. `invoke_tool` takes exactly this shape. Full end-to-end repro in
    // tests/security/invoke-tool-object-template.test.ts.
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        { toolName: 'fetch_url', args: '{{state.data.answer}}' },
        { toolName: 'fetch_url', args: { url: 'https://app.redbtn.io/api/v1/graphs' } },
      ),
    ).toBe('args');
  });

  test('flags an object render even when it holds no URL at all', () => {
    // Deny-by-default: the walker does not look inside, so it cannot rule the
    // value out. An opaque render is a possible destination.
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        { toolName: 'send_email', args: '{{state.data.answer}}' },
        { toolName: 'send_email', args: { subject: 'hello' } },
      ),
    ).toBe('args');
  });

  test('a templated leaf that rendered to a SCALAR is judged on its content', () => {
    // The trusted case has to survive: numbers, booleans and non-URL strings
    // are legible, so they are not destinations.
    expect(
      findInterpolatedUrlParam(
        'fetch_url',
        { url: 'https://app.redbtn.io/api/v1/state', timeout: '{{state.timeout}}', retries: '{{state.retries}}' },
        { url: 'https://app.redbtn.io/api/v1/state', timeout: 5000, retries: false },
      ),
    ).toBeNull();
  });

  test('tolerates missing/odd inputs instead of throwing', () => {
    expect(findInterpolatedUrlParam('fetch_url', null, null)).toBeNull();
    expect(findInterpolatedUrlParam('fetch_url', undefined, {})).toBeNull();
    expect(findInterpolatedUrlParam('fetch_url', { url: 42 }, { url: 42 })).toBeNull();
    expect(findInterpolatedUrlParam('fetch_url', {}, undefined)).toBeNull();
    // A rendered shape that does not match the config shape must not be read
    // positionally — it just means nothing rendered under that key.
    expect(findInterpolatedUrlParam('fetch_url', { url: 'literal' }, [])).toBeNull();
  });
});

describe('caller-trust — the graph-as-tool taint marker', () => {
  test('markStateModelDriven marks, does not mutate, and survives a data spread', () => {
    const original: Record<string, unknown> = { runId: 'r1', data: { userId: 'u1' } };
    const marked = markStateModelDriven(original);

    expect(isModelDrivenState(original)).toBe(false);
    expect(isModelDrivenState(marked)).toBe(true);
    expect((marked as any).data.userId).toBe('u1');
    // Marked at BOTH levels: sub-graph executors rebuild the top-level state
    // object but copy `data` forward, so the `data` copy is the one that
    // survives to a nested tool step.
    expect((marked as any)[MODEL_DRIVEN_STATE_KEY]).toBe(true);
    expect((marked as any).data[MODEL_DRIVEN_STATE_KEY]).toBe(true);
    expect(isModelDrivenState({ data: (marked as any).data })).toBe(true);
  });

  test('isModelDrivenState is false for ordinary and malformed states', () => {
    expect(isModelDrivenState(undefined)).toBe(false);
    expect(isModelDrivenState(null)).toBe(false);
    expect(isModelDrivenState('nope')).toBe(false);
    expect(isModelDrivenState({ runId: 'r1' })).toBe(false);
    // Truthy-but-not-true must not count as marked.
    expect(isModelDrivenState({ [MODEL_DRIVEN_STATE_KEY]: 'yes' })).toBe(false);
  });
});

describe('caller-trust — resolveToolStepTrust', () => {
  const literal = {
    toolName: 'fetch_url',
    configParams: { url: 'https://app.redbtn.io/api/v1/graphs' },
    renderedParams: { url: 'https://app.redbtn.io/api/v1/graphs' },
  };

  test('a literal destination in an ordinary run stays trusted', () => {
    const trust = resolveToolStepTrust({ ...literal, state: { runId: 'r1' } });
    expect(trust.untrustedCaller).toBe(false);
    expect(trust.reason).toBeNull();
  });

  test('an interpolated destination is untrusted and says why', () => {
    const trust = resolveToolStepTrust({
      toolName: 'fetch_url',
      configParams: { url: '{{data.answer}}' },
      renderedParams: { url: 'https://app.redbtn.io/api/v1/graphs' },
      state: { runId: 'r1' },
    });
    expect(trust.untrustedCaller).toBe(true);
    expect(trust.reason).toMatch(/url/);
  });

  test('a LITERAL destination inside a model-invoked sub-graph is untrusted', () => {
    // This is the graph-as-tool re-escalation: the sub-graph author typed the
    // URL, but a neuron chose to run this sub-graph, and its args steered the
    // run. Trust does not survive the boundary.
    const trust = resolveToolStepTrust({
      ...literal,
      state: markStateModelDriven({ runId: 'r1', data: {} }),
    });
    expect(trust.untrustedCaller).toBe(true);
    expect(trust.reason).toMatch(/graph-as-tool/);
  });
});
