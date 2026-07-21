import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import { sanitizeToolInputForTelemetry } from '../../src/lib/tools/tool-telemetry';

let lastTransportConfig: Record<string, unknown> | null = null;
let lastSendMailCall: Record<string, unknown> | null = null;
let sendMailImpl: (opts: Record<string, unknown>) => Promise<unknown> = async () => ({
  messageId: '<mocked@smtp.test>', accepted: ['george@redbtn.io'], rejected: [],
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (config: Record<string, unknown>) => {
      lastTransportConfig = config;
      return {
        sendMail: async (options: Record<string, unknown>) => {
          lastSendMailCall = options;
          return sendMailImpl(options);
        },
        close: vi.fn(),
      };
    },
  },
  createTransport: () => { throw new Error('unexpected named import'); },
}));

import sendEmailTool, {
  AGENT_EMAIL_SENDER,
  GEORGE_EMAIL_RECIPIENT,
} from '../../src/lib/tools/native/send-email';

const AUDIT_ID = '1d7755a9-6448-4d21-985d-5ed38bc9b4d5';

function context(): NativeToolContext {
  return { publisher: null, state: {}, runId: 'run-1', nodeId: 'node-1', toolId: 'tool-1', abortSignal: null };
}

function env() {
  process.env.EMAIL_HOST = 'smtp.test';
  process.env.EMAIL_PORT = '587';
  process.env.EMAIL_USER = AGENT_EMAIL_SENDER;
  process.env.EMAIL_PASS = 'never-return-this';
  process.env.REDRUN_API_URL = 'https://run.test/';
  process.env.REDRUN_AGENT_EMAIL_AUDIT_KEY = 'never-return-this-either';
}

function auditFetch(options?: { createOk?: boolean; patchOk?: boolean }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body));
    // The audit sink receives delivery metadata only.
    expect(JSON.stringify(body)).not.toContain('private body');
    expect(JSON.stringify(body)).not.toContain('private subject');
    expect(JSON.stringify(body)).not.toContain('never-return');
    if (url.endsWith('/api/agent-email/audits')) {
      expect(init?.headers).toEqual({ 'content-type': 'application/json', 'x-internal-key': 'never-return-this-either' });
      return new Response(JSON.stringify({ auditId: AUDIT_ID, status: 'attempted' }), { status: options?.createOk === false ? 503 : 201 });
    }
    expect(body).not.toHaveProperty('subject');
    expect(body).not.toHaveProperty('body');
    return new Response(JSON.stringify({ auditId: AUDIT_ID, status: body.status }), { status: options?.patchOk === false ? 503 : 200 });
  });
}

function parsed(result: Awaited<ReturnType<typeof sendEmailTool.handler>>) {
  return JSON.parse(result.content[0].text);
}

