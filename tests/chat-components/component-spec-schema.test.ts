/**
 * @file ChatComponentSpec schema — frozen-contract tests.
 *
 * Locks the v1 contract in two layers:
 *
 * 1. Behavioural — every known-good fixture parses with `validateChatComponentSpec`;
 *    every known-bad fixture is rejected with an error referencing the offending
 *    field. This is the engine-side validator the `emit_component` tool will use.
 *
 * 2. Structural parity — the static JSON Schema constant is checked against the
 *    behavioural source of truth: enums match, required keys match, closed shapes
 *    have `additionalProperties: false`. Locking these structural invariants
 *    keeps the JSON Schema (used by ajv on the client) in lockstep with the
 *    zod schema (used by the engine) — drift on either side fails the test.
 */

import { describe, test, expect } from 'vitest';
import {
  CHAT_COMPONENT_TYPES,
  CHAT_COMPONENT_INTERACTION_CHANNELS,
  CHAT_COMPONENT_SPEC_SCHEMA,
  validateChatComponentSpec,
  type ChatComponentSpec,
} from '../../src/lib/chat-components/component-spec-schema';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function goodMinimal(): ChatComponentSpec {
  return {
    componentId: 'c-1',
    type: 'info-panel',
    config: { title: 'Hello', body: 'World' },
    surfaces: ['chat'],
    provenance: { runId: 'r-1' },
  };
}

function goodButtonGroupWithFollowup(): ChatComponentSpec {
  return {
    componentId: 'c-2',
    type: 'button-group',
    config: {
      buttons: [
        { label: 'Yes', value: 'yes' },
        { label: 'No', value: 'no' },
      ],
    },
    interaction: { channel: 'followup', followupTemplate: '{{label}}' },
    surfaces: ['chat'],
    provenance: { runId: 'r-2', messageId: 'm-2' },
  };
}

function goodFormWithStateWrite(): ChatComponentSpec {
  return {
    componentId: 'c-3',
    type: 'form',
    config: { fields: [{ name: 'username', type: 'text' }] },
    binding: { source: 'globalState', namespace: 'profile', key: 'main' },
    interaction: {
      channel: 'state-write',
      writeNamespace: 'profile',
      writeKey: 'main',
      writePath: '/username',
    },
    surfaces: ['chat', 'dashboard'],
    provenance: { runId: 'r-3', nodeId: 'n-3' },
  };
}

