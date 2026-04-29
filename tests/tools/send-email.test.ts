/**
 * Vitest for native tool: send_email
 *
 * Per TOOL-HANDOFF.md §6.1 — happy path + validation + upstream error.
 *
 * Mocks the `nodemailer` module via vi.mock() so the test never touches a real
 * SMTP server. The mock records every transport-create call + every sendMail
 * invocation so we can assert on the exact options nodemailer received.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

// ─── nodemailer mock — installed before the SUT imports it ─────────────────
// Captured per-test via the variables below.
let lastTransportConfig: Record<string, unknown> | null = null;
let lastSendMailCall: Record<string, unknown> | null = null;
let sendMailImpl: (opts: Record<string, unknown>) => Promise<unknown> = async () => ({
  messageId: '<mocked@example>',
  accepted: ['x@y.com'],
  rejected: [],
});
let createTransportImpl: ((cfg: Record<string, unknown>) => unknown) | null = null;

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (cfg: Record<string, unknown>) => {
      lastTransportConfig = cfg;
      if (createTransportImpl) return createTransportImpl(cfg);
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
    if (createTransportImpl) return createTransportImpl(cfg);
    return {
      sendMail: async (opts: Record<string, unknown>) => {
        lastSendMailCall = opts;
        return sendMailImpl(opts);
      },
      close: vi.fn(),
    };
  },
}));

import sendEmailTool from '../../src/lib/tools/native/send-email';

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: { userId: 'user-1' },
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

function setEmailEnv(overrides?: Partial<Record<string, string>>) {
  process.env.EMAIL_HOST = overrides?.EMAIL_HOST ?? 'smtp.test';
  process.env.EMAIL_PORT = overrides?.EMAIL_PORT ?? '587';
  process.env.EMAIL_USER = overrides?.EMAIL_USER ?? 'agent@redbtn.io';
  process.env.EMAIL_PASS = overrides?.EMAIL_PASS ?? 'app-password';
  if (overrides?.EMAIL_FROM !== undefined) process.env.EMAIL_FROM = overrides.EMAIL_FROM;
}

function clearEmailEnv() {
  delete process.env.EMAIL_HOST;
  delete process.env.EMAIL_PORT;
  delete process.env.EMAIL_USER;
  delete process.env.EMAIL_PASS;
  delete process.env.EMAIL_FROM;
}

describe('send_email — schema', () => {
  test('description mentions SMTP', () => {
    expect(sendEmailTool.description.toLowerCase()).toContain('smtp');
  });

  test('requires to + subject + body', () => {
    expect(sendEmailTool.inputSchema.required).toEqual(['to', 'subject', 'body']);
  });

  test('exposes bodyType + attachments + cc/bcc/from/replyTo', () => {
    const props = sendEmailTool.inputSchema.properties;
    expect(props.to).toBeDefined();
    expect(props.subject).toBeDefined();
    expect(props.body).toBeDefined();
    expect(props.bodyType).toBeDefined();
    expect(props.attachments).toBeDefined();
    expect(props.cc).toBeDefined();
    expect(props.bcc).toBeDefined();
    expect(props.from).toBeDefined();
    expect(props.replyTo).toBeDefined();
  });

  test('server label is system', () => {
    expect(sendEmailTool.server).toBe('system');
  });
});

describe('send_email — validation', () => {
  beforeEach(() => {
    setEmailEnv();
    lastSendMailCall = null;
    lastTransportConfig = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('missing to → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/to/i);
  });

  test('empty array to → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: [], subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only to entries → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: ['   ', ''], subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing subject → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: 'x@y.com', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('whitespace-only subject → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: 'x@y.com', subject: '   ', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('missing body → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: 'x@y.com', subject: 's' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).code).toBe('VALIDATION');
  });

  test('invalid bodyType → VALIDATION', async () => {
    const r = await sendEmailTool.handler(
      { to: 'x@y.com', subject: 's', body: 'b', bodyType: 'wat' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/bodyType/i);
  });

  test('missing SMTP env vars → VALIDATION', async () => {
    clearEmailEnv();
    const r = await sendEmailTool.handler(
      { to: 'x@y.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/EMAIL_HOST|EMAIL_USER|EMAIL_PASS/);
  });
});

describe('send_email — happy path', () => {
  beforeEach(() => {
    setEmailEnv({ EMAIL_FROM: 'agent@redbtn.io' });
    lastSendMailCall = null;
    lastTransportConfig = null;
    sendMailImpl = async () => ({
      messageId: '<abc@smtp.test>',
      accepted: ['x@y.com'],
      rejected: [],
    });
    createTransportImpl = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('default markdown body renders to HTML + plain-text', async () => {
    const r = await sendEmailTool.handler(
      {
        to: 'recipient@example.com',
        subject: 'Hello',
        body: '# Heading\n\nSome **bold** text and `code`.',
      },
      makeMockContext(),
    );
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.ok).toBe(true);
    expect(body.messageId).toBe('<abc@smtp.test>');
    expect(body.from).toBe('agent@redbtn.io');
    expect(body.to).toEqual(['recipient@example.com']);
    expect(body.subject).toBe('Hello');

    expect(lastSendMailCall).not.toBeNull();
    // Markdown renders both html + text.
    expect(typeof lastSendMailCall!.html).toBe('string');
    expect((lastSendMailCall!.html as string)).toContain('<h1>Heading</h1>');
    expect((lastSendMailCall!.html as string)).toContain('<strong>bold</strong>');
    expect((lastSendMailCall!.html as string)).toContain('<code>code</code>');
    expect((lastSendMailCall!.text as string)).toContain('# Heading');
  });

  test("bodyType 'html' delivers verbatim HTML + stripped plain-text", async () => {
    await sendEmailTool.handler(
      {
        to: 'r@x.com',
        subject: 's',
        body: '<p>Hello <b>world</b></p>',
        bodyType: 'html',
      },
      makeMockContext(),
    );
    expect((lastSendMailCall!.html as string)).toBe('<p>Hello <b>world</b></p>');
    expect(lastSendMailCall!.text).toBeDefined();
    // Plain-text fallback strips tags but keeps the words.
    expect((lastSendMailCall!.text as string)).toContain('Hello');
    expect((lastSendMailCall!.text as string)).toContain('world');
    expect((lastSendMailCall!.text as string)).not.toContain('<p>');
  });

  test("bodyType 'text' sends plain text only, no html", async () => {
    await sendEmailTool.handler(
      {
        to: 'r@x.com',
        subject: 's',
        body: 'just words',
        bodyType: 'text',
      },
      makeMockContext(),
    );
    expect(lastSendMailCall!.text).toBe('just words');
    expect(lastSendMailCall!.html).toBeUndefined();
  });

  test('default From comes from EMAIL_FROM env', async () => {
    setEmailEnv({ EMAIL_FROM: 'override@redbtn.io' });
    await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(lastSendMailCall!.from).toBe('override@redbtn.io');
  });

  test('explicit `from` arg overrides EMAIL_FROM env', async () => {
    setEmailEnv({ EMAIL_FROM: 'env@redbtn.io' });
    await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b', from: 'caller@redbtn.io' },
      makeMockContext(),
    );
    expect(lastSendMailCall!.from).toBe('caller@redbtn.io');
  });

  test('falls back to EMAIL_USER when EMAIL_FROM unset', async () => {
    setEmailEnv({ EMAIL_USER: 'theuser@redbtn.io', EMAIL_FROM: undefined });
    delete process.env.EMAIL_FROM;
    await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(lastSendMailCall!.from).toBe('theuser@redbtn.io');
  });

  test('multiple recipients via array', async () => {
    await sendEmailTool.handler(
      { to: ['a@x.com', 'b@x.com', 'c@x.com'], subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(lastSendMailCall!.to).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  test('cc + bcc + replyTo are forwarded', async () => {
    await sendEmailTool.handler(
      {
        to: 'r@x.com',
        cc: ['cc@x.com'],
        bcc: 'bcc@x.com',
        replyTo: 'reply@x.com',
        subject: 's',
        body: 'b',
      },
      makeMockContext(),
    );
    expect(lastSendMailCall!.cc).toEqual(['cc@x.com']);
    expect(lastSendMailCall!.bcc).toEqual(['bcc@x.com']);
    expect(lastSendMailCall!.replyTo).toBe('reply@x.com');
  });

  test('attachments are normalised + forwarded', async () => {
    await sendEmailTool.handler(
      {
        to: 'r@x.com',
        subject: 's',
        body: 'b',
        attachments: [
          {
            filename: 'note.txt',
            content: Buffer.from('hello').toString('base64'),
            encoding: 'base64',
            contentType: 'text/plain',
          },
        ],
      },
      makeMockContext(),
    );
    expect(Array.isArray(lastSendMailCall!.attachments)).toBe(true);
    const a = (lastSendMailCall!.attachments as unknown[])[0] as Record<string, string>;
    expect(a.filename).toBe('note.txt');
    expect(a.content).toBe(Buffer.from('hello').toString('base64'));
    expect(a.encoding).toBe('base64');
    expect(a.contentType).toBe('text/plain');
  });

  test('attachments with no content/path/href are dropped', async () => {
    await sendEmailTool.handler(
      {
        to: 'r@x.com',
        subject: 's',
        body: 'b',
        attachments: [
          { filename: 'orphan.txt' }, // no content/path/href → dropped
        ],
      },
      makeMockContext(),
    );
    expect(lastSendMailCall!.attachments).toBeUndefined();
  });

  test('transport built with correct host/port/secure/auth from env', async () => {
    setEmailEnv({
      EMAIL_HOST: 'smtp.gmail.com',
      EMAIL_PORT: '465',
      EMAIL_USER: 'agent@redbtn.io',
      EMAIL_PASS: 'pass-pass',
    });
    await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(lastTransportConfig).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true, // 465 → SMTPS
      auth: { user: 'agent@redbtn.io', pass: 'pass-pass' },
    });
  });

  test('port 587 → secure:false (STARTTLS)', async () => {
    setEmailEnv({ EMAIL_PORT: '587' });
    await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(lastTransportConfig!.secure).toBe(false);
    expect(lastTransportConfig!.port).toBe(587);
  });

  test('returns accepted + rejected from nodemailer info', async () => {
    sendMailImpl = async () => ({
      messageId: '<id-2@smtp.test>',
      accepted: ['ok@x.com'],
      rejected: ['bad@x.com'],
    });
    const r = await sendEmailTool.handler(
      { to: ['ok@x.com', 'bad@x.com'], subject: 's', body: 'b' },
      makeMockContext(),
    );
    const body = JSON.parse(r.content[0].text);
    expect(body.accepted).toEqual(['ok@x.com']);
    expect(body.rejected).toEqual(['bad@x.com']);
  });
});

describe('send_email — upstream error', () => {
  beforeEach(() => {
    setEmailEnv();
    lastSendMailCall = null;
    lastTransportConfig = null;
    createTransportImpl = null;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('SMTP rejection surfaces as isError with the underlying message', async () => {
    sendMailImpl = async () => {
      throw new Error('550 No such user here');
    };
    const r = await sendEmailTool.handler(
      { to: 'nope@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/SMTP send failed/);
    expect(body.error).toMatch(/550 No such user here/);
  });

  test('SMTP connection refused surfaces as isError', async () => {
    sendMailImpl = async () => {
      const e: NodeJS.ErrnoException = new Error('connect ECONNREFUSED 127.0.0.1:587');
      e.code = 'ECONNREFUSED';
      throw e;
    };
    const r = await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/ECONNREFUSED/);
  });

  test('createTransport throw surfaces as isError', async () => {
    // Force the transport factory to blow up.
    createTransportImpl = () => {
      throw new Error('bad config');
    };
    const r = await sendEmailTool.handler(
      { to: 'r@x.com', subject: 's', body: 'b' },
      makeMockContext(),
    );
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).error).toMatch(/bad config/);
  });
});
