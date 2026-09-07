/**
 * `SSRF_ALLOW_HOSTS` — the deploy-time escape hatch, and its edges.
 *
 * # Why it exists
 *
 * The guard blocks every private address for AUTHORED graph steps as well as
 * for model-chosen URLs. Round 3 of the review of PR #378 flagged that as a
 * silent, broad availability change (§10): anything in production fetching the
 * fleet API at `http://10.100.0.3:4000`, a redRun instance at
 * `http://192.168.1.5:3000`, an Ollama endpoint on a worker, or a `localhost`
 * `WEBAPP_URL` starts returning `BLOCKED_PRIVATE_ADDRESS`. The ship audit found
 * no live authored step that depends on one, so the guard is NOT weakened. This
 * is the narrow, explicit alternative for the day one turns up.
 *
 * # The properties that make it safe
 *
 * Each of these is a test below, because each of them is a way this could have
 * become a bypass of the thing it sits inside:
 *
 *   - default empty — an unset var changes nothing;
 *   - trusted callers only — a model-chosen URL can never reach an allowlisted
 *     private address, which is the property that matters most;
 *   - exact match — no wildcard, no suffix, no substring;
 *   - it does not relax the scheme check, and does not make an unresolvable
 *     host resolvable;
 *   - every use is logged.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  __setSsrfLookupForTests,
  assertPublicUrl,
  parseSsrfAllowList,
  SsrfBlockedError,
} from '../../src/lib/net/ssrf-guard';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import fetchUrlTool from '../../src/lib/tools/native/fetch-url';

const FLEET_API = 'http://10.100.0.3:4000/api/nodes';

/** Resolve every hostname to a fixed private address. */
function resolvesTo(address: string, family = 4): void {
  __setSsrfLookupForTests(async () => [{ address, family }]);
}

async function refusal(url: string, options?: { trusted?: boolean }): Promise<SsrfBlockedError | null> {
  try {
    await assertPublicUrl(url, options);
    return null;
  } catch (err) {
    if (err instanceof SsrfBlockedError) return err;
    throw err;
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  delete process.env.SSRF_ALLOW_HOSTS;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.SSRF_ALLOW_HOSTS;
  vi.restoreAllMocks();
});

describe('parsing', () => {
  test('unset or blank is an empty list', () => {
    expect(parseSsrfAllowList({}).any).toBe(false);
    expect(parseSsrfAllowList({ SSRF_ALLOW_HOSTS: '   ' }).any).toBe(false);
    expect(parseSsrfAllowList({ SSRF_ALLOW_HOSTS: ',,' }).any).toBe(false);
  });

  test('sorts entries into hostnames, IP literals and IPv4 CIDRs', () => {
    const list = parseSsrfAllowList({
      SSRF_ALLOW_HOSTS: ' fleet.internal , 10.100.0.3 ,192.168.1.0/24, ::1 ',
    });
    expect([...list.hosts]).toEqual(['fleet.internal']);
    expect(list.ips.has('v4:10.100.0.3')).toBe(true);
    expect(list.ips.has('v6:0:0:0:0:0:0:0:1')).toBe(true);
    expect(list.nets).toEqual([{ base: (192 << 24 | 168 << 16 | 1 << 8) >>> 0, bits: 24 }]);
  });

  test('a wildcard entry is REFUSED, not silently widened', () => {
    const list = parseSsrfAllowList({ SSRF_ALLOW_HOSTS: '*.internal,.redbtn.io,ok.example' });
    expect([...list.hosts]).toEqual(['ok.example']);
  });

  test('a malformed CIDR is dropped rather than crashing or widening', () => {
    const list = parseSsrfAllowList({ SSRF_ALLOW_HOSTS: '10.0.0.0/99,10.0.0.0/8' });
    expect(list.nets).toEqual([{ base: (10 << 24) >>> 0, bits: 8 }]);
  });
});

describe('the default is unchanged behaviour', () => {
  test('a private address is blocked for a TRUSTED caller with no allowlist', async () => {
    const err = await refusal(FLEET_API, { trusted: true });
    expect(err?.code).toBe('BLOCKED_PRIVATE_ADDRESS');
  });
});