function goodWithRespondedReplay(): ChatComponentSpec {
  return {
    ...goodButtonGroupWithFollowup(),
    componentId: 'c-4',
    responded: {
      at: '2026-05-20T12:00:00.000Z',
      by: 'user-abc',
      via: 'followup',
      summary: 'Yes',
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Behavioural: known-good acceptance
// ---------------------------------------------------------------------------

describe('validateChatComponentSpec — accepts known-good fixtures', () => {
  test('minimal info-panel (display-only, no interaction, no binding)', () => {
    const r = validateChatComponentSpec(goodMinimal());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.type).toBe('info-panel');
  });

  test('button-group with followup interaction', () => {
    const r = validateChatComponentSpec(goodButtonGroupWithFollowup());
    expect(r.ok).toBe(true);
  });

  test('form with state-write interaction + binding', () => {
    const r = validateChatComponentSpec(goodFormWithStateWrite());
    expect(r.ok).toBe(true);
  });

  test('replayed spec with responded field populated', () => {
    const r = validateChatComponentSpec(goodWithRespondedReplay());
    expect(r.ok).toBe(true);
  });

  test('every allowlisted type passes with a minimal spec', () => {
    for (const t of CHAT_COMPONENT_TYPES) {
      const spec: ChatComponentSpec = {
        componentId: `c-${t}`,
        type: t,
        config: {},
        surfaces: ['chat'],
        provenance: { runId: 'r' },
      };
      const r = validateChatComponentSpec(spec);
      expect(r.ok, `${t} should validate`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Behavioural: known-bad rejection
// ---------------------------------------------------------------------------

describe('validateChatComponentSpec — rejects malformed / off-allowlist specs', () => {
  test('rejects unknown type', () => {
    const bad = { ...goodMinimal(), type: 'arbitrary-html' as never };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/type/);
  });

  test('rejects spec without "chat" in surfaces', () => {
    const bad = { ...goodMinimal(), surfaces: ['dashboard'] };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/surfaces/);
  });

  test('rejects empty surfaces array', () => {
    const bad = { ...goodMinimal(), surfaces: [] };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
  });

  test('rejects missing provenance', () => {
    const { provenance: _omit, ...rest } = goodMinimal();
    void _omit;
    const r = validateChatComponentSpec(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/provenance/);
  });

  test('rejects state-write interaction without writeNamespace/writeKey', () => {
    const bad = {
      ...goodMinimal(),
      type: 'form' as const,
      interaction: { channel: 'state-write' as const },
    };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/write/);
  });

  test('rejects followup interaction without followupTemplate', () => {
    const bad = {
      ...goodMinimal(),
      type: 'button-group' as const,
      interaction: { channel: 'followup' as const },
    };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(/followup/);
  });

  test('rejects unknown top-level key (closed shape)', () => {
    const bad = { ...goodMinimal(), arbitrary: { evil: true } };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
  });

  test('rejects unknown key inside interaction (closed shape)', () => {
    const bad = {
      ...goodMinimal(),
      type: 'button-group' as const,
      interaction: {
        channel: 'followup' as const,
        followupTemplate: 'hi',
        executeJs: 'alert(1)',
      } as unknown,
    };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
  });

  test('rejects empty componentId', () => {
    const bad = { ...goodMinimal(), componentId: '' };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
  });

  test('rejects binding with non-globalState source', () => {
    const bad = {
      ...goodMinimal(),
      binding: { source: 'env' as unknown, namespace: 'x', key: 'y' },
    };
    const r = validateChatComponentSpec(bad);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Structural parity: JSON Schema constant locked to the source of truth
// ---------------------------------------------------------------------------

describe('CHAT_COMPONENT_SPEC_SCHEMA — structural parity with zod source of truth', () => {
  test('schema is Draft-07 and has the contract $id', () => {
    expect(CHAT_COMPONENT_SPEC_SCHEMA.$schema).toBe(
      'http://json-schema.org/draft-07/schema#',
    );
    expect(CHAT_COMPONENT_SPEC_SCHEMA.$id).toContain('chat-component-spec');
  });

  test('top-level required keys match the engine-side contract', () => {
    expect(CHAT_COMPONENT_SPEC_SCHEMA.required).toEqual([
      'componentId',
      'type',
      'config',
      'surfaces',
      'provenance',
    ]);
  });

  test('top-level is a closed object', () => {
    expect(CHAT_COMPONENT_SPEC_SCHEMA.additionalProperties).toBe(false);
  });

  test('type enum matches CHAT_COMPONENT_TYPES exactly', () => {
    const typeNode = CHAT_COMPONENT_SPEC_SCHEMA.properties.type as { enum: string[] };
    expect(typeNode.enum).toEqual([...CHAT_COMPONENT_TYPES]);
  });

  test('interaction.channel enum matches CHAT_COMPONENT_INTERACTION_CHANNELS', () => {
    const interactionNode =
      CHAT_COMPONENT_SPEC_SCHEMA.properties.interaction as {
        properties: { channel: { enum: string[] } };
        additionalProperties: boolean;
      };
    expect(interactionNode.properties.channel.enum).toEqual([
      ...CHAT_COMPONENT_INTERACTION_CHANNELS,
    ]);
    expect(interactionNode.additionalProperties).toBe(false);
  });

  test('binding subschema is a closed object with source=globalState', () => {
    const bindingNode = CHAT_COMPONENT_SPEC_SCHEMA.properties.binding as {
      additionalProperties: boolean;
      required: string[];
      properties: { source: { const: string } };
    };
    expect(bindingNode.additionalProperties).toBe(false);
    expect(bindingNode.required).toEqual(['source', 'namespace', 'key']);
    expect(bindingNode.properties.source.const).toBe('globalState');
  });

  test('surfaces must be a non-empty array containing "chat"', () => {
    const surfaces = CHAT_COMPONENT_SPEC_SCHEMA.properties.surfaces as {
      type: string;
      minItems: number;
      contains: { const: string };
    };
    expect(surfaces.type).toBe('array');
    expect(surfaces.minItems).toBe(1);
    expect(surfaces.contains.const).toBe('chat');
  });

  test('provenance subschema requires runId and is closed', () => {
    const prov = CHAT_COMPONENT_SPEC_SCHEMA.properties.provenance as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(prov.additionalProperties).toBe(false);
    expect(prov.required).toEqual(['runId']);
  });

  test('responded subschema requires at/by/via and is closed', () => {
    const r = CHAT_COMPONENT_SPEC_SCHEMA.properties.responded as {
      additionalProperties: boolean;
      required: string[];
    };
    expect(r.additionalProperties).toBe(false);
    expect(r.required).toEqual(['at', 'by', 'via']);
  });
});
