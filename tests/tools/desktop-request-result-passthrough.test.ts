/**
 * requestDesktop must carry the connector's `result` payload.
 *
 * The normalization in `desktop-request.ts` rebuilt every reply as
 * `{kind,id,ok,image?,screen?,error?}`. `result` — the field carrying dryRun,
 * op, typed, text, keys, unknownKeys, foregroundWindow and the mouse `diag` —
 * was not in that list, so the connector's entire account of what it had just
 * done was thrown away at the Redis boundary, one layer below the tools that
 * were supposed to report it. Both dry runs and real keystrokes then reached a
 * model as an identical bare `{ok:true}`.
 */

import { describe, test, expect } from 'vitest';
import { normalizeComputerReply } from '../../src/lib/tools/native/desktop-request';

describe('normalizeComputerReply', () => {
  test('forwards the connector `result` evidence payload', () => {
    const reply = normalizeComputerReply('req_1', {
      kind: 'computer_result',
      id: 'ignored',
      ok: true,
      result: {
        dryRun: true,
        op: 'type',
        typed: 10,
        text: 'funny cats',
        keys: [],
        foregroundWindow: 'Chrome',
      },
    });

    expect(reply).toEqual({
      kind: 'computer_result',
      id: 'req_1',
      ok: true,
      result: {
        dryRun: true,
        op: 'type',
        typed: 10,
        text: 'funny cats',
        keys: [],
        foregroundWindow: 'Chrome',
      },
    });
  });

  test('still forwards image, screen and error, and re-keys the id', () => {
    const image = { format: 'png' as const, base64: 'abc', width: 10, height: 10 };
    const screen = { displays: [] };
    const error = { code: 'consent_denied', message: 'user denied the request' };

    expect(normalizeComputerReply('req_2', { ok: false, image, screen, error })).toEqual({
      kind: 'computer_result',
      id: 'req_2',
      ok: false,
      image,
      screen,
      error,
    });
  });

  test('a reply with no `ok:true` is never optimistically upgraded', () => {
    expect(normalizeComputerReply('req_3', { ok: 'true' }).ok).toBe(false);
    expect(normalizeComputerReply('req_4', {}).ok).toBe(false);
  });
});
