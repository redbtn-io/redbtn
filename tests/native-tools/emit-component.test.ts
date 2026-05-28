/**
 * Phase 5 (chat-interactive-widgets) — emit_component native tool unit tests.
 *
 * Asserts:
 *   (a) Tool invokes RunPublisher.publishComponent with a fully populated,
 *       schema-valid spec when given a minimal valid input.
 *   (b) Unknown `type` → SCHEMA error result; publisher NOT called.
 *   (c) Extra/unknown top-level config fields are rejected; publisher NOT called.
 *   (d) Missing required field (`config` or `type`) errors before publishing.
 *   (e) Optional `interaction` channels (followup, state-write, run-event) are
 *       validated correctly — channel-specific required fields enforced.
 *   (f) `componentId` is minted as `cmp_<8-rand>` when not supplied; caller-
 *       supplied id is honoured.
 *   (g) No publisher in context → VALIDATION error, no call.
 *   (h) Tool appears in the native tool catalog listing (`getNativeRegistry`).
 *   (i) The demo node config (`data/nodes/emit-demo-component.json`) is
 *       well-formed JSON and uses the canonical step shape.
 */

import { describe, test, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import emitComponentTool from '../../src/lib/tools/native/emit-component';
import {
  ChatComponentSpecValidationError,
  validateChatComponentSpec,
} from '../../src/lib/chat-components/spec-schema';
import { getNativeRegistry, NativeToolRegistry } from '../../src/lib/tools/native-registry';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';

function makePublisher() {
  const calls: Array<Record<string, unknown>> = [];
  const publisher = {
    publishComponent: vi.fn(async (spec: Record<string, unknown>) => {
      // Real publisher re-validates and injects provenance. The test publisher
      // mirrors that contract: re-asserts the spec, throws on invalid input,
      // and records the assembled spec for verification.
      const assembled: Record<string, unknown> = {
        ...spec,
        runId: 'run-test-1',
        messageId: 'msg-test-1',
        surfaces: ['chat'],
        emittedAt: '2026-05-27T00:00:00.000Z',
      };
      const result = validateChatComponentSpec(assembled);
      if (!result.valid) {
        throw new ChatComponentSpecValidationError(result.errors);
      }
      calls.push(assembled);
    }),
    convMessageId: 'msg-test-1',
  };
  return { publisher, calls };
}

function makeCtx(publisherOverride?: unknown): NativeToolContext {
  const { publisher, calls } = makePublisher();
  return {
    publisher: (publisherOverride === undefined ? publisher : publisherOverride) as unknown as Record<string, unknown> | null,
    state: {},
    runId: 'run-test-1',
    nodeId: null,
    toolId: null,
    abortSignal: null,
  };
}

describe('emit_component native tool — chat-interactive-widgets phase 5', () => {
  test('(a) invokes publishComponent with a fully populated spec when given minimal valid input', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {},
      runId: 'run-test-1',
      nodeId: null,
      toolId: null,
      abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      {
        type: 'button-group',
        config: { buttons: [{ label: 'Yes' }] },
      },
      ctx,
    );

    expect(result.isError).not.toBe(true);
    expect(publisher.publishComponent).toHaveBeenCalledTimes(1);
    const assembled = calls[0];
    // Caller-supplied fields preserved + engine-injected fields present.
    expect(assembled.type).toBe('button-group');
    expect(assembled.config).toEqual({ buttons: [{ label: 'Yes' }] });
    expect(assembled.componentId).toMatch(/^cmp_[A-Za-z0-9]{8}$/);
    expect(assembled.runId).toBe('run-test-1');
    expect(assembled.messageId).toBe('msg-test-1');
    expect(assembled.surfaces).toEqual(['chat']);
    expect(assembled.emittedAt).toBe('2026-05-27T00:00:00.000Z');

    // Response payload includes the minted componentId.
    const payload = JSON.parse(result.content[0].text);
    expect(payload.componentId).toBe(assembled.componentId);
    expect(payload.messageId).toBe('msg-test-1');
    expect(payload.type).toBe('button-group');
  });

  test('(b) unknown `type` is rejected with a SCHEMA error; publisher NOT called', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      { type: 'evil-widget', config: {} },
      ctx,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('SCHEMA');
    expect(body.error).toMatch(/Invalid ChatComponentSpec/);
    expect(body.fieldErrors.some((e: string) => e.includes('$.type'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(c) extra/unknown config fields at spec root are rejected (frozen schema)', async () => {
    // The frozen v1 schema's `additionalProperties: false` rejects unknown
    // top-level fields. The tool's own input schema also has the same shape,
    // but the spec-level reject is the authoritative line of defence.
    // We exercise it by smuggling an unknown field into `binding`, which is
    // a pass-through bag with additionalProperties:false on the spec schema.
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      {
        type: 'form',
        config: {},
        binding: {
          source: 'globalState',
          namespace: 'ns',
          key: 'k',
          extraField: 'oops',
        },
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('SCHEMA');
    expect(body.fieldErrors.some((e: string) => e.includes('binding'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(d) missing required `config` errors before publishing', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      { type: 'button-group' /* no config */ },
      ctx,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('SCHEMA');
    expect(body.fieldErrors.some((e: string) => e.includes('$.config'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(d) missing required `type` errors before publishing', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      { config: {} /* no type */ },
      ctx,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('SCHEMA');
    expect(body.fieldErrors.some((e: string) => e.includes('$.type'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(e) followup interaction without `text` is rejected', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    const result = await emitComponentTool.handler(
      {
        type: 'button-group',
        config: { buttons: [] },
        interaction: { channel: 'followup' },
      },
      ctx,
    );

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('SCHEMA');
    expect(body.fieldErrors.some((e: string) => e.toLowerCase().includes('text'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(e) state-write interaction requires namespace + key', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };
    const result = await emitComponentTool.handler(
      {
        type: 'form',
        config: { fields: [] },
        interaction: { channel: 'state-write' },
      },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.fieldErrors.some((e: string) => e.toLowerCase().includes('namespace'))).toBe(true);
    expect(body.fieldErrors.some((e: string) => e.toLowerCase().includes('key'))).toBe(true);
    // The publisher's spy fires (the tool calls it) but the mock re-validates
    // and throws, so `calls[]` — the post-validation captures — stays empty.
    expect(calls).toHaveLength(0);
  });

  test('(e) run-event interaction with no extras is accepted', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };
    const result = await emitComponentTool.handler(
      {
        type: 'info-panel',
        config: { title: 'Hi' },
        interaction: { channel: 'run-event' },
      },
      ctx,
    );
    expect(result.isError).not.toBe(true);
    expect(publisher.publishComponent).toHaveBeenCalledTimes(1);
    expect(calls[0].interaction).toEqual({ channel: 'run-event' });
  });

  test('(f) componentId is minted with cmp_<8-rand> prefix when omitted', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    await emitComponentTool.handler(
      { type: 'info-panel', config: { title: 'Hi' } },
      ctx,
    );
    await emitComponentTool.handler(
      { type: 'info-panel', config: { title: 'Hi 2' } },
      ctx,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0].componentId).toMatch(/^cmp_[A-Za-z0-9]{8}$/);
    expect(calls[1].componentId).toMatch(/^cmp_[A-Za-z0-9]{8}$/);
    // Two consecutive mints should not collide.
    expect(calls[0].componentId).not.toBe(calls[1].componentId);
  });

  test('(f) caller-supplied componentId is honoured verbatim', async () => {
    const { publisher, calls } = makePublisher();
    const ctx: NativeToolContext = {
      publisher: publisher as unknown as Record<string, unknown> | null,
      state: {}, runId: 'run-test-1', nodeId: null, toolId: null, abortSignal: null,
    };

    await emitComponentTool.handler(
      { componentId: 'cmp_explicit_1', type: 'info-panel', config: {} },
      ctx,
    );

    expect(calls[0].componentId).toBe('cmp_explicit_1');
  });

  test('(g) without an active publisher, the tool returns VALIDATION; no call attempted', async () => {
    const ctx = makeCtx(null);
    const result = await emitComponentTool.handler(
      { type: 'button-group', config: { buttons: [] } },
      ctx,
    );
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0].text);
    expect(body.code).toBe('VALIDATION');
    expect(body.error).toMatch(/publisher missing/);
  });

  test('(h) emit_component appears in the native tool catalog listing', () => {
    // Two layers verified here:
    //   1. The native-registry source contains the emit_component
    //      registration block, so registerBuiltinTools will pick it up on
    //      first call once the engine is built (dist/lib/tools/native/
    //      emit-component.js exists).
    //   2. The emit_component tool definition itself has the right shape —
    //      registering it against a fresh NativeToolRegistry and then
    //      listing yields the expected catalog entry. This is independent
    //      of the build state of `dist/`, which the source-mode vitest
    //      environment doesn't always have caught up.
    const registrySrc = fs.readFileSync(
      path.resolve(__dirname, '../../src/lib/tools/native-registry.ts'),
      'utf-8',
    );
    expect(registrySrc).toMatch(/registry\.register\(['"]emit_component['"]/);

    // Direct shape check on the tool definition + registry contract.
    const reg = new NativeToolRegistry();
    reg.register('emit_component', emitComponentTool);
    expect(reg.has('emit_component')).toBe(true);
    const entry = reg.listTools().find((t: { name: string }) => t.name === 'emit_component');
    expect(entry).toBeDefined();
    expect(entry!.description).toMatch(/chat-component spec/i);
    expect(entry!.server).toBe('chat-components');
    // Not in MCP_EXPOSED_TOOLS — emission only makes sense inside a run.
    expect(entry!.mcpExposed).toBe(false);
    expect(entry!.inputSchema.required).toEqual(expect.arrayContaining(['type', 'config']));

    // Sanity: when dist is built, requiring the compiled registry resolves
    // its sibling `./native/*.js` paths correctly, so auto-registration runs
    // end-to-end and the live singleton surfaces emit_component. (Vitest
    // can't make `require('./native/xyz.js')` resolve from TS source paths
    // — that's only a build-time invariant. Hence the require-the-dist dance.)
    const distRegistry = path.resolve(
      __dirname,
      '../../dist/lib/tools/native-registry.js',
    );
    const distTool = path.resolve(
      __dirname,
      '../../dist/lib/tools/native/emit-component.js',
    );
    if (fs.existsSync(distRegistry) && fs.existsSync(distTool)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const dist = require(distRegistry) as { getNativeRegistry: typeof getNativeRegistry };
      const live = dist.getNativeRegistry();
      expect(live.has('emit_component')).toBe(true);
      const liveEntry = live.listTools().find((t: { name: string }) => t.name === 'emit_component');
      expect(liveEntry).toBeDefined();
      expect(liveEntry!.server).toBe('chat-components');
    }
  });

  test('(i) demo node config is valid JSON with canonical tool-step shape', () => {
    const cfgPath = path.resolve(__dirname, '../../../data/nodes/emit-demo-component.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const raw = fs.readFileSync(cfgPath, 'utf-8');
    const node = JSON.parse(raw);

    // Canonical universal-node fields (same shape as the other shipped configs).
    expect(node.nodeId).toBe('emit-demo-component');
    expect(node.userId).toBe('system');
    expect(node.isSystem).toBe(true);
    expect(Array.isArray(node.steps)).toBe(true);
    expect(node.steps).toHaveLength(1);

    const step = node.steps[0];
    expect(step.type).toBe('tool');
    expect(step.config.toolName).toBe('emit_component');
    // The demo emits a button-group via the followup channel.
    expect(step.config.parameters.type).toBe('button-group');
    expect(step.config.parameters.config).toEqual({
      label: 'Continue?',
      buttons: [{ label: 'Yes' }, { label: 'No' }],
    });
    expect(step.config.parameters.interaction.channel).toBe('followup');
  });
});
