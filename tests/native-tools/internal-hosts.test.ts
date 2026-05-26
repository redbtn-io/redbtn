/**
 * Internal-host allowlist
 *
 * Covers the helper that decides whether a target URL belongs to an
 * allowlisted internal redbtn host. `fetch_url` uses this to decide when it
 * may attach the run owner's credentials — so the look-alike rejections here
 * are a security boundary, not a cosmetic detail.
 */

import { describe, test, expect } from 'vitest';
import {
  isInternalHost,
  getInternalHostAllowlist,
} from '../../src/lib/tools/native/_internal-hosts';

const NO_ENV = {} as NodeJS.ProcessEnv;

describe('internal-host allowlist', () => {
  test('allowlists the static redbtn platform hosts', () => {
    expect(isInternalHost('https://app.redbtn.io/x', NO_ENV)).toBe(true);
    expect(isInternalHost('https://run.redbtn.io/x', NO_ENV)).toBe(true);
    expect(isInternalHost('https://app.redbtn.io/api/auth/me', NO_ENV)).toBe(true);
  });

  test('allowlists the configured WEBAPP_URL host', () => {
    const env = { WEBAPP_URL: 'https://my-webapp.example.net:8443' } as NodeJS.ProcessEnv;
    expect(isInternalHost('https://my-webapp.example.net/api/auth/me', env)).toBe(true);
    expect(getInternalHostAllowlist(env)).toContain('my-webapp.example.net');
  });

  test('allowlists a bare-host WEBAPP_URL and a localhost dev value', () => {
    expect(
      isInternalHost('http://localhost:3000/api/auth/me', {
        WEBAPP_URL: 'http://localhost:3000',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
    expect(
      isInternalHost('https://bare-host.internal/x', {
        WEBAPP_URL: 'bare-host.internal:9000',
      } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  test('rejects arbitrary external hosts', () => {
    expect(isInternalHost('https://evil.example.com/x', NO_ENV)).toBe(false);
    expect(isInternalHost('https://google.com', NO_ENV)).toBe(false);
    expect(isInternalHost('http://192.168.1.50/x', NO_ENV)).toBe(false);
  });

  test('rejects look-alike hosts that would pass a naive suffix or prefix check', () => {
    expect(isInternalHost('https://app.redbtn.io.evil.com/x', NO_ENV)).toBe(false);
    expect(isInternalHost('https://evil-run.redbtn.io.attacker.net', NO_ENV)).toBe(false);
    expect(isInternalHost('https://notapp.redbtn.io', NO_ENV)).toBe(false);
    expect(isInternalHost('https://redbtn.io', NO_ENV)).toBe(false);
    // userinfo trick: real host is evil.com, not app.redbtn.io
    expect(isInternalHost('https://app.redbtn.io@evil.com/x', NO_ENV)).toBe(false);
  });

  test('rejects unparseable or empty URLs', () => {
    expect(isInternalHost('not a url', NO_ENV)).toBe(false);
    expect(isInternalHost('', NO_ENV)).toBe(false);
    expect(isInternalHost('   ', NO_ENV)).toBe(false);
  });

  test('hostname matching is case-insensitive', () => {
    expect(isInternalHost('https://APP.RedBtn.IO/x', NO_ENV)).toBe(true);
  });

  test('ignores an empty or unparseable WEBAPP_URL', () => {
    expect(getInternalHostAllowlist({ WEBAPP_URL: '' } as NodeJS.ProcessEnv)).toEqual([
      'app.redbtn.io',
      'run.redbtn.io',
    ]);
    expect(
      getInternalHostAllowlist({ WEBAPP_URL: '::::' } as NodeJS.ProcessEnv),
    ).toEqual(['app.redbtn.io', 'run.redbtn.io']);
  });
});
