import { describe, expect, it } from 'vitest';
import { redactSensitive, REDACTED } from '../../src/lib/utils/redact-sensitive';

describe('redactSensitive — extended credential patterns', () => {
  it('redacts rpat_ personal access tokens', () => {
    const input = 'Token: rpat_abcdef1234567890_xyz';
    const result = redactSensitive(input);
    expect(result).toBe(`Token: ${REDACTED}`);
    expect(result).not.toContain('rpat_');
  });

  it('redacts sk- API keys (OpenAI-style)', () => {
    const input = 'Key is sk-proj-1234567890abcdef123456';
    const result = redactSensitive(input);
    expect(result).toBe(`Key is ${REDACTED}`);
    expect(result).not.toContain('sk-');
  });

  it('redacts ghp_ GitHub personal access tokens', () => {
    const input = 'GitHub: ghp_1234567890abcdefghijklmnopqrstuvwxyz';
    const result = redactSensitive(input);
    expect(result).toBe(`GitHub: ${REDACTED}`);
    expect(result).not.toContain('ghp_');
  });

  it('redacts AKIA AWS access key IDs', () => {
    const input = 'AWS user key AKIAIOSFODNN7EXAMPLE in config';
    const result = redactSensitive(input);
    expect(result).toBe(`AWS user key ${REDACTED} in config`);
    expect(result).not.toContain('AKIA');
  });

  it('redacts long bare base64 runs', () => {
    const longBase64 = 'A'.repeat(64);
    const input = `Payload: ${longBase64}`;
    const result = redactSensitive(input);
    expect(result).toBe(`Payload: ${REDACTED}`);
    expect(result).not.toContain('AAAA');
  });

  it('redacts padded base64 runs', () => {
    const paddedBase64 = 'A'.repeat(42) + '==';
    const input = `Data: ${paddedBase64}`;
    const result = redactSensitive(input);
    expect(result).toBe(`Data: ${REDACTED}`);
    expect(result).not.toContain('==');
  });

  it('preserves git commit SHAs', () => {
    const gitSha = '6aa1d97608971669b4a25d0a1234567890abcdef';
    const input = `Commit: ${gitSha}`;
    const result = redactSensitive(input);
    expect(result).toBe(`Commit: ${gitSha}`);
  });

  it('preserves ordinary short strings and prose', () => {
    const input = 'Normal log message without any secrets.';
    expect(redactSensitive(input)).toBe(input);
  });

  it('redacts sensitive keys in objects', () => {
    const obj = {
      token: 'some-arbitrary-token',
      password: 'my-password',
      username: 'alpha',
      nested: {
        apiKey: 'secret-key-123',
        status: 'active',
      },
    };
    const result = redactSensitive(obj);
    expect(result.token).toBe(REDACTED);
    expect(result.password).toBe(REDACTED);
    expect(result.username).toBe('alpha');
    expect(result.nested.apiKey).toBe(REDACTED);
    expect(result.nested.status).toBe('active');
  });

  it('handles arrays and circular references safely', () => {
    const arr = ['rpat_test1234567890', { secret: 'topsecret' }, 'hello'];
    const result = redactSensitive(arr);
    expect(result[0]).toBe(REDACTED);
    expect((result[1] as any).secret).toBe(REDACTED);
    expect(result[2]).toBe('hello');

    const circular: any = { name: 'test' };
    circular.self = circular;
    const circResult = redactSensitive(circular);
    expect(circResult.self).toBe('[Circular]');
  });
});
