import { describe, expect, it } from 'vitest';
import { redactSensitive, REDACTED } from '../../src/lib/utils/redact-sensitive';

describe('redactSensitive — extended credential patterns', () => {
  it('redacts rpat_ personal access tokens', () => {
    const input = 'Token: rpat_abcdef1234567890_xyz';
    const result = redactSensitive(input);
    expect(result).toBe(`Token: ${REDACTED}`);
    expect(result).not.toContain('rpat_');
  });

  it('redacts rreg_ workspace registration tokens, signature included', () => {
    const token = 'rreg_eyJzdWIiOiJ3b3Jrc3BhY2UtY29ubmVjdG9yIn0.Zm9vYmFyX3NpZ25hdHVyZS12YWx1ZQ';
    const result = redactSensitive(`spawn failed: REDBTN_REGISTRATION_TOKEN=${token}. Container exited.`);
    expect(result).toBe(`spawn failed: REDBTN_REGISTRATION_TOKEN=${REDACTED}. Container exited.`);
    expect(result).not.toContain('rreg_');
    expect(result).not.toContain('Zm9vYmFy');
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

  it('preserves ordinary long strings and base64 data outside credential keys', () => {
    const longBase64 = 'A'.repeat(64);
    const input = `Payload: ${longBase64}`;
    const result = redactSensitive(input);
    expect(result).toBe(`Payload: ${longBase64}`);
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

  it('redacts operational bearer tokens and credential suffixes in objects', () => {
    const config = {
      enabled: true,
      mode: 'always',
      atlasToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJhZ2VudCJ9.sig1',
      coordinatorToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.sig2',
      workerToken: 'raw_worker_token_string',
      reviewerToken: 'raw_reviewer_token_string',
      clientSecret: 'shhh-secret',
      masterPassword: 'super-password',
      dbCredentials: { host: '10.100.0.10' },
      workerHosts: [{ host: 'server.georgeanthony.net', port: 2222 }],
    };

    const redacted = redactSensitive(config);
    expect(redacted.enabled).toBe(true);
    expect(redacted.mode).toBe('always');
    expect(redacted.atlasToken).toBe(REDACTED);
    expect(redacted.coordinatorToken).toBe(REDACTED);
    expect(redacted.workerToken).toBe(REDACTED);
    expect(redacted.reviewerToken).toBe(REDACTED);
    expect(redacted.clientSecret).toBe(REDACTED);
    expect(redacted.masterPassword).toBe(REDACTED);
    expect(redacted.dbCredentials).toBe(REDACTED);
    expect(redacted.workerHosts[0].host).toBe('server.georgeanthony.net');
  });

  it('redacts root value when rootKey is sensitive', () => {
    const rawToken = 'plain-token-that-has-no-special-prefix';
    const result = redactSensitive(rawToken, 'atlasToken');
    expect(result).toBe(REDACTED);

    const nonSensitive = redactSensitive('my-regular-mode', 'mode');
    expect(nonSensitive).toBe('my-regular-mode');
  });
});

describe('redactSensitive — credentials inside free text', () => {
  const rfsh = 'rfsh_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1V2w';

  it('masks a redauth refresh token anywhere in text', () => {
    const out = redactSensitive({ stdout: `token was ${rfsh} ok` });
    expect(out.stdout).not.toContain('rfsh_a1B2');
    expect(out.stdout).toContain(REDACTED);
  });

  it('masks a credential file printed by run_command (2026-10-01)', () => {
    const file = JSON.stringify({ access_token: '[REDACTED]', refresh_token: 'opaque9f8e7d6c5b4a3f2e1d0c', expires_at: 1790827109785, scope: 'profile email' });
    const out = redactSensitive({ stdout: `===CRED===\n${file}\n` });
    expect(out.stdout).not.toContain('opaque9f8e7d6c5b4a3f2e1d0c');
    expect(out.stdout).toContain('"refresh_token":"[REDACTED]"');
    expect(out.stdout).toContain('"expires_at":1790827109785');
    expect(out.stdout).toContain('"scope":"profile email"');
  });

  it('masks .env style secrets', () => {
    const out = redactSensitive({ stdout: 'DISCORD_BOT_TOKEN=MTE4ODk1NjQ3Mj.abc123XYZ\nPORT=3000\nCLIENT_SECRET: 9f8e7d6c5b4a3f2e1d0c' });
    expect(out.stdout).not.toContain('MTE4ODk1NjQ3Mj');
    expect(out.stdout).not.toContain('9f8e7d6c5b4a3f2e1d0c');
    expect(out.stdout).toContain('PORT=3000');
  });

  it('leaves source code and counts readable', () => {
    const code = 'interface A { token: string; apiKey: config.apiKey; refreshToken: process.env.REFRESH_TOKEN }\n"tokens": 1200, "totalTokens": 48213';
    expect(redactSensitive({ stdout: code }).stdout).toBe(code);
  });
});

describe('redactSensitive — token counts are not secrets', () => {
  it('keeps numeric usage counters readable', () => {
    const usage = {
      inputTokens: 6296424,
      outputTokens: 78489,
      totalTokens: 6374913,
      cacheReadInputTokens: 5900000,
      model: 'meta/muse-spark-1.3-contributor',
    };
    expect(redactSensitive({ usage })).toEqual({ usage });
    const metadata = { tokens: { input: 10, output: 2, total: 12 } };
    expect(redactSensitive({ metadata })).toEqual({ metadata });
  });

  it('still redacts strings under the same keys, and the singular token key', () => {
    expect(redactSensitive({ accessTokens: 'abc', tokens: 'xyz', token: 1234 })).toEqual({
      accessTokens: '[REDACTED]',
      tokens: '[REDACTED]',
      token: '[REDACTED]',
    });
    expect(redactSensitive({ tokens: { input: 1, refresh: 'rfsh_abc' } }).tokens).toBe('[REDACTED]');
  });
});
