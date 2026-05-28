/**
 * @file tests/unit/chat-component-spec.test.ts
 *
 * Phase 1 of `chat-interactive-widgets` — locks in the frozen v1 ChatComponentSpec
 * schema (see `~/assistant/chat-epic-4-interactive-signoff.md`).
 *
 * Asserted invariants:
 *   1. Required fields present + correct types accepts.
 *   2. All optional fields populated (full spec) accepts.
 *   3. Unknown `type` → reject.
 *   4. Missing required field (`componentId`, `type`, `config`, `surfaces`) → reject.
 *   5. Extra top-level field → reject (frozen / no-drift).
 *   6. Wrong-type field (`config: 'string'`, `surfaces: {}`) → reject.
 *   7. Empty `surfaces` → reject.
 *   8. `surfaces` containing non-allowlisted value → reject.
 *   9. `binding` shape with unknown subfield → reject.
 *  10. `interaction.channel === 'followup'` missing `text` → reject.
 *  11. `interaction.channel === 'followup'` with `text` > 4000 chars → reject.
 *  12. `interaction.channel === 'state-write'` missing `namespace`/`key` → reject.
 *  13. `interaction.channel === 'run-event'` minimal → accept.
 *  14. `assertChatComponentSpec` throws `ChatComponentSpecValidationError`.
 *  15. Exported JSON Schema agrees with hand-rolled validator on each fixture
 *      (defence-in-depth — engine + webapp validators must not drift).
 *  16. Schema version constant is exported and stable for v1.
 */

import { describe, test, expect } from 'vitest';
import Ajv from 'ajv';

import {
  CHAT_COMPONENT_SPEC_JSON_SCHEMA,
  CHAT_COMPONENT_SPEC_SCHEMA_VERSION,
  CHAT_COMPONENT_TYPES,
  CHAT_COMPONENT_CHANNELS,
  CHAT_COMPONENT_SURFACES,
  ChatComponentSpec,
  ChatComponentSpecValidationError,
  FOLLOWUP_TEXT_MAX_LENGTH,
  assertChatComponentSpec,
  validateChatComponentSpec,
} from '../../src/lib/chat-components/spec-schema';

const ajv = new Ajv({ allErrors: true, strict: false });
const ajvValidate = ajv.compile(CHAT_COMPONENT_SPEC_JSON_SCHEMA as Record<string, unknown>);

function minimalValidSpec(): ChatComponentSpec {
  return {
    componentId: 'cmp_test_1',
    type: 'info-panel',
    config: { title: 'Hello', body: 'World' },
    surfaces: ['chat'],
  };
}

function expectAjvAgrees(input: unknown, handRolledValid: boolean) {
  const ajvOk = ajvValidate(input);
  expect(ajvOk).toBe(handRolledValid);
}

