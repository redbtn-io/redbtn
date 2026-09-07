/**
 * A caller-supplied header must not pre-empt the platform's own.
 *
 * # What this closes
 *
 * Round 3 of the review of PR #378 broke the control this way (§3b). The attach
 * block in `fetch-url.ts` merged the caller's headers FIRST and then added each
 * platform header only `if (!hasHeader(key))` — so a caller-set header won, and
 * the other two auth headers still went out alongside it:
 *
 * ```json
 * { "toolName": "fetch_url",
 *   "parameters": { "url": "https://app.redbtn.io/api/v1/graphs",
 *                   "headers": { "X-User-Id": "{{state.data.answer}}" } } }
 * ```
 *
 * `resolveToolStepTrust` returns TRUSTED for that step, correctly: the URL is
 * the literal the author typed, and `X-User-Id` renders to a plain string that
 * is not a URL, so neither the name test nor the value test fires. The step is
 * trusted with the DESTINATION. It was never meant to be trusted with the
 * PRINCIPAL — and the measured outgoing headers were:
 *
 *     X-User-Id:      VICTIM-ADMIN-USER   <- model-chosen
 *     Authorization:  Bearer jwt-abc      <- the run's real token
 *     X-Internal-Key: svc-key             <- the platform service key
 *
 * On the webapp side `X-Internal-Key` + `X-User-Id` is the service-principal
 * path and resolves as ADMIN impersonating that user id. The model picked the
 * principal instead of the destination.
 *
 * # The rule now
 *
 * For an internal host, `Authorization` / `X-User-Id` / `X-Internal-Key` are
 * ALWAYS the run's, regardless of the caller's trust: any caller-supplied copy
 * is deleted first (and logged), then the run-context value is written. A
 * caller cannot set one and cannot suppress one. For an untrusted caller the
 * delete still runs and the write does not, so nothing goes out at all.
 *
 * Third-party hosts are untouched: a step calling a partner API with its own
 * bearer token keeps it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import { resolveToolStepTrust } from '../../src/lib/tools/caller-trust';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

const INTERNAL_URL = 'https://app.redbtn.io/api/v1/graphs';
const EXTERNAL_URL = 'https://partner.example.com/v1/things';

let captured: Array<{ url: string; headers: Record<string, string> }>;

function state(answer: unknown = 'VICTIM-ADMIN-USER') {
  return {
    runId: 'run-header-override',
    authToken: 'jwt-abc',
    userId: 'user-1',
    data: { userId: 'user-1', answer },
  };
}

function headerCaseInsensitive(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((h) => h.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}

beforeEach(() => {
  getNativeRegistry().register('fetch_url', fetchUrlTool as never);
  captured = [];
  process.env.INTERNAL_SERVICE_KEY = 'svc-key';
  globalThis.fetch = vi.fn(async (url: unknown, init: { headers?: Record<string, string> } = {}) => {
    captured.push({ url: String(url), headers: { ...(init.headers || {}) } });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof globalThis.fetch;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.INTERNAL_SERVICE_KEY;
  vi.restoreAllMocks();
});

describe('the attack step is still classified TRUSTED — the fix is not the classifier', () => {
  test('a templated X-User-Id on a literal internal URL does not make the step untrusted', () => {
    // Stated so nobody "fixes" this by widening the destination test and
    // believes the header case is covered by that. It is not: the destination
    // really is the author's, and the classifier is right to say so.
    const trust = resolveToolStepTrust({
      toolName: 'fetch_url',
      configParams: { url: INTERNAL_URL, headers: { 'X-User-Id': '{{state.data.answer}}' } },
      renderedParams: { url: INTERNAL_URL, headers: { 'X-User-Id': 'VICTIM-ADMIN-USER' } },
      state: state(),
    });
    expect(trust.untrustedCaller).toBe(false);
  });
});

describe('internal host: the run owns the identity headers', () => {
  test('a model-chosen X-User-Id is DROPPED and the run\'s own is sent', async () => {
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: { url: INTERNAL_URL, headers: { 'X-User-Id': '{{state.data.answer}}' } },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(INTERNAL_URL);
    expect(headerCaseInsensitive(captured[0].headers, 'X-User-Id')).toBe('user-1');
    // And no stray copy under a different casing.
    const userIdHeaders = Object.keys(captured[0].headers).filter(
      (h) => h.toLowerCase() === 'x-user-id',
    );
    expect(userIdHeaders).toHaveLength(1);
  });

  test('a differently-cased header cannot smuggle the value past the check', async () => {
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: { url: INTERNAL_URL, headers: { 'x-USER-id': '{{state.data.answer}}' } },
        outputField: 'out',
      } as never,
      state() as never,
    );

    const all = Object.entries(captured[0].headers).filter(([k]) => k.toLowerCase() === 'x-user-id');
    expect(all).toHaveLength(1);
    expect(all[0][1]).toBe('user-1');
  });

  test('a caller-supplied Authorization is replaced by the run\'s token', async () => {
    // Previously this let the model SUPPRESS the run's real bearer while
    // `X-Internal-Key` still went out — service-principal admin as the run
    // owner. The destination test never fired, because the value is not a URL.
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: { url: INTERNAL_URL, headers: { Authorization: 'Bearer attacker-chosen' } },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(headerCaseInsensitive(captured[0].headers, 'Authorization')).toBe('Bearer jwt-abc');
  });

  test('a caller-supplied X-Internal-Key is replaced by the platform\'s', async () => {
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: { url: INTERNAL_URL, headers: { 'X-Internal-Key': 'attacker-key' } },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(headerCaseInsensitive(captured[0].headers, 'X-Internal-Key')).toBe('svc-key');
  });

  test('all three at once — none of the model\'s values survives', async () => {
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: {
          url: INTERNAL_URL,
          headers: {
            'X-User-Id': '{{state.data.answer}}',
            Authorization: 'Bearer attacker-chosen',
            'X-Internal-Key': 'attacker-key',
          },
        },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(headerCaseInsensitive(captured[0].headers, 'X-User-Id')).toBe('user-1');
    expect(headerCaseInsensitive(captured[0].headers, 'Authorization')).toBe('Bearer jwt-abc');
    expect(headerCaseInsensitive(captured[0].headers, 'X-Internal-Key')).toBe('svc-key');
  });

  test('non-credential headers the author typed are untouched', async () => {
    // The strip is targeted at three header names, not at the caller's headers.
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: {
          url: INTERNAL_URL,
          headers: { 'X-Trace-Id': 'abc-123', 'X-User-Id': '{{state.data.answer}}' },
        },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(captured[0].headers['X-Trace-Id']).toBe('abc-123');
  });
});

describe('untrusted caller on an internal host: nothing at all', () => {
  test('the model\'s own credential headers are dropped and none are added', async () => {
    // A templated URL makes the step untrusted, so the attach block is skipped
    // — but the DELETE still runs, so a model-supplied `Authorization` never
    // reaches an internal redbtn API either.
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: {
          url: '{{state.data.answer}}',
          headers: { Authorization: 'Bearer attacker-chosen', 'X-User-Id': 'victim' },
        },
        outputField: 'out',
      } as never,
      state(INTERNAL_URL) as never,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(INTERNAL_URL);
    const keys = Object.keys(captured[0].headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
    expect(keys).not.toContain('x-internal-key');
  });
});

describe('third-party hosts are not touched', () => {
  test('an authored Authorization to an external host survives', async () => {
    // The control against over-blocking. `ops/red-ops/red-ops-triage.node.json`
    // and `data/graphs/claude-agent.json` both template `Authorization` on
    // non-allowlisted hosts; neither may regress.
    await executeTool(
      {
        toolName: 'fetch_url',
        parameters: { url: EXTERNAL_URL, headers: { Authorization: 'Bearer partner-token' } },
        outputField: 'out',
      } as never,
      state() as never,
    );

    expect(captured[0].url).toBe(EXTERNAL_URL);
    expect(headerCaseInsensitive(captured[0].headers, 'Authorization')).toBe('Bearer partner-token');
    // ...and the platform's own headers were never attached to a third party.
    const keys = Object.keys(captured[0].headers).map((k) => k.toLowerCase());
    expect(keys).not.toContain('x-internal-key');
    expect(keys).not.toContain('x-user-id');
  });
});
