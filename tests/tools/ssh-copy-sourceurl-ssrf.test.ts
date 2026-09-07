/**
 * ssh_copy — the `sourceUrl` mode is SSRF-guarded.
 *
 * `sourceUrl` is a model-supplied URL fetched by the worker, which sits on the
 * private fleet network. Before this guard, `fetch(sourceUrl, { redirect:
 * 'follow' })` would happily read `http://10.100.0.10:9000/...` (or a public
 * URL that 302s there) and copy the bytes onto a remote host — an exfiltration
 * path out of the private network.
 *
 * `ssh_copy` attaches no platform credentials on this path and must not start
 * doing so; these tests only assert the private-address refusal, which happens
 * during content resolution, before any SSH connection is attempted.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import sshCopyTool from '../../src/lib/tools/native/ssh-copy';
import { __setSsrfLookupForTests } from '../../src/lib/net/ssrf-guard';

function ctx(): any {
  return {
    publisher: null,
    state: {},
    runId: 'r-ssh-copy-ssrf',
    nodeId: 'n-ssh-copy-ssrf',
    toolId: 't-ssh-copy-ssrf',
    abortSignal: null,
  };
}

function payload(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('ssh_copy — sourceUrl SSRF guard', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => new Response('secret', { status: 200 })) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    __setSsrfLookupForTests(null);
    vi.restoreAllMocks();
  });

  test.each([
    ['http://10.100.0.10:9000/bucket/object'],
    ['http://127.0.0.1:3000/api/auth/me'],
    ['http://192.168.1.10/secret'],
    ['http://169.254.169.254/latest/meta-data/'],
  ])('refuses sourceUrl %s before opening any connection', async (sourceUrl) => {
    const result = await sshCopyTool.handler(
      {
        host: 'example.com',
        user: 'alpha',
        remotePath: '/tmp/out',
        sourceUrl,
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain('Content resolution failed');
    expect(payload(result).error).toContain('private/loopback');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('refuses a hostname that resolves into the fleet network', async () => {
    __setSsrfLookupForTests(async () => [{ address: '10.100.0.10', family: 4 }]);
    const result = await sshCopyTool.handler(
      {
        host: 'example.com',
        user: 'alpha',
        remotePath: '/tmp/out',
        sourceUrl: 'https://looks-public.example.com/file.txt',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain('private/loopback');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('refuses a public sourceUrl that redirects into the fleet network', async () => {
    __setSsrfLookupForTests(async (host) =>
      host === 'inside.example.com'
        ? [{ address: '10.100.0.10', family: 4 }]
        : [{ address: '203.0.113.10', family: 4 }],
    );
    const requested: string[] = [];
    globalThis.fetch = vi.fn(async (u: any) => {
      requested.push(String(u));
      return new Response(null, {
        status: 302,
        headers: { location: 'https://inside.example.com/secret' },
      });
    }) as any;

    const result = await sshCopyTool.handler(
      {
        host: 'example.com',
        user: 'alpha',
        remotePath: '/tmp/out',
        sourceUrl: 'https://public.example.com/redirector',
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain('private/loopback');
    expect(requested).toEqual(['https://public.example.com/redirector']);
  });
});
