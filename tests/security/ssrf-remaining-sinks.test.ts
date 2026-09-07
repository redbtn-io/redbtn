/**
 * The four (five) URL-taking tools PR #378 did not cover.
 *
 * # What this reproduces
 *
 * Round 3 of the review of PR #378 signed off on the control it built for
 * `fetch_url` / `scrape_url` / `ssh_copy(sourceUrl)` / `web_search`, and then
 * pointed at four more tools of exactly the same class that were never guarded
 * (§8.1, "P0 follow-up"):
 *
 *   send_webhook       — `fetch(url, { redirect:'follow' })`, arbitrary method
 *                        and body, up to 100 KB of the response handed back
 *   download_file      — `fetch(url)`, up to 10 MB of anything, base64
 *   upload_attachment  — `fetch(sourceUrl)` on a model-chosen source
 *   invoke_function    — `url` is a REQUIRED model-supplied argument
 *
 * `send_webhook({ url: 'http://10.100.0.10:9000/...' })` from a prompt-injected
 * neuron was a one-call read/write proxy into the fleet, with no accomplice
 * graph needed. Sweeping the tree for the same shape turned up a fifth the
 * review had not listed:
 *
 *   transcribe_audio   — `fetch(audioUrl)`
 *
 * Each of the five now gets the same three properties `fetch_url` has, and each
 * is asserted here through the REAL tool, driven by the REAL `executeTool`, with
 * only `global.fetch` stubbed:
 *
 *   (a) a private/loopback destination is REFUSED before any byte goes out;
 *   (b) a request an UNTRUSTED caller aimed at an internal redbtn host carries
 *       none of `Authorization` / `X-User-Id` / `X-Internal-Key`;
 *   (c) a redirect INTO private space is refused — the hop is re-checked, which
 *       the previous `redirect:'follow'` / default-follow never was.
 *
 * These assertions are a security boundary. If any of the five goes back to a
 * raw `fetch`, its case here goes red before the escalation ships.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { executeTool } from '../../src/lib/nodes/universal/executors/toolExecutor';
import { getNativeRegistry } from '../../src/lib/tools/native-registry';
import sendWebhookTool from '../../src/lib/tools/native/send-webhook';
import downloadFileTool from '../../src/lib/tools/native/download-file';
import uploadAttachmentTool from '../../src/lib/tools/native/upload-attachment';
import invokeFunctionTool from '../../src/lib/tools/native/invoke-function';
import transcribeAudioTool from '../../src/lib/tools/native/transcribe-audio';

/** A fleet address. `10.0.0.0/8` is the whole WireGuard mesh. */
const PRIVATE_URL = 'http://10.100.0.10:9000/minio/admin';
/** An allowlisted internal redbtn host — public DNS, platform API behind it. */
const INTERNAL_URL = 'https://app.redbtn.io/api/v1/graphs';
/** A third party. Nothing here may change how this one is treated. */
const EXTERNAL_URL = 'https://hooks.example.com/inbound';

const AUTH_HEADERS = ['authorization', 'x-user-id', 'x-internal-key'];

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

let captured: Captured[];
let redirectOnce: string | null;

function lowerKeys(h: Record<string, string>): string[] {
  return Object.keys(h || {}).map((k) => k.toLowerCase());
}

/** State for a run owned by `user-1`, holding the model's chosen destination. */
function runState(target: string) {
  return {
    runId: 'run-ssrf-sinks',
    authToken: 'jwt-abc',
    userId: 'user-1',
    data: {
      userId: 'user-1',
      // A neuron wrote this. Every "untrusted" case below templates a
      // URL-bearing parameter off it, which is what `resolveToolStepTrust`
      // keys on.
      target,
      args: { url: target },
    },
  };
}

interface StepResult {
  /** False when the tool answered `isError` — `executeTool` turns that into a throw. */
  ok: boolean;
  /** The tool's parsed JSON result, when it succeeded. */
  payload: Record<string, unknown>;
  /** The error text the run would record, when it did not. */
  error: string;
}

/**
 * Run one tool step through the REAL `executeTool` and normalise the outcome.
 *
 * `executeTool` throws when a native tool answers `isError`, which is exactly
 * what a refusal is — so a refused destination arrives here as a throw, not a
 * value. The machine-readable `code` the model sees is asserted separately,
 * against the tool's own result, further down.
 */
