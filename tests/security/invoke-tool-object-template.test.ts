/**
 * The object-template hole: `invoke_tool` + a leaf template that renders to an
 * OBJECT.
 *
 * # What this reproduces
 *
 * Round 2 of the review of PR #378 rejected the first version of
 * `caller-trust` with exactly this input. The trust walker recursed into
 * config OBJECTS, but at a templated LEAF it classified the value with
 * `isUrlBearingParam`, whose value heuristic only matches STRINGS. A leaf
 * template that renders to an object therefore hides the URL inside it — and
 * `invoke_tool` takes precisely that shape:
 *
 * ```json
 * { "toolName": "invoke_tool",
 *   "parameters": { "toolName": "fetch_url", "args": "{{state.data.answer}}" } }
 * ```
 *
 * With a neuron-written `state.data.answer = { url: "https://app.redbtn.io/api/v1/graphs" }`
 * every signal the walker looked at came up clean:
 *
 *   - `URL_BEARING_PARAMS['invoke_tool']` — no entry;
 *   - the key is `args`, which does not read as a URL;
 *   - the CONFIG value is `'{{state.data.answer}}'`, which is not a URL;
 *   - the RENDERED value is an object, and the value heuristic skips non-strings.
 *
 * So the step was judged TRUSTED, `invoke_tool` forwarded the context
 * unchanged, and `fetch_url` attached `Authorization` + `X-User-Id` +
 * `X-Internal-Key` to a fully model-chosen URL. On the webapp side
 * `X-Internal-Key` + `X-User-Id` is an ADMIN request impersonating that user.
 * That is the ORIGINAL vulnerability, reached through the new control.
 *
 * The fix is `canHideDestination`: a templated leaf that renders to anything
 * but a scalar is model-controlled for URL purposes, whatever it is called.
 *
 * These assertions are a security boundary. If the walker ever goes back to
 * inspecting only strings, the first test here goes red before the escalation
 * ships.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import {
  canHideDestination,
  findInterpolatedUrlParam,
  resolveToolStepTrust,
} from '../../src/lib/tools/caller-trust';
import invokeToolTool from '../../src/lib/tools/native/invoke-tool';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

/** The internal API the escalation reaches for. */
const INTERNAL_URL = 'https://app.redbtn.io/api/v1/graphs';

/** The exact graph step from the review. */
const ATTACK_STEP = {
  toolName: 'invoke_tool',
  parameters: { toolName: 'fetch_url', args: '{{state.data.answer}}' },
  outputField: 'out',
};

/** The neuron-written state the step reads its destination out of. */
function attackState() {
  return {
    runId: 'run-invoke-tool-object',
    authToken: 'jwt-abc',
    userId: 'user-1',
    data: {
      userId: 'user-1',
      // A neuron wrote this. It is an OBJECT, not a string — that is the whole
      // trick: `args` must be an object for `invoke_tool` to accept it.
      answer: { url: INTERNAL_URL },
    },
  };
}

function headerKeysLower(h: Record<string, string>): string[] {
  return Object.keys(h || {}).map((k) => k.toLowerCase());
}