describe('send_email George-only delivery', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    env();
    lastTransportConfig = null;
    lastSendMailCall = null;
    sendMailImpl = async () => ({ messageId: '<mocked@smtp.test>', accepted: [GEORGE_EMAIL_RECIPIENT], rejected: [] });
    globalThis.fetch = auditFetch() as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    delete process.env.REDRUN_API_URL;
    delete process.env.REDRUN_AGENT_EMAIL_AUDIT_KEY;
  });

  test('uses fixed sender/recipient, creates an attempt, and returns only delivery metadata', async () => {
    const result = await sendEmailTool.handler({
      to: GEORGE_EMAIL_RECIPIENT, subject: 'private subject', body: 'private body',
    }, context());

    expect(result.isError).toBeFalsy();
    expect(parsed(result)).toEqual({ ok: true, status: 'accepted', auditId: AUDIT_ID, messageId: '<mocked@smtp.test>' });
    expect(lastSendMailCall).toMatchObject({ from: AGENT_EMAIL_SENDER, to: GEORGE_EMAIL_RECIPIENT, subject: 'private subject' });
    expect(lastTransportConfig).toEqual({
      host: 'smtp.test', port: 587, secure: false,
      auth: { user: AGENT_EMAIL_SENDER, pass: 'never-return-this' },
    });
    expect(result.content[0].text).not.toContain('private body');
    expect(result.content[0].text).not.toContain('private subject');
    expect(result.content[0].text).not.toContain('never-return');
  });

  test.each([
    { to: 'other@redbtn.io' },
    { to: [GEORGE_EMAIL_RECIPIENT] },
    { to: GEORGE_EMAIL_RECIPIENT, from: 'other@redbtn.io' },
    { to: GEORGE_EMAIL_RECIPIENT, cc: 'other@redbtn.io' },
    { to: GEORGE_EMAIL_RECIPIENT, bcc: 'other@redbtn.io' },
    { to: GEORGE_EMAIL_RECIPIENT, replyTo: 'other@redbtn.io' },
    { to: GEORGE_EMAIL_RECIPIENT, attachments: [] },
  ])('rejects recipient-boundary bypass %# before audit or SMTP', async (override) => {
    const result = await sendEmailTool.handler({ subject: 's', body: 'b', ...override }, context());
    expect(result.isError).toBe(true);
    expect(parsed(result).code).toBe('RECIPIENT_RESTRICTED');
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(lastSendMailCall).toBeNull();
  });

  test('does not send when the pre-delivery audit attempt fails', async () => {
    globalThis.fetch = auditFetch({ createOk: false }) as unknown as typeof globalThis.fetch;
    const result = await sendEmailTool.handler({ to: GEORGE_EMAIL_RECIPIENT, subject: 's', body: 'b' }, context());
    expect(parsed(result)).toEqual({ ok: false, status: 'failed', code: 'AUDIT_UNAVAILABLE' });
    expect(lastSendMailCall).toBeNull();
  });

  test('records a sanitized failed terminal outcome for SMTP failure', async () => {
    sendMailImpl = async () => { throw new Error('550 SMTP secret diagnostic'); };
    const result = await sendEmailTool.handler({ to: GEORGE_EMAIL_RECIPIENT, subject: 's', body: 'b' }, context());
    expect(parsed(result)).toEqual({ ok: false, status: 'failed', auditId: AUDIT_ID, code: 'SMTP_DELIVERY_FAILED' });
    expect(result.content[0].text).not.toContain('550');
    expect(result.content[0].text).not.toContain('secret diagnostic');
  });

  test('surfaces a terminal audit write failure without exposing transport data', async () => {
    globalThis.fetch = auditFetch({ patchOk: false }) as unknown as typeof globalThis.fetch;
    const result = await sendEmailTool.handler({ to: GEORGE_EMAIL_RECIPIENT, subject: 'private subject', body: 'private body' }, context());
    expect(parsed(result)).toEqual({ ok: false, status: 'failed', auditId: AUDIT_ID, code: 'AUDIT_UNAVAILABLE' });
    expect(result.content[0].text).not.toContain('private');
  });

  test('redacts message content from run telemetry input', () => {
    expect(sanitizeToolInputForTelemetry('send_email', {
      to: GEORGE_EMAIL_RECIPIENT, subject: 'private subject', body: 'private body',
    })).toEqual({ recipient: GEORGE_EMAIL_RECIPIENT, content: 'redacted' });
  });

  test('keeps the recipient in the built CommonJS telemetry module', () => {
    const projectRoot = path.resolve(__dirname, '../..');
    execFileSync('npm', ['run', 'build'], { cwd: projectRoot, stdio: 'pipe' });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const builtTelemetry = require(path.join(projectRoot, 'dist/lib/tools/tool-telemetry.js')) as {
      sanitizeToolInputForTelemetry: typeof sanitizeToolInputForTelemetry;
    };
    expect(builtTelemetry.sanitizeToolInputForTelemetry('send_email', {
      to: GEORGE_EMAIL_RECIPIENT, subject: 'private subject', body: 'private body',
    })).toEqual({ recipient: GEORGE_EMAIL_RECIPIENT, content: 'redacted' });
  });

  test('schema is restricted to the safe capability', () => {
    expect(sendEmailTool.mcpExposed).toBe(false);
    expect(sendEmailTool.inputSchema.additionalProperties).toBe(false);
    expect(sendEmailTool.inputSchema.properties).not.toHaveProperty('cc');
    expect(sendEmailTool.inputSchema.properties).not.toHaveProperty('attachments');
  });
});
