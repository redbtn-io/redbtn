/**
 * Build-messages operation — multimodal-safe.
 *
 * Extracted from transformExecutor.ts so it can be unit-tested without
 * dragging in the executor file's eager runtime-only require (the
 * dist-only globalState client). Takes its template/lookup helpers as
 * injected dependencies so the test can supply stubs.
 *
 * Two modes:
 *   1. `config.useExistingField` set → return that state field directly
 *      (must already be an array).
 *   2. Otherwise → build from `config.messages`, rendering string content
 *      via the injected renderTemplate. Array content (parts arrays for
 *      multimodal messages) is forwarded untouched.
 */

import type { TransformStepConfig } from '../types';

export interface BuildMessagesDeps {
  renderTemplate: (template: string, state: any) => string;
  getNestedProperty: (obj: any, path: string) => any;
}

export function executeBuildMessagesOperation(
  config: TransformStepConfig,
  state: any,
  deps: BuildMessagesDeps,
): Array<{ role: string; content: string | unknown[] }> {
  // Mode 1: Use existing field if specified
  if (config.useExistingField) {
    const existingMessages = deps.getNestedProperty(state, config.useExistingField);
    if (existingMessages !== undefined) {
      if (!Array.isArray(existingMessages)) {
        throw new Error(`useExistingField ${config.useExistingField} is not an array`);
      }
      return existingMessages;
    }
    // If useExistingField is set but field doesn't exist, fall through to build from messages
  }

  // Mode 2: Build from messages array
  if (!config.messages || config.messages.length === 0) {
    throw new Error('build-messages operation requires either messages array or useExistingField');
  }

  const builtMessages: Array<{ role: string; content: string | unknown[] }> = [];
  for (const message of config.messages) {
    if (!message.role || !message.content) {
      throw new Error('Each message must have role and content properties');
    }
    // Multimodal-safe passthrough: when content is already a parts array
    // (e.g. a template that pre-assembled image_url + text parts), forward
    // it untouched. renderTemplate would otherwise stringify the array.
    if (Array.isArray(message.content)) {
      builtMessages.push({
        role: message.role,
        content: message.content as unknown[],
      });
      continue;
    }
    // String path — render templates as before.
    const renderedContent = deps.renderTemplate(message.content, state);
    builtMessages.push({
      role: message.role,
      content: renderedContent,
    });
  }
  return builtMessages;
}