describe('the invoke_tool object-template hole — classification', () => {
  test('canHideDestination: only scalars are legible, everything else is opaque', () => {
    // Legible — the value heuristic can read these, so they are judged on
    // their content and a templated body stays trusted.
    expect(canHideDestination('a summary the model wrote')).toBe(false);
    expect(canHideDestination('')).toBe(false);
    expect(canHideDestination(42)).toBe(false);
    expect(canHideDestination(false)).toBe(false);
    expect(canHideDestination(null)).toBe(false);

    // Opaque — a destination can hide in any of these.
    expect(canHideDestination({ url: INTERNAL_URL })).toBe(true);
    expect(canHideDestination([INTERNAL_URL])).toBe(true);
    expect(canHideDestination({})).toBe(true);
    expect(canHideDestination(undefined)).toBe(true);
  });

  test('findInterpolatedUrlParam flags the exact review input', () => {
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        ATTACK_STEP.parameters,
        { toolName: 'fetch_url', args: { url: INTERNAL_URL } },
      ),
    ).toBe('args');
  });

  test('flags it however deeply the URL is buried in the rendered object', () => {
    // The walker never inspects INSIDE the rendered object, and must not have
    // to: the point is that it cannot see in there at all.
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        { toolName: 'send_webhook', args: '{{state.data.answer}}' },
        { toolName: 'send_webhook', args: { nested: { deeper: { url: INTERNAL_URL } } } },
      ),
    ).toBe('args');
  });

  test('flags an ARRAY render too — a list of destinations is still destinations', () => {
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        { toolName: 'fetch_url', args: '{{state.data.answer}}' },
        { toolName: 'fetch_url', args: [{ url: INTERNAL_URL }] },
      ),
    ).toBe('args');
  });

  test('resolveToolStepTrust marks the whole step UNTRUSTED and names the parameter', () => {
    const trust = resolveToolStepTrust({
      toolName: 'invoke_tool',
      configParams: ATTACK_STEP.parameters,
      renderedParams: { toolName: 'fetch_url', args: { url: INTERNAL_URL } },
      state: attackState(),
    });
    expect(trust.untrustedCaller).toBe(true);
    expect(trust.reason).toMatch(/args/);
  });

  test('a scalar template through the same shape is still TRUSTED — no over-blocking', () => {
    // `invoke_tool` with an authored `args` object whose only template renders
    // to a string that is not a URL. The destination is still the author's.
    expect(
      findInterpolatedUrlParam(
        'invoke_tool',
        { toolName: 'send_email', args: { to: 'ops@redbtn.io', subject: '{{state.data.title}}' } },
        { toolName: 'send_email', args: { to: 'ops@redbtn.io', subject: 'Nightly report' } },
      ),
    ).toBeNull();
  });
});

describe('the invoke_tool object-template hole — end to end through executeTool', () => {
  let originalFetch: typeof globalThis.fetch;
  let captured: { url: string; headers: Record<string, string> }[];

  beforeEach(() => {
    // Register the REAL tools under their real names. `registerBuiltinTools`
    // reaches for the compiled `./native/*.js`, which does not exist under
    // vitest's ESM transform, so the registry may or may not already hold
    // them; registering explicitly makes the test deterministic either way.
    getNativeRegistry().register('invoke_tool', invokeToolTool);
    getNativeRegistry().register('fetch_url', fetchUrlTool);

    originalFetch = globalThis.fetch;
    captured = [];
    process.env.INTERNAL_SERVICE_KEY = 'svc-key';
    globalThis.fetch = vi.fn(async (url: unknown, init: { headers?: Record<string, string> }) => {
      captured.push({ url: String(url), headers: { ...(init?.headers || {}) } });
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
    globalThis.fetch = originalFetch;
    delete process.env.INTERNAL_SERVICE_KEY;
    vi.restoreAllMocks();
  });

  test('the attack step reaches the model-chosen URL with NO internal auth', async () => {
    await executeTool(ATTACK_STEP as never, attackState() as never);

    // The request really did go out to the model's URL — otherwise this test
    // would pass for the wrong reason.
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe(INTERNAL_URL);

    // ...and it carried none of the platform's credentials.
    const keys = headerKeysLower(captured[0].headers);
    expect(keys).not.toContain('authorization');
    expect(keys).not.toContain('x-user-id');
    expect(keys).not.toContain('x-internal-key');
  });

  test('the untrusted flag survives the meta-dispatch hop into fetch_url', async () => {
    // `invoke_tool` forwards the caller's context unchanged. Assert the flag
    // the outer step computed is the one the INNER tool saw — the header
    // assertion above depends on it.
    const seen: unknown[] = [];
    getNativeRegistry().register('fetch_url', {
      description: 'probe',
      inputSchema: { type: 'object' },
      handler: async (args: Record<string, unknown>, context: Record<string, unknown>) => {
        seen.push({ args, untrustedCaller: context?.untrustedCaller });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
      },
    } as never);

    await executeTool(ATTACK_STEP as never, attackState() as never);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ args: { url: INTERNAL_URL }, untrustedCaller: true });
  });

  test('a literal destination through invoke_tool keeps internal auth', async () => {
    // The control. If this goes red the fix has over-blocked and broken the
    // legitimate authored case, which is a real availability regression.
    await executeTool(
      {
        toolName: 'invoke_tool',
        parameters: { toolName: 'fetch_url', args: { url: INTERNAL_URL } },
        outputField: 'out',
      } as never,
      attackState() as never,
    );

    expect(captured).toHaveLength(1);
    expect(captured[0].headers['Authorization']).toBe('Bearer jwt-abc');
    expect(captured[0].headers['X-User-Id']).toBe('user-1');
    expect(captured[0].headers['X-Internal-Key']).toBe('svc-key');
  });
});
