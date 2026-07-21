/**
 * George-only agent email delivery.
 *
 * This is intentionally not a general-purpose mailer. It can deliver only
 * agent@redbtn.io -> george@redbtn.io and records metadata-only lifecycle
 * events with RedRun. Credentials and message content never leave this module.
 */
import nodemailer from 'nodemailer';
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { AGENT_EMAIL_SENDER, GEORGE_EMAIL_RECIPIENT } from '../agent-email-policy';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export { AGENT_EMAIL_SENDER, GEORGE_EMAIL_RECIPIENT } from '../agent-email-policy';

interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
}

function toolResult(payload: Record<string, unknown>, isError = false): NativeMcpResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

function failed(code: string, auditId?: string): NativeMcpResult {
  return toolResult({ ok: false, status: 'failed', ...(auditId ? { auditId } : {}), code }, true);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function markdownToHtml(markdown: string): string {
  return escapeHtml(markdown).split(/\n{2,}/).filter(Boolean).map((part) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(part);
    const inline = (value: string) => value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    if (heading) return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`;
    return `<p>${inline(part).replace(/\n/g, '<br>')}</p>`;
  }).join('\n');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim();
}

function buildMessage(args: AnyObject): { message?: MailMessage; code?: string } {
  // Presence is rejected even when empty: these fields are bypass attempts.
  if (['from', 'cc', 'bcc', 'replyTo', 'attachments'].some((key) => Object.prototype.hasOwnProperty.call(args, key))) {
    return { code: 'RECIPIENT_RESTRICTED' };
  }
  if (args.to !== GEORGE_EMAIL_RECIPIENT) return { code: 'RECIPIENT_RESTRICTED' };
  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  const body = typeof args.body === 'string' ? args.body : '';
  if (!subject || !body) return { code: 'VALIDATION' };
  const bodyType = args.bodyType ?? 'markdown';
  if (bodyType === 'text') return { message: { from: AGENT_EMAIL_SENDER, to: GEORGE_EMAIL_RECIPIENT, subject, text: body } };
  if (bodyType === 'html') return { message: { from: AGENT_EMAIL_SENDER, to: GEORGE_EMAIL_RECIPIENT, subject, html: body, text: stripTags(body) } };
  if (bodyType === 'markdown') return { message: { from: AGENT_EMAIL_SENDER, to: GEORGE_EMAIL_RECIPIENT, subject, html: markdownToHtml(body), text: body } };
  return { code: 'VALIDATION' };
}

function auditConfig(): { baseUrl: string; headers: HeadersInit } | null {
  const baseUrl = process.env.REDRUN_API_URL?.trim().replace(/\/$/, '');
  const key = process.env.REDRUN_AGENT_EMAIL_AUDIT_KEY;
  return baseUrl && key ? { baseUrl, headers: { 'content-type': 'application/json', 'x-internal-key': key } } : null;
}

async function createAuditAttempt(): Promise<string | null> {
  const config = auditConfig();
  if (!config) return null;
  try {
    const response = await fetch(`${config.baseUrl}/api/agent-email/audits`, {
      method: 'POST', headers: config.headers,
      body: JSON.stringify({ sender: AGENT_EMAIL_SENDER, recipient: GEORGE_EMAIL_RECIPIENT }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { auditId?: unknown; status?: unknown };
    return typeof body.auditId === 'string' && body.status === 'attempted' ? body.auditId : null;
  } catch {
    return null;
  }
}

async function recordAuditOutcome(auditId: string, status: 'accepted' | 'rejected' | 'failed', fields: Record<string, unknown>): Promise<boolean> {
  const config = auditConfig();
  if (!config) return false;
  try {
    const response = await fetch(`${config.baseUrl}/api/agent-email/audits/${encodeURIComponent(auditId)}`, {
      method: 'PATCH', headers: config.headers, body: JSON.stringify({ status, ...fields }),
    });
    if (!response.ok) return false;
    const body = await response.json() as { auditId?: unknown; status?: unknown };
    return body.auditId === auditId && body.status === status;
  } catch {
    return false;
  }
}

function createTransport(): AnyObject | null {
  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;
  const port = Number.parseInt(process.env.EMAIL_PORT || '587', 10);
  if (!host || !user || !pass || !Number.isFinite(port) || port <= 0 || port > 65535) return null;
  return nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
}

function closeTransport(transporter: AnyObject | null): void {
  try { if (typeof transporter?.close === 'function') transporter.close(); } catch { /* no-op */ }
}

const sendEmailTool: NativeToolDefinition = {
  description: 'Send a non-sensitive operational email from agent@redbtn.io to george@redbtn.io only. Returns sanitized delivery status, audit ID, and SMTP message ID when accepted.',
  server: 'system',
  mcpExposed: false,
  inputSchema: {
    type: 'object', additionalProperties: false,
    properties: {
      to: { type: 'string', const: GEORGE_EMAIL_RECIPIENT, description: 'Required fixed recipient: george@redbtn.io.' },
      subject: { type: 'string', description: 'Required non-sensitive subject.' },
      body: { type: 'string', description: 'Required non-sensitive body.' },
      bodyType: { type: 'string', enum: ['text', 'html', 'markdown'], description: 'Optional format; defaults to markdown.' },
    },
    required: ['to', 'subject', 'body'],
  },
  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const built = buildMessage(rawArgs);
    if (built.code) return failed(built.code);

    // Fail closed before SMTP so every attempt has a durable audit record.
    const auditId = await createAuditAttempt();
    if (!auditId) return failed('AUDIT_UNAVAILABLE');

    let transporter: AnyObject | null = null;
    try {
      transporter = createTransport();
      if (!transporter) {
        return await recordAuditOutcome(auditId, 'failed', { errorCode: 'smtp_configuration_failed' })
          ? failed('SMTP_CONFIGURATION_FAILED', auditId) : failed('AUDIT_UNAVAILABLE', auditId);
      }
      const info = await transporter.sendMail(built.message!);
      const messageId = typeof info?.messageId === 'string' && info.messageId ? info.messageId : null;
      if (messageId && Array.isArray(info?.accepted) && info.accepted.includes(GEORGE_EMAIL_RECIPIENT)) {
        return await recordAuditOutcome(auditId, 'accepted', { messageId, acceptedRecipients: [GEORGE_EMAIL_RECIPIENT] })
          ? toolResult({ ok: true, status: 'accepted', auditId, messageId }) : failed('AUDIT_UNAVAILABLE', auditId);
      }
      return await recordAuditOutcome(auditId, 'rejected', { rejectedRecipients: [GEORGE_EMAIL_RECIPIENT], errorCode: 'smtp_recipient_rejected' })
        ? failed('SMTP_RECIPIENT_REJECTED', auditId) : failed('AUDIT_UNAVAILABLE', auditId);
    } catch {
      return await recordAuditOutcome(auditId, 'failed', { errorCode: 'smtp_delivery_failed' })
        ? failed('SMTP_DELIVERY_FAILED', auditId) : failed('AUDIT_UNAVAILABLE', auditId);
    } finally {
      closeTransport(transporter);
    }
  },
};

export default sendEmailTool;
module.exports = sendEmailTool;
