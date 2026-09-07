/**
 * Global test setup: make the SSRF guard deterministic and offline.
 *
 * `lib/net/ssrf-guard` resolves every hostname with `dns.lookup` before a
 * request goes out. Unit tests must not depend on real DNS (CI runners, air-
 * gapped boxes, and hostnames like `evil.example.com` that do not exist), so
 * this setup file installs a stub resolver that maps every hostname to a fixed
 * PUBLIC address. Tests that exercise the guard itself install their own stub
 * inside the test body — this `beforeEach` restores the permissive default
 * before each test so a private-address stub never leaks between them.
 *
 * Registered as `setupFiles` in `vitest.config.ts` and in
 * `tests/native-tools/vitest.config.ts`.
 */

import { beforeEach, afterAll } from 'vitest';
import { __setSsrfLookupForTests } from '../../src/lib/net/ssrf-guard';

/** TEST-NET-3 (203.0.113.0/24): reserved for documentation, never private. */
export const TEST_PUBLIC_ADDRESS = '203.0.113.10';

beforeEach(() => {
  __setSsrfLookupForTests(async () => [{ address: TEST_PUBLIC_ADDRESS, family: 4 }]);
});

afterAll(() => {
  __setSsrfLookupForTests(null);
});
