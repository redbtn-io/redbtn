/**
 * Regression: cross-tenant leak in globalState template resolution.
 *
 * `getGlobalStateClient(options)` used to stash every identity-bearing client
 * in a process-wide `defaultClient` singleton. The template renderer's
 * `{{globalState.ns.key}}` lookups (renderTemplateAsync /
 * prefetchGlobalStateForTemplate) and the getGlobalValue/setGlobalValue module
 * helpers fetch the client with NO options, so they reused whichever user's
 * client was constructed last. In a worker serving concurrent multi-tenant
 * runs, user A's globalState lookup then executed under user B's identity
 * (X-User-Id / Authorization) and B's cached values — a cross-tenant read.
 *
 * These tests pin the fix: a globalState lookup always carries the identity of
 * the run whose `state` is being rendered, regardless of what other runs
 * touched the singleton first, and identity-bearing clients are never handed
 * back to a subsequent no-options caller.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  renderTemplateAsync,
} from '../../src/lib/nodes/universal/templateRenderer';
import {
  getGlobalStateClient,
  GlobalStateClient,
} from '../../src/lib/globalState';

/**
 * Fetch mock that records the X-User-Id header of every request and answers
 * each namespace/key GET with a value tagged by the requesting user, so a
 * cross-tenant read is observable in BOTH the header and the returned value.
 */
function installFetchSpy(): { seenUserIds: string[]; restore: () => void } {
  const seenUserIds: string[] = [];
  const original = globalThis.fetch;
  const mock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit);
    const userId = headers.get('X-User-Id') ?? '<none>';
    seenUserIds.push(userId);
    const u = typeof input === 'string' ? input : (input as URL).toString();
    // GET /api/v1/state/namespaces/:ns/values/:key
    const m = new URL(u).pathname.match(
      /^\/api\/v1\/state\/namespaces\/([^/]+)\/values\/([^/]+)$/,
    );
    if (m) {
      return new Response(
        JSON.stringify({ key: decodeURIComponent(m[2]), value: `secret-of:${userId}` }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
  }) as typeof globalThis.fetch;
  globalThis.fetch = mock;
  return { seenUserIds, restore: () => { globalThis.fetch = original; } };
}

function stateForUser(userId: string) {
  return { userId, data: { userId, graphId: 'g-' + userId } };
}

describe('globalState tenant isolation', () => {
  let spy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    // WEBAPP_URL is read at client construction; pin it so the mock matches.
    process.env.WEBAPP_URL = 'https://webapp.test';
    spy = installFetchSpy();
  });

  afterEach(() => {
    spy.restore();
    vi.unstubAllEnvs();
  });

  it('resolves {{globalState.*}} under the rendering run\'s user, not a prior run\'s', async () => {
    // Simulate the transform-step path of a DIFFERENT user's run priming the
    // process-wide client first (this is what used to poison the singleton).
    getGlobalStateClient({ userId: 'user-B', workflowId: 'g-user-B' });

    // Now user A renders a template that reads global state.
    const rendered = await renderTemplateAsync(
      'key={{globalState.config.api_key}}',
      stateForUser('user-A'),
    );

    // The outbound request must carry user A's identity...
    expect(spy.seenUserIds).toContain('user-A');
    expect(spy.seenUserIds).not.toContain('user-B');
    // ...and the resolved value must be user A's, never user B's.
    expect(rendered).toBe('key=secret-of:user-A');
  });

  it('keeps two concurrent renders isolated even when interleaved', async () => {
    // Prime the singleton with yet another user to be adversarial.
    getGlobalStateClient({ userId: 'user-Z', workflowId: 'g-user-Z' });

    const [a, b] = await Promise.all([
      renderTemplateAsync('{{globalState.config.api_key}}', stateForUser('alice')),
      renderTemplateAsync('{{globalState.config.api_key}}', stateForUser('bob')),
    ]);

    expect(a).toBe('secret-of:alice');
    expect(b).toBe('secret-of:bob');
    expect(spy.seenUserIds).toContain('alice');
    expect(spy.seenUserIds).toContain('bob');
    expect(spy.seenUserIds).not.toContain('user-Z');
  });

  it('never hands an identity-bearing client to a later no-options caller', () => {
    // A caller with options must get a fresh, caller-owned client...
    const withIdentity = getGlobalStateClient({ userId: 'user-B' });
    // ...and the ambient (no-options) client must not inherit that identity.
    const ambient = getGlobalStateClient();
    expect(ambient).not.toBe(withIdentity);
    expect((ambient as any).userId).toBeUndefined();
    expect(ambient).toBeInstanceOf(GlobalStateClient);
  });
});
