/**
 * System-user identity
 *
 * `isSystemUserId` is a security/correctness boundary: GraphRegistry and
 * NeuronRegistry use it (via `SYSTEM_USER_IDS`) to decide which resources are
 * platform-owned. It MUST accept both the legacy `'system'` sentinel and the
 * canonical `SYSTEM_USER_ID` — and reject every ordinary user id, even a
 * well-formed 24-char ObjectId.
 */

import { describe, test, expect } from 'vitest';
import {
  SYSTEM_USER_ID,
  LEGACY_SYSTEM_USER_ID,
  SYSTEM_USER_IDS,
  isSystemUserId,
} from '../../src/lib/system-users';

describe('system-user identity', () => {
  test('exposes the canonical and legacy ids', () => {
    expect(SYSTEM_USER_ID).toBe('000000000000000000000001');
    expect(LEGACY_SYSTEM_USER_ID).toBe('system');
  });

  test('SYSTEM_USER_IDS contains exactly the legacy and canonical ids', () => {
    expect([...SYSTEM_USER_IDS].sort()).toEqual(
      ['000000000000000000000001', 'system'].sort(),
    );
  });

  test('isSystemUserId is true for the legacy sentinel', () => {
    expect(isSystemUserId('system')).toBe(true);
  });

  test('isSystemUserId is true for the canonical ObjectId', () => {
    expect(isSystemUserId('000000000000000000000001')).toBe(true);
  });

  test('isSystemUserId is false for an ordinary 24-char ObjectId', () => {
    // A real user id from the chat-p0 incident notes.
    expect(isSystemUserId('69a0b790a0ae8660290a78da')).toBe(false);
    expect(isSystemUserId('507f1f77bcf86cd799439011')).toBe(false);
  });

  test('isSystemUserId is false for null, undefined, and empty string', () => {
    expect(isSystemUserId(null)).toBe(false);
    expect(isSystemUserId(undefined)).toBe(false);
    expect(isSystemUserId('')).toBe(false);
  });

  test('isSystemUserId is case-sensitive — "System" is not the sentinel', () => {
    expect(isSystemUserId('System')).toBe(false);
    expect(isSystemUserId('SYSTEM')).toBe(false);
  });
});