async function runStep(step: Record<string, unknown>, state: unknown): Promise<StepResult> {
  try {
    const out = (await executeTool(step as never, state as never)) as Record<string, unknown>;
    const raw = out?.out as { content?: Array<{ text?: string }> } | string | undefined;
    const text =
      typeof raw === 'string'
        ? raw
        : raw?.content?.[0]?.text ?? JSON.stringify(raw ?? {});
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(text as string) as Record<string, unknown>;
    } catch {
      payload = { raw: text };
    }
    return { ok: true, payload, error: '' };
  } catch (err) {
    return { ok: false, payload: {}, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The refusal message the guard produces for a private destination. */
const REFUSED = /private\/loopback address|resolves to a private\/loopback address/;

beforeEach(() => {
  getNativeRegistry().register('send_webhook', sendWebhookTool as never);
  getNativeRegistry().register('download_file', downloadFileTool as never);
  getNativeRegistry().register('upload_attachment', uploadAttachmentTool as never);
  getNativeRegistry().register('invoke_function', invokeFunctionTool as never);
  getNativeRegistry().register('transcribe_audio', transcribeAudioTool as never);

  captured = [];
  redirectOnce = null;
  process.env.INTERNAL_SERVICE_KEY = 'svc-key';

  globalThis.fetch = vi.fn(async (url: unknown, init: Record<string, unknown> = {}) => {
    const target = String(url);
    captured.push({
      url: target,
      method: String(init.method || 'GET'),
      headers: { ...((init.headers as Record<string, string>) || {}) },
      body: init.body,
    });

    if (redirectOnce) {
      const location = redirectOnce;
      redirectOnce = null;
      return new Response('', { status: 302, headers: { location } });
    }

    // `invoke_function` needs a submit answer it can poll; everything else is
    // happy with a generic JSON 200.
    if (target.includes('/api/invoke/')) {
      return new Response(JSON.stringify({ executionId: 'exec-1', pollUrl: '/api/executions/exec-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (target.includes('/api/executions/')) {
      return new Response(JSON.stringify({ status: 'success', result: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
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
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The table. One row per sink; the shape of the step differs, the three
// properties do not.
// ---------------------------------------------------------------------------

interface SinkCase {
  name: string;
  /** Build a step whose destination is `target`, as a LITERAL (author-typed). */
  literal: (target: string) => Record<string, unknown>;
  /** Build a step whose destination is `target` via a TEMPLATE (model-chosen). */
  templated: () => Record<string, unknown>;
  /** Index into `captured` of the request that carries the caller's URL. */
  requestIndex: number;
  /**
   * The URL actually requested, given the caller's `target`. Identity for every
   * sink but `invoke_function`, which appends its own submit path to the base
   * URL the caller supplied.
   */
  expectedUrl?: (target: string) => string;
}

const SINKS: SinkCase[] = [
  {
    name: 'send_webhook',
    literal: (target) => ({
      toolName: 'send_webhook',
      parameters: { url: target, method: 'POST', body: { hello: 'world' } },
      outputField: 'out',
    }),
    templated: () => ({
      toolName: 'send_webhook',
      parameters: {
        url: '{{state.data.target}}',
        method: 'POST',
        body: { hello: 'world' },
        // The model asking for the platform's own credential headers.
        headers: { Authorization: 'Bearer attacker', 'X-Internal-Key': 'stolen', 'X-User-Id': 'victim' },
      },
      outputField: 'out',
    }),
    requestIndex: 0,
  },
  {
    name: 'download_file',
    literal: (target) => ({
      toolName: 'download_file',
      parameters: { url: target },
      outputField: 'out',
    }),
    templated: () => ({
      toolName: 'download_file',
      parameters: { url: '{{state.data.target}}' },
      outputField: 'out',
    }),
    requestIndex: 0,
  },
  {
    name: 'upload_attachment',
    literal: (target) => ({
      toolName: 'upload_attachment',
      parameters: { url: target, filename: 'x.png' },
      outputField: 'out',
    }),
    templated: () => ({
      toolName: 'upload_attachment',
      parameters: { url: '{{state.data.target}}', filename: 'x.png' },
      outputField: 'out',
    }),
    // request 0 is the caller's source download; request 1 (when it happens) is
    // the FIXED internal upload endpoint, which is deliberately unguarded.
    requestIndex: 0,
  },
  {
    name: 'invoke_function',
    literal: (target) => ({
      toolName: 'invoke_function',
      parameters: { url: target, functionName: 'do-thing', body: { a: 1 } },
      outputField: 'out',
    }),
    templated: () => ({
      toolName: 'invoke_function',
      parameters: { url: '{{state.data.target}}', functionName: 'do-thing', body: { a: 1 } },
      outputField: 'out',
    }),
    requestIndex: 0,
    expectedUrl: (target) => `${target.replace(/\/$/, '')}/api/invoke/do-thing?sync=false`,
  },
  {
    name: 'transcribe_audio',
    literal: (target) => ({
      toolName: 'transcribe_audio',
      parameters: { audioUrl: target, mimeType: 'audio/wav' },
      outputField: 'out',
    }),
    templated: () => ({
      toolName: 'transcribe_audio',
      parameters: { audioUrl: '{{state.data.target}}', mimeType: 'audio/wav' },
      outputField: 'out',
    }),
    requestIndex: 0,
  },
];

describe.each(SINKS)('$name — the SSRF control', (sink) => {
  test('(a) refuses a private/loopback destination, and sends nothing', async () => {
    const result = await runStep(sink.templated(), runState(PRIVATE_URL));

    // Nothing left the process. Not "it failed" — it never went out.
    expect(captured.map((c) => c.url)).not.toContain(PRIVATE_URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(REFUSED);
  });

  test('(a2) refuses it for a TRUSTED authored step too — credentials are not a licence to reach the fleet', async () => {
    const result = await runStep(sink.literal(PRIVATE_URL), runState(PRIVATE_URL));

    expect(captured.map((c) => c.url)).not.toContain(PRIVATE_URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(REFUSED);
  });

  test('(a3) the refusal the MODEL sees carries the machine code, not a transport error', async () => {
    // Through the tool's own result rather than `executeTool`, which flattens
    // it to a message. `BLOCKED_PRIVATE_ADDRESS` is how a graph tells "you may
    // not go there" from "the site was down".
    const result = (await getNativeRegistry().callTool(
      sink.name,
      { ...(sink.literal(PRIVATE_URL).parameters as Record<string, unknown>) },
      {
        publisher: null,
        state: runState(PRIVATE_URL),
        runId: 'run-ssrf-sinks',
        nodeId: null,
        toolId: null,
        abortSignal: null,
        untrustedCaller: true,
      } as never,
    )) as { isError?: boolean; content: Array<{ text: string }> };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('BLOCKED_PRIVATE_ADDRESS');
  });

  test('(b) an untrusted caller reaches an internal host with NO platform credentials', async () => {
    await runStep(sink.templated(), runState(INTERNAL_URL));

    // The request really did go out — otherwise this passes for the wrong reason.
    const request = captured[sink.requestIndex];
    expect(request).toBeDefined();
    expect(request.url).toBe((sink.expectedUrl ?? ((u: string) => u))(INTERNAL_URL));

    const keys = lowerKeys(request.headers);
    for (const header of AUTH_HEADERS) {
      expect(keys).not.toContain(header);
    }
  });

  test('(c) refuses a redirect into private space', async () => {
    redirectOnce = PRIVATE_URL;
    const result = await runStep(sink.templated(), runState(EXTERNAL_URL));

    // Hop 0 went out (it is public); hop 1 was refused before connecting.
    expect(captured[sink.requestIndex].url).toBe((sink.expectedUrl ?? ((u: string) => u))(EXTERNAL_URL));
    expect(captured.map((c) => c.url)).not.toContain(PRIVATE_URL);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(REFUSED);
  });
});

describe('send_webhook — header sanitisation, and its limits', () => {
  test('drops a model-supplied Authorization aimed at an internal host', async () => {
    await runStep(SINKS[0].templated(), runState(INTERNAL_URL));

    expect(captured[0].url).toBe(INTERNAL_URL);
    expect(lowerKeys(captured[0].headers)).not.toContain('authorization');
    // Non-credential headers are untouched — this is a targeted strip, not a
    // wipe of the caller's headers.
    expect(captured[0].headers['Content-Type']).toBe('application/json');
  });

  test('does NOT strip an untrusted caller\'s Authorization to a THIRD-PARTY host', async () => {
    // The control against over-blocking. A model calling a third-party API with
    // a token it was given is legitimate; only the platform\'s own hosts are
    // special, and only because the platform trusts those headers there.
    await runStep(SINKS[0].templated(), runState(EXTERNAL_URL));

    expect(captured[0].url).toBe(EXTERNAL_URL);
    expect(captured[0].headers['Authorization']).toBe('Bearer attacker');
  });

  test('a trusted authored step keeps the headers its author typed', async () => {
    await runStep(
      {
        toolName: 'send_webhook',
        parameters: {
          url: INTERNAL_URL,
          method: 'POST',
          body: { a: 1 },
          headers: { Authorization: 'Bearer authored' },
        },
        outputField: 'out',
      },
      runState(INTERNAL_URL),
    );

    expect(captured[0].headers['Authorization']).toBe('Bearer authored');
  });
});

describe('upload_attachment — the internal upload target stays reachable', () => {
  test('the fixed BASE_URL endpoint is NOT subject to the guard', async () => {
    // `BASE_URL` is routinely `http://localhost:3000` on a worker. Guarding the
    // deployment\'s own endpoint would break every install, and it is not a
    // caller-chosen destination — so it must still go out.
    const previous = process.env.BASE_URL;
    process.env.BASE_URL = 'http://localhost:3000';
    try {
      await runStep(SINKS[2].literal(EXTERNAL_URL), runState(EXTERNAL_URL));
      expect(captured[0].url).toBe(EXTERNAL_URL);
      expect(captured[1].url).toBe('http://localhost:3000/api/v1/attachments');
      expect(captured[1].headers['x-internal-key']).toBe('svc-key');
    } finally {
      if (previous === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previous;
    }
  });
});
