// A log record must not be able to kill the worker.
//
// The incident: a redBoard card with three screenshots arrived with the images
// inlined as base64, and the `Run started` record — whose metadata is just the
// run input — came to 6,670,203 bytes. Building, redacting and storing that,
// while the same object sat in run state and was cloned per step, exhausted the
// worker's V8 heap. Node died mid-run and took the SSH session executing the
// agent with it.
//
// These assert the two things that stop a repeat: nothing enormous survives,
// and what is dropped says so.

import { describe, expect, it } from 'vitest';
import { clampForLog, MAX_STRING_CHARS, MAX_ARRAY_ITEMS, MAX_TOTAL_CHARS } from '../../src/lib/utils/clamp-for-log';

const size = (v: unknown) => JSON.stringify(v)!.length;

function* everyString(value: unknown): Generator<string> {
  if (typeof value === 'string') yield value;
  else if (Array.isArray(value)) for (const item of value) yield* everyString(item);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) yield* everyString(item);
}

describe('clampForLog', () => {
  it('leaves an ordinary record untouched', () => {
    const meta = {
      runId: 'run_1788901183668_dwm9h1',
      graphId: 'qfCRihGbD9mW',
      graphName: 'redBoard Red',
      input: { cardId: '6a8d0b23014181449a0b9a2e', title: 'Multiple named exercises', labels: ['bug'] },
    };
    expect(clampForLog(meta)).toEqual(meta);
  });

  it('clips a single enormous string and names its true size', () => {
    const base64 = 'A'.repeat(1_122_780);
    const clamped = clampForLog({ runId: 'r1', input: { attachments: [{ filename: 'IMG.png', dataUri: base64 }] } });

    const kept = (clamped as any).input.attachments[0].dataUri as string;
    expect(kept.length).toBeLessThan(MAX_STRING_CHARS);
    expect(kept).toContain('1122780 chars total');
    // The identifying fields around it survive.
    expect((clamped as any).input.attachments[0].filename).toBe('IMG.png');
    expect((clamped as any).runId).toBe('r1');
  });

  it('holds the whole record under budget for the payload that caused the outage', () => {
    // Three images, base64, stored twice — once in the input, once in the
    // trigger descriptor's copy of the same body.
    const attachments = [1_122_780, 1_593_240, 615_960].map((n, i) => ({
      filename: `IMG_${i}.png`,
      mimetype: 'image/png',
      dataUri: 'B'.repeat(n),
    }));
    const meta = {
      runId: 'run_1788901183668_dwm9h1',
      graphName: 'redBoard Red',
      input: { attachments, _trigger: { metadata: { attachments } } },
    };
    expect(size(meta)).toBeGreaterThan(6_000_000);

    const clamped = clampForLog(meta);
    expect(size(clamped)).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    // Not one string survives at anything like its original length.
    for (const str of everyString(clamped)) {
      expect(str.length).toBeLessThan(MAX_STRING_CHARS);
    }
    // The second copy of the same array is a repeated reference, so it
    // collapses the way redactSensitive already collapses one.
    expect((clamped as any).input._trigger.metadata.attachments).toBe('[Circular]');
  });

  it('keeps a head and a count for a long array', () => {
    const clamped = clampForLog({ items: Array.from({ length: 500 }, (_, i) => i) }) as { items: unknown[] };
    expect(clamped.items).toHaveLength(MAX_ARRAY_ITEMS + 1);
    expect(clamped.items[MAX_ARRAY_ITEMS]).toContain('500 items total');
  });

  it('falls back to size markers when no single field is the problem', () => {
    // Ten thousand small strings: nothing individually clippable, still huge.
    const wide = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`k${i}`, `value-${i}`]));
    const clamped = clampForLog({ runId: 'r1', state: wide }) as Record<string, unknown>;

    expect(size(clamped)).toBeLessThanOrEqual(MAX_TOTAL_CHARS);
    expect(clamped.runId).toBe('r1');
    expect(String(clamped.state)).toContain('[clamped,');
  });

  it('survives circular metadata rather than throwing inside the logger', () => {
    const cyclic: Record<string, unknown> = { runId: 'r1' };
    cyclic.self = cyclic;
    expect(() => clampForLog(cyclic)).not.toThrow();
    expect((clampForLog(cyclic) as Record<string, unknown>).runId).toBe('r1');
  });

  it('does not disturb a Date', () => {
    const at = new Date('2026-09-08T21:00:00.000Z');
    expect((clampForLog({ at }) as { at: Date }).at).toEqual(at);
  });
});