describe('trusted callers only — the property that matters', () => {
  test('an allowlisted IP is reachable for a trusted caller', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    await expect(assertPublicUrl(FLEET_API, { trusted: true })).resolves.toEqual(['10.100.0.3']);
  });

  test('the SAME url is still blocked for an untrusted (model-chosen) caller', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    expect((await refusal(FLEET_API, { trusted: false }))?.code).toBe('BLOCKED_PRIVATE_ADDRESS');
    // And the default — a caller that passes nothing fails closed.
    expect((await refusal(FLEET_API))?.code).toBe('BLOCKED_PRIVATE_ADDRESS');
  });
});

describe('match forms', () => {
  test('a CIDR entry admits addresses inside it and nothing outside', async () => {
    process.env.SSRF_ALLOW_HOSTS = '192.168.1.0/24';
    await expect(assertPublicUrl('http://192.168.1.5:3000/x', { trusted: true })).resolves.toBeTruthy();
    expect((await refusal('http://192.168.2.5:3000/x', { trusted: true }))?.code).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
  });

  test('a hostname entry admits the host whatever it resolves to', async () => {
    process.env.SSRF_ALLOW_HOSTS = 'localhost';
    resolvesTo('127.0.0.1');
    await expect(assertPublicUrl('http://localhost:3000/api', { trusted: true })).resolves.toBeTruthy();
  });

  test('a hostname entry is EXACT — no suffix or substring match', async () => {
    process.env.SSRF_ALLOW_HOSTS = 'fleet.internal';
    resolvesTo('10.1.2.3');
    expect((await refusal('http://evil.fleet.internal/x', { trusted: true }))?.code).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
    expect((await refusal('http://fleet.internal.evil.com/x', { trusted: true }))?.code).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
    await expect(assertPublicUrl('http://fleet.internal/x', { trusted: true })).resolves.toBeTruthy();
  });

  test('an IP entry does not admit a hostname that resolves elsewhere in the same range', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    resolvesTo('10.100.0.9');
    expect((await refusal('http://other.internal/x', { trusted: true }))?.code).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
  });
});

describe('what the allowlist does NOT relax', () => {
  test('the scheme check still applies', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    expect((await refusal('file:///etc/passwd', { trusted: true }))?.code).toBe('BLOCKED_SCHEME');
  });

  test('an unresolvable allowlisted hostname still fails closed', async () => {
    process.env.SSRF_ALLOW_HOSTS = 'ghost.internal';
    __setSsrfLookupForTests(async () => {
      throw new Error('ENOTFOUND');
    });
    expect((await refusal('http://ghost.internal/x', { trusted: true }))?.code).toBe(
      'BLOCKED_UNRESOLVABLE',
    );
  });

  test('a public host that ALSO resolves private is still refused when only one answer is allowlisted', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    __setSsrfLookupForTests(async () => [
      { address: '203.0.113.10', family: 4 },
      { address: '10.100.0.9', family: 4 },
    ]);
    expect((await refusal('http://mixed.example.com/x', { trusted: true }))?.code).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
  });
});

describe('every use is logged', () => {
  test('an allowed private address is warned about, with the url, host and address', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    await assertPublicUrl(FLEET_API, { trusted: true });

    const line = warnSpy.mock.calls.map((c) => c.join(' ')).find((c) => c.includes('SSRF_ALLOW_HOSTS'));
    expect(line).toBeDefined();
    expect(line).toContain('10.100.0.3');
    expect(line).toContain(FLEET_API);
  });
});

describe('end to end through fetch_url', () => {
  let captured: string[];

  beforeEach(() => {
    getNativeRegistry().register('fetch_url', fetchUrlTool as never);
    captured = [];
    globalThis.fetch = vi.fn(async (url: unknown) => {
      captured.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof globalThis.fetch;
  });

  test('an AUTHORED step reaches an allowlisted private address', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    await executeTool(
      { toolName: 'fetch_url', parameters: { url: FLEET_API }, outputField: 'out' } as never,
      { runId: 'r', userId: 'u', data: { userId: 'u' } } as never,
    );
    expect(captured).toEqual([FLEET_API]);
  });

  test('a MODEL-CHOSEN url to the same address is refused', async () => {
    process.env.SSRF_ALLOW_HOSTS = '10.100.0.3';
    await expect(
      executeTool(
        {
          toolName: 'fetch_url',
          parameters: { url: '{{state.data.target}}' },
          outputField: 'out',
        } as never,
        { runId: 'r', userId: 'u', data: { userId: 'u', target: FLEET_API } } as never,
      ),
    ).rejects.toThrow(/private\/loopback address/);
    expect(captured).toEqual([]);
  });
});