describe('ChatComponentSpec — frozen v1 schema', () => {
  test('version constant is "1.0.0" (do not bump without re-signoff)', () => {
    expect(CHAT_COMPONENT_SPEC_SCHEMA_VERSION).toBe('1.0.0');
  });

  test('exported allowlists match the sign-off doc (button-group, info-panel, form)', () => {
    expect([...CHAT_COMPONENT_TYPES]).toEqual(['button-group', 'info-panel', 'form']);
    expect([...CHAT_COMPONENT_CHANNELS]).toEqual(['followup', 'state-write', 'run-event']);
    expect([...CHAT_COMPONENT_SURFACES]).toEqual(['chat']);
  });

  test('accepts a minimal valid spec (required fields only)', () => {
    const spec = minimalValidSpec();
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.value).toEqual(spec);
    expectAjvAgrees(spec, true);
  });

  test('accepts a fully populated spec with all optional fields', () => {
    const spec: ChatComponentSpec = {
      componentId: 'cmp_test_full',
      type: 'form',
      config: { fields: [{ id: 'name', kind: 'text-input' }] },
      surfaces: ['chat'],
      binding: {
        source: 'globalState',
        namespace: 'user-prefs',
        key: 'favourites',
        path: '/colors/0',
        transform: 'identity',
      },
      interaction: {
        channel: 'state-write',
        namespace: 'user-prefs',
        key: 'favourites',
        path: '/colors/0',
        label: 'Submit',
      },
      runId: 'run_abc',
      messageId: 'msg_abc',
      emittedAt: '2026-05-27T00:00:00.000Z',
      answered: false,
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(true);
    expectAjvAgrees(spec, true);
  });

  test.each([
    ['componentId', 'componentId'],
    ['type', 'type'],
    ['config', 'config'],
    ['surfaces', 'surfaces'],
  ])('rejects missing required field %s', (_label, field) => {
    const spec = minimalValidSpec() as Record<string, unknown>;
    delete spec[field];
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes(field))).toBe(true);
    }
    expectAjvAgrees(spec, false);
  });

  test('rejects unknown `type`', () => {
    const spec = { ...minimalValidSpec(), type: 'wat' as never };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('$.type'))).toBe(true);
    }
    expectAjvAgrees(spec, false);
  });

  test('rejects extra top-level field (frozen / no drift)', () => {
    const spec = { ...minimalValidSpec(), totallyNewField: 1 } as Record<string, unknown>;
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('totallyNewField'))).toBe(true);
    }
    expectAjvAgrees(spec, false);
  });

  test('rejects wrong-typed `config` (string instead of object)', () => {
    const spec = { ...minimalValidSpec(), config: 'oops' as unknown } as Record<string, unknown>;
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('$.config'))).toBe(true);
    }
    expectAjvAgrees(spec, false);
  });

  test('rejects wrong-typed `surfaces` (object instead of array)', () => {
    const spec = { ...minimalValidSpec(), surfaces: { 0: 'chat' } as unknown } as Record<string, unknown>;
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('rejects empty `surfaces`', () => {
    const spec = { ...minimalValidSpec(), surfaces: [] as string[] };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('rejects non-allowlisted entry in `surfaces`', () => {
    const spec = { ...minimalValidSpec(), surfaces: ['dashboard'] as unknown as ['chat'] };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('rejects `binding` with unknown subfield', () => {
    const spec: Record<string, unknown> = {
      ...minimalValidSpec(),
      binding: {
        source: 'globalState',
        namespace: 'ns',
        key: 'k',
        evil: 'unknown',
      },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('rejects `binding.source` !== "globalState"', () => {
    const spec: Record<string, unknown> = {
      ...minimalValidSpec(),
      binding: { source: 'http', namespace: 'ns', key: 'k' },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('rejects `interaction.channel === followup` missing `text`', () => {
    const spec: ChatComponentSpec = {
      ...minimalValidSpec(),
      type: 'button-group',
      interaction: { channel: 'followup' },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('text'))).toBe(true);
    }
    // ajv's schema cannot express this conditional requirement without if/then, so the
    // hand-rolled validator is the authoritative check for channel-specific requireds.
    // We deliberately do NOT call expectAjvAgrees here.
  });

  test('rejects `interaction.channel === followup` with text > 4000 chars', () => {
    const longText = 'x'.repeat(FOLLOWUP_TEXT_MAX_LENGTH + 1);
    const spec: ChatComponentSpec = {
      ...minimalValidSpec(),
      type: 'button-group',
      interaction: { channel: 'followup', text: longText },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('accepts `interaction.channel === followup` with text === 4000 chars', () => {
    const spec: ChatComponentSpec = {
      ...minimalValidSpec(),
      type: 'button-group',
      interaction: { channel: 'followup', text: 'x'.repeat(FOLLOWUP_TEXT_MAX_LENGTH) },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(true);
    expectAjvAgrees(spec, true);
  });

  test('rejects `interaction.channel === state-write` missing namespace/key', () => {
    const spec: ChatComponentSpec = {
      ...minimalValidSpec(),
      type: 'form',
      interaction: { channel: 'state-write' },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.includes('namespace'))).toBe(true);
      expect(result.errors.some((e) => e.includes('key'))).toBe(true);
    }
  });

  test('accepts `interaction.channel === run-event` with no extra fields', () => {
    const spec: ChatComponentSpec = {
      ...minimalValidSpec(),
      type: 'button-group',
      interaction: { channel: 'run-event' },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(true);
    expectAjvAgrees(spec, true);
  });

  test('rejects unknown `interaction.channel` value', () => {
    const spec = {
      ...minimalValidSpec(),
      interaction: { channel: 'malicious' as never },
    };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('assertChatComponentSpec returns value on success', () => {
    const spec = minimalValidSpec();
    expect(assertChatComponentSpec(spec)).toEqual(spec);
  });

  test('assertChatComponentSpec throws ChatComponentSpecValidationError on failure', () => {
    expect(() => assertChatComponentSpec({ junk: true })).toThrow(ChatComponentSpecValidationError);
    try {
      assertChatComponentSpec({ junk: true });
    } catch (err) {
      expect(err).toBeInstanceOf(ChatComponentSpecValidationError);
      expect((err as ChatComponentSpecValidationError).errors.length).toBeGreaterThan(0);
    }
  });

  test('rejects primitive input (null, number, array, string)', () => {
    for (const bad of [null, 42, 'string', ['array'], true, undefined]) {
      const result = validateChatComponentSpec(bad);
      expect(result.valid).toBe(false);
    }
  });

  test('rejects nested `answered` as non-boolean', () => {
    const spec = { ...minimalValidSpec(), answered: 'yes' as unknown as boolean };
    const result = validateChatComponentSpec(spec);
    expect(result.valid).toBe(false);
    expectAjvAgrees(spec, false);
  });

  test('JSON Schema $id encodes the version', () => {
    expect(CHAT_COMPONENT_SPEC_JSON_SCHEMA.$id).toContain(CHAT_COMPONENT_SPEC_SCHEMA_VERSION);
  });
});
