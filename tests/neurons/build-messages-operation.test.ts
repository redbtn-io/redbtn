/**
 * Phase 6 — media-normalize-messages-multimodal (build-messages half)
 *
 * Tests the parts-array passthrough in executeBuildMessagesOperation so
 * the build-messages transform step can forward a multimodal user message
 * (content = [{ type:'image_url', ... }, { type:'text', ... }]) untouched
 * instead of stringifying it via renderTemplate.
 */

import { describe, it, expect, vi } from 'vitest';
import { executeBuildMessagesOperation } from '../../src/lib/nodes/universal/executors/buildMessagesOperation';

const noopRender = (template: string, _state: any) => template; // identity
const noopGet = (obj: any, path: string) => {
  // Minimal dot-path resolver — only used by the useExistingField branch.
  return path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), obj);
};

describe('executeBuildMessagesOperation — text path', () => {
  it('renders string content via renderTemplate (existing behavior, regression target)', () => {
    const renderTemplate = vi.fn((tpl: string) => tpl.replace('{{x}}', 'WORLD'));
    const out = executeBuildMessagesOperation(
      { operation: 'build-messages', messages: [
        { role: 'system', content: 'hello {{x}}' },
        { role: 'user', content: 'plain' },
      ] } as any,
      {},
      { renderTemplate, getNestedProperty: noopGet },
    );
    expect(out).toEqual([
      { role: 'system', content: 'hello WORLD' },
      { role: 'user', content: 'plain' },
    ]);
    expect(renderTemplate).toHaveBeenCalledTimes(2);
  });

  it('throws when neither useExistingField nor messages is supplied', () => {
    expect(() =>
      executeBuildMessagesOperation(
        { operation: 'build-messages' } as any,
        {},
        { renderTemplate: noopRender, getNestedProperty: noopGet },
      ),
    ).toThrow(/requires either messages array or useExistingField/);
  });

  it('throws when a message is missing role or content', () => {
    expect(() =>
      executeBuildMessagesOperation(
        { operation: 'build-messages', messages: [{ role: '', content: 'x' }] } as any,
        {},
        { renderTemplate: noopRender, getNestedProperty: noopGet },
      ),
    ).toThrow(/role and content/);
  });
});

describe('executeBuildMessagesOperation — multimodal-safe parts array passthrough', () => {
  it('forwards a parts array untouched (does NOT call renderTemplate on it)', () => {
    const renderTemplate = vi.fn();
    const imagePart = { type: 'image_url', image_url: { url: 'https://x/p.jpg' } };
    const textPart = { type: 'text', text: 'describe this' };
    const out = executeBuildMessagesOperation(
      {
        operation: 'build-messages',
        messages: [
          { role: 'user', content: [imagePart, textPart] as unknown as string },
        ],
      } as any,
      {},
      { renderTemplate, getNestedProperty: noopGet },
    );

    expect(out.length).toBe(1);
    expect(out[0].role).toBe('user');
    expect(Array.isArray(out[0].content)).toBe(true);
    expect(out[0].content).toEqual([imagePart, textPart]);
    // The image_url part is identity-preserved, not deep-cloned.
    expect((out[0].content as Array<unknown>)[0]).toBe(imagePart);
    // renderTemplate was NOT called on the parts array.
    expect(renderTemplate).not.toHaveBeenCalled();
  });

  it('mixes text and parts-array messages in a single build', () => {
    const renderTemplate = vi.fn((tpl: string) => tpl);
    const imagePart = { type: 'image_url', image_url: { url: 'u' } };
    const out = executeBuildMessagesOperation(
      {
        operation: 'build-messages',
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: [imagePart, { type: 'text', text: 'caption' }] as unknown as string },
        ],
      } as any,
      {},
      { renderTemplate, getNestedProperty: noopGet },
    );
    expect(out).toEqual([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: [imagePart, { type: 'text', text: 'caption' }] },
    ]);
    // renderTemplate fired exactly once — for the system string message.
    expect(renderTemplate).toHaveBeenCalledTimes(1);
    expect(renderTemplate).toHaveBeenCalledWith('be brief', {});
  });
});

describe('executeBuildMessagesOperation — useExistingField branch', () => {
  it('returns the state field directly when useExistingField is set and resolves to an array', () => {
    const imagePart = { type: 'image_url', image_url: { url: 'u' } };
    const preBuilt = [
      { role: 'system', content: 'pre-built system' },
      { role: 'user', content: [imagePart] },
    ];
    const out = executeBuildMessagesOperation(
      { operation: 'build-messages', useExistingField: 'data.messages' } as any,
      { data: { messages: preBuilt } },
      { renderTemplate: noopRender, getNestedProperty: noopGet },
    );
    expect(out).toBe(preBuilt as any); // identity preserved
  });

  it('throws when useExistingField resolves to a non-array', () => {
    expect(() =>
      executeBuildMessagesOperation(
        { operation: 'build-messages', useExistingField: 'data.messages' } as any,
        { data: { messages: 'not-an-array' } },
        { renderTemplate: noopRender, getNestedProperty: noopGet },
      ),
    ).toThrow(/not an array/);
  });

  it('falls through to build-from-messages when useExistingField is unset in state', () => {
    const out = executeBuildMessagesOperation(
      {
        operation: 'build-messages',
        useExistingField: 'data.absent',
        messages: [{ role: 'user', content: 'fallback' }],
      } as any,
      { data: {} },
      { renderTemplate: noopRender, getNestedProperty: noopGet },
    );
    expect(out).toEqual([{ role: 'user', content: 'fallback' }]);
  });
});
