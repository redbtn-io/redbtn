/**
 * Integration test for the native notifications pack.
 *
 * Per TOOL-HANDOFF.md §6.2 — "one integration test per pack that runs a small
 * graph using the new tools end-to-end."
 *
 * The two new tools in this pack form a coherent agent flow alongside the
 * existing `push_message`:
 *
 *    push_message (existing) — in-app conversation push (untouched here)
 *    send_email              — outbound SMTP via the configured Gmail relay
 *    send_webhook            — outbound HTTP to an arbitrary URL
 *
 * We mock the underlying transports (nodemailer for SMTP, globalThis.fetch
 * for HTTP) so the test never touches the network. Validates:
 *
 *   1. NativeToolRegistry singleton has both new tools registered.
 *   2. A simulated agent flow chains them end-to-end:
 *        send_email (notify a human via email) →
 *        send_webhook (notify a downstream system via HTTP)
 *      so a single agent run can fan out to multiple notification channels.
 *   3. The shared `system` server label is consistent.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

// ─── nodemailer mock — installed before send_email imports it ──────────────
let lastTransportConfig: Record<string, unknown> | null = null;
let lastSendMailCall: Record<string, unknown> | null = null;
let sendMailImpl: (opts: Record<string, unknown>) => Promise<unknown> = async () => ({
  messageId: '<mocked@integration>',
  accepted: ['x@y.com'],
  rejected: [],
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (cfg: Record<string, unknown>) => {
      lastTransportConfig = cfg;
      return {
        sendMail: async (opts: Record<string, unknown>) => {
          lastSendMailCall = opts;
          return sendMailImpl(opts);
        },
        close: vi.fn(),
      };
    },
  },
  createTransport: (cfg: Record<string, unknown>) => {
    lastTransportConfig = cfg;
    return {
      sendMail: async (opts: Record<string, unknown>) => {
        lastSendMailCall = opts;
        return sendMailImpl(opts);
      },
      close: vi.fn(),
    };
  },
}));

import {
  getNativeRegistry,
  type NativeToolContext,
} from '../../src/lib/tools/native-registry';
// Vitest under root vitest.config.ts can't resolve the .js side of the dual
// export pattern that native-registry.ts uses, so we explicitly re-register
// the .ts modules with the singleton (same workaround as tools-runs.test.ts).
import sendEmailTool from '../../src/lib/tools/native/send-email';
import sendWebhookTool from '../../src/lib/tools/native/send-webhook';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-int', authToken: 'tok-int' },
    runId: 'integration-' + Date.now(),
    nodeId: 'integration-node',
    toolId: 'integration-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function setEmailEnv() {
  process.env.EMAIL_HOST = 'smtp.test.example';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_USER = 'agent@redbtn.io';
  process.env.EMAIL_PASS = 'app-password';
  process.env.EMAIL_FROM = 'agent@redbtn.io';
}

describe('notifications pack integration — registration + chained execution', () => {
  beforeAll(() => {
    const registry = getNativeRegistry();
    if (!registry.has('send_email')) registry.register('send_email', sendEmailTool);
    if (!registry.has('send_webhook')) registry.register('send_webhook', sendWebhookTool);
  });

  test('NativeToolRegistry has both new notifications-pack tools registered', () => {
    const registry = getNativeRegistry();
    expect(registry.has('send_email')).toBe(true);
    expect(registry.has('send_webhook')).toBe(true);
    expect(registry.get('send_email')?.server).toBe('system');
    expect(registry.get('send_webhook')?.server).toBe('system');
  });

  test('the two new tools coexist in a single registry without name collision', () => {
    // Notifications pack is additive — guards against an accidental name
    // overlap between the email + webhook tools (e.g. both registering as
    // `send_notification`).
    const registry = getNativeRegistry();
    const email = registry.get('send_email');
    const webhook = registry.get('send_webhook');
    expect(email).toBeDefined();
    expect(webhook).toBeDefined();
    expect(email).not.toBe(webhook);
    // And the runtime registry knows about both as distinct entries.
    const tools = registry.listTools().map((t) => t.name);
    expect(tools).toContain('send_email');
    expect(tools).toContain('send_webhook');
  });

  describe('end-to-end agent fan-out flow: email a human + ping a webhook', () => {
    let originalFetch: typeof globalThis.fetch;
    const webhookCalls: Array<{ url: string; method: string; body: string }> = [];

    beforeEach(() => {
      originalFetch = globalThis.fetch;
      setEmailEnv();
      lastSendMailCall = null;
      lastTransportConfig = null;
      webhookCalls.length = 0;
      sendMailImpl = async () => ({
        messageId: '<integration-1@smtp.test>',
        accepted: ['ops@redbtn.io'],
        rejected: [],
      });
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.restoreAllMocks();
    });

    test('agent sends an email then triggers a downstream webhook in one run', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = typeof input === 'string' ? input : (input as URL).toString();
          webhookCalls.push({
            url,
            method: init?.method ?? 'GET',
            body: init?.body ? String(init.body) : '',
          });
          return new Response(
            JSON.stringify({ accepted: true, deliveryId: 'd_42' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      ) as unknown as typeof globalThis.fetch;

      // ── 1. send_email — markdown body to ops ──────────────────────────────
      const emailResult = await registry.callTool(
        'send_email',
        {
          to: 'ops@redbtn.io',
          subject: '[ALERT] Build failed on main',
          body:
            '# Build failed\n\n' +
            'The latest **main** build failed during the test stage.\n\n' +
            '- Branch: `main`\n' +
            '- Commit: `abc1234`\n' +
            '- Failed step: `npm test`\n',
        },
        ctx,
      );
      expect(emailResult.isError).toBeFalsy();
      const emailBody = JSON.parse(emailResult.content[0].text);
      expect(emailBody.ok).toBe(true);
      expect(emailBody.messageId).toBe('<integration-1@smtp.test>');
      expect(emailBody.from).toBe('agent@redbtn.io');
      expect(emailBody.to).toEqual(['ops@redbtn.io']);
      // Markdown rendered to HTML + plain-text by default.
      expect(typeof lastSendMailCall!.html).toBe('string');
      expect((lastSendMailCall!.html as string)).toContain('<h1>Build failed</h1>');
      expect((lastSendMailCall!.html as string)).toContain('<strong>main</strong>');
      // Transport built with the env values from setEmailEnv().
      expect(lastTransportConfig).toEqual({
        host: 'smtp.test.example',
        port: 587,
        secure: false, // STARTTLS
        auth: { user: 'agent@redbtn.io', pass: 'app-password' },
      });

      // ── 2. send_webhook — POST a JSON event to a downstream system ────────
      const webhookResult = await registry.callTool(
        'send_webhook',
        {
          url: 'https://hooks.internal.example/build-failures',
          body: {
            event: 'build.failed',
            branch: 'main',
            commit: 'abc1234',
            failedStep: 'npm test',
          },
        },
        ctx,
      );
      expect(webhookResult.isError).toBeFalsy();
      const webhookBody = JSON.parse(webhookResult.content[0].text);
      expect(webhookBody.status).toBe(200);
      expect(webhookBody.url).toBe('https://hooks.internal.example/build-failures');
      expect(webhookBody.method).toBe('POST');
      expect(webhookBody.response).toEqual({ accepted: true, deliveryId: 'd_42' });

      // Both notifications hit the wire as expected.
      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0].method).toBe('POST');
      expect(JSON.parse(webhookCalls[0].body)).toEqual({
        event: 'build.failed',
        branch: 'main',
        commit: 'abc1234',
        failedStep: 'npm test',
      });
    });

    test('email failure does NOT prevent the webhook from being sent (agents handle errors independently)', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      sendMailImpl = async () => {
        throw new Error('SMTP timeout');
      };

      globalThis.fetch = vi.fn(async () =>
        new Response('ok', { status: 200 }),
      ) as unknown as typeof globalThis.fetch;

      const emailResult = await registry.callTool(
        'send_email',
        { to: 'r@x.com', subject: 's', body: 'b' },
        ctx,
      );
      expect(emailResult.isError).toBe(true);
      expect(JSON.parse(emailResult.content[0].text).error).toMatch(/SMTP/);

      // The agent observes the email failure and decides to still ping the
      // webhook — both tools are independent.
      const webhookResult = await registry.callTool(
        'send_webhook',
        { url: 'https://h.example/x', body: { fallback: true } },
        ctx,
      );
      expect(webhookResult.isError).toBeFalsy();
      expect(JSON.parse(webhookResult.content[0].text).status).toBe(200);
    });

    test('webhook 4xx surfaces isError but still returns the response body for the agent to inspect', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();

      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ error: 'invalid signature' }), {
          status: 401,
          statusText: 'Unauthorized',
          headers: { 'content-type': 'application/json' },
        }),
      ) as unknown as typeof globalThis.fetch;

      const r = await registry.callTool(
        'send_webhook',
        { url: 'https://h.example/secure', body: { v: 1 } },
        ctx,
      );
      expect(r.isError).toBe(true);
      const body = JSON.parse(r.content[0].text);
      expect(body.status).toBe(401);
      expect(body.response).toEqual({ error: 'invalid signature' });
      expect(body.error).toMatch(/401/);
    });

    test('send_email validation error short-circuits before nodemailer is touched', async () => {
      const registry = getNativeRegistry();
      const ctx = makeMockContext();
      let sendMailInvoked = false;
      sendMailImpl = async () => {
        sendMailInvoked = true;
        return { messageId: 'x' };
      };

      const r = await registry.callTool(
        'send_email',
        { to: 'r@x.com', body: 'b' /* missing subject */ },
        ctx,
      );
      expect(r.isError).toBe(true);
      expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
      expect(sendMailInvoked).toBe(false);
    });
  });
});
