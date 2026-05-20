/**
 * Phase 6 — media-normalize-messages-multimodal
 *
 * Tests for normalizeMessages + mergeMessageContent in
 * redbtn/src/lib/nodes/universal/executors/neuronExecutor.ts and the
 * parts-array passthrough in executeBuildMessagesOperation.
 *
 * Acceptance criteria for this phase:
 *   - A messages array carrying an image part survives normalization unchanged.
 *   - Text-only path output is byte-identical to the pre-fix output (the
 *     historic `${a}\n\n${b}` merge result is the regression target).
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeMessages,
  mergeMessageContent,
} from '../../src/lib/nodes/universal/executors/normalizeMessages';

describe('mergeMessageContent', () => {
  it('string + string → "a\\n\\nb" (byte-identical regression target)', () => {
    expect(mergeMessageContent('hello', 'world')).toBe('hello\n\nworld');
  });

  it('empty string + non-empty → "\\n\\n<b>"', () => {
    // Preserve the historic shape — the pre-fix code did template-literal
    // concat which produces "\n\nworld" for empty a.
    expect(mergeMessageContent('', 'world')).toBe('\n\nworld');
  });

  it('array + array → flat concat with no text bridge when boundary is image→text', () => {
    const a = [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }];
    const b = [{ type: 'text', text: 'caption' }];
    const out = mergeMessageContent(a, b);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([
      { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      { type: 'text', text: 'caption' },
    ]);
  });

  it('array + array → splices a "\\n\\n" text bridge when boundary is text→text', () => {
    const a = [{ type: 'text', text: 'first' }];
    const b = [{ type: 'text', text: 'second' }];
    const out = mergeMessageContent(a, b);
    expect(out).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('mixed: string + array (boundary text→whatever) — promotes string and bridges if next is text', () => {
    const out = mergeMessageContent('intro', [
      { type: 'text', text: 'body' },
      { type: 'image_url', image_url: { url: 'u' } },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'intro' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'body' },
      { type: 'image_url', image_url: { url: 'u' } },
    ]);
  });

  it('mixed: array + string — promotes string and bridges if last is text', () => {
    const out = mergeMessageContent([{ type: 'text', text: 'open' }], 'close');
    expect(out).toEqual([
      { type: 'text', text: 'open' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'close' },
    ]);
  });

  it('mixed: array ending in image + string — no text bridge', () => {
    const out = mergeMessageContent(
      [{ type: 'image_url', image_url: { url: 'u' } }],
      'caption',
    );
    expect(out).toEqual([
      { type: 'image_url', image_url: { url: 'u' } },
      { type: 'text', text: 'caption' },
    ]);
  });
});

describe('normalizeMessages — text-only path (regression target)', () => {
  it('merges two consecutive user strings byte-identically to the pre-fix shape', () => {
    const input = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ];
    const out = normalizeMessages(input);
    expect(out).toEqual([{ role: 'user', content: 'a\n\nb' }]);
  });

  it('preserves a non-merging user/assistant alternation unchanged', () => {
    const input = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ];
    const out = normalizeMessages(input);
    expect(out).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'q2' },
    ]);
  });

  it('merges multiple system messages into a single leading system', () => {
    const input = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'q' },
      { role: 'system', content: 'B' },
    ];
    const out = normalizeMessages(input);
    expect(out).toEqual([
      { role: 'system', content: 'A\n\nB' },
      { role: 'user', content: 'q' },
    ]);
  });

  it('returns the input unchanged when empty', () => {
    expect(normalizeMessages([])).toEqual([]);
    // @ts-expect-error testing null pass-through guard
    expect(normalizeMessages(null)).toBeNull();
  });
});

describe('normalizeMessages — multimodal-safe (image part survives merge)', () => {
  it('an image part survives the merge between two consecutive user messages', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'https://x/p.jpg' } };
    const input = [
      { role: 'user', content: [imagePart, { type: 'text', text: 'what is this?' }] },
      { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
    ];
    const out = normalizeMessages(input);
    expect(out.length).toBe(1);
    expect(out[0].role).toBe('user');
    const parts = out[0].content as Array<Record<string, unknown>>;
    // image_url part remains intact, in position 0, identity-preserved.
    expect(parts[0]).toEqual(imagePart);
    // The text→text boundary between the trailing text of msg 1 and the
    // leading text of msg 2 gets a "\n\n" bridge.
    expect(parts).toEqual([
      imagePart,
      { type: 'text', text: 'what is this?' },
      { type: 'text', text: '\n\n' },
      { type: 'text', text: 'follow up' },
    ]);
  });

  it('a single multimodal message passes through unchanged', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'https://x/p.jpg' } };
    const input = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [imagePart, { type: 'text', text: 'describe' }] },
    ];
    const out = normalizeMessages(input);
    expect(out).toEqual(input);
    // Identity preservation: the image_url object survives the round-trip.
    expect((out[1].content as Array<unknown>)[0]).toBe(imagePart);
  });

  it('mixed: prior user is text-string, next user is parts array — promotes string + concats', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'u' } };
    const input = [
      { role: 'user', content: 'first text' },
      { role: 'user', content: [imagePart, { type: 'text', text: 'caption' }] },
    ];
    const out = normalizeMessages(input);
    expect(out.length).toBe(1);
    expect(out[0].content).toEqual([
      { type: 'text', text: 'first text' },
      imagePart,
      { type: 'text', text: 'caption' },
    ]);
  });

  it('does NOT coerce parts arrays to "[object Object]" (the pre-fix bug)', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'u' } };
    const input = [
      { role: 'user', content: [imagePart] },
      { role: 'user', content: [imagePart] },
    ];
    const out = normalizeMessages(input);
    expect(typeof out[0].content).toBe('object');
    expect(JSON.stringify(out[0].content)).not.toContain('[object Object]');
    expect((out[0].content as Array<unknown>).length).toBe(2);
  });
});

describe('normalizeMessages — flattenSystemContent (multimodal system input)', () => {
  it('flattens an array-typed system content to plain text', () => {
    const input = [
      {
        role: 'system',
        content: [
          { type: 'text', text: 'first rule' },
          // Non-text parts in a system message are dropped (no provider
          // currently routes images via the system role).
          { type: 'image_url', image_url: { url: 'u' } },
          { type: 'text', text: 'second rule' },
        ],
      },
      { role: 'user', content: 'hi' },
    ];
    const out = normalizeMessages(input);
    expect(out[0]).toEqual({ role: 'system', content: 'first rule\n\nsecond rule' });
  });
});
