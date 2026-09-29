/**
 * GlobalStateClient.increment — the atomic endpoint contract and the
 * fall-back signal for webapps that predate it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalStateClient } from '../../src/lib/globalState/client';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

function respond(status: number, body: string) {
  const spy = vi.fn(async () => new Response(body, { status }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('GlobalStateClient.increment', () => {
  it('posts op increment with writer attribution and returns the new value', async () => {
    const spy = respond(200, JSON.stringify({ value: 7, version: 3 }));
    const client = new GlobalStateClient({ baseUrl: 'http://w', userId: 'u', workflowId: 'g1' });
    const r = await client.increment('ns', 'ctr', 2, { initial: 0, onNonNumber: 'reset', ttlSeconds: 5 });
    expect(r).toEqual({ supported: true, ok: true, value: 7 });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://w/api/v1/state/namespaces/ns/values/ctr/atomic');
    expect(JSON.parse(init.body as string)).toEqual({
      op: 'increment',
      by: 2,
      initial: 0,
      onNonNumber: 'reset',
      ttlMs: 5000,
      modifiedBy: 'workflow:g1',
    });
    // The fresh value is cached for subsequent reads.
    expect(await client.getValue('ns', 'ctr')).toBe(7);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports an old webapp (bare 404) as unsupported', async () => {
    respond(404, '<html>Not Found</html>');
    expect(await new GlobalStateClient({ baseUrl: 'http://w' }).increment('ns', 'k', 1)).toEqual({ supported: false });
  });

  it('reports API errors as supported failures and never retries', async () => {
    const spy = respond(403, JSON.stringify({ error: 'Forbidden', code: 'forbidden' }));
    const r = await new GlobalStateClient({ baseUrl: 'http://w' }).increment('ns', 'k', 1);
    expect(r).toEqual({ supported: true, ok: false, error: 'Forbidden' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
