import { describe, expect, it } from 'vitest';
import {
  capStreamEventPayload,
  sanitizeStreamEvent,
  MAX_STREAM_EVENT_TEXT_CHARS,
} from '../../src/lib/streams/stream-publisher.js';
import { redactSensitive } from '../../src/lib/utils/redact-sensitive.js';

const ev = (o: Record<string, unknown>) => o as any;

describe('sanitizeStreamEvent — payload caps', () => {
  it('caps a huge tool_result BEFORE redacting, so the redactor never sees it', () => {
    const huge = 'x'.repeat(512 * 1024);
    const started = Date.now();
    const out = sanitizeStreamEvent(
      ev({ type: 'tool_result', sessionId: 's1', toolName: 't', result: { stdout: huge } }),
    );
    // The unbounded URL-credential regex took 19.1 s on 156 KB; capped, this
    // is microseconds. A regression here means the cap stopped running first.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(JSON.stringify(out).length).toBeLessThan(3 * MAX_STREAM_EVENT_TEXT_CHARS);
    expect((out as any).result).toMatchObject({ _truncated: true });
  });

  it('caps every oversized string field, not just `text`', () => {
    const huge = 'y'.repeat(64 * 1024);
    const out = sanitizeStreamEvent(ev({ type: 'text_out', sessionId: 's1', text: huge, other: huge }));
    expect((out as any).text).toContain('...[truncated]');
    expect((out as any).other).toContain('...[truncated]');
  });

  it('still redacts a secret that survives inside a capped field', () => {
    const out = sanitizeStreamEvent(
      ev({
        type: 'text_in',
        sessionId: 's1',
        text: 'rpat_abcdefghijklmnopqrstuvwxyz012345 ' + 'z'.repeat(64 * 1024),
      }),
    );
    expect((out as any).text).toContain('[REDACTED]');
    expect(JSON.stringify(out)).not.toContain('rpat_abcdefghijklmnopqrstuvwxyz012345');
  });

  it('returns the original object untouched when nothing is oversized', () => {
    const input = ev({ type: 'text_out', sessionId: 's1', text: 'hi' });
    expect(capStreamEventPayload(input)).toBe(input);
  });
});

describe('redactSensitive — linear on pathological input', () => {
  it('handles a 1 MB credential-free string in well under a second', () => {
    const started = Date.now();
    redactSensitive({ blob: 'x'.repeat(1024 * 1024) });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('still masks URL credentials and PEM blocks', () => {
    expect(redactSensitive({ dsn: 'mongodb://u:pw@h:27017/db' }).dsn).toBe(
      'mongodb://u:[REDACTED]@h:27017/db',
    );
    expect(
      redactSensitive({ k: '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----' }).k,
    ).toBe('[REDACTED]');
  });

  it('masks a key block whose END marker was cut off by the cap', () => {
    expect(redactSensitive({ k: 'x -----BEGIN OPENSSH PRIVATE KEY-----\nAAAA...[truncated]' }).k).toBe(
      'x [REDACTED]',
    );
  });
});
