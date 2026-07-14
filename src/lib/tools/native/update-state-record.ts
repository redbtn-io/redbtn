/**
 * Update State Record — Native Tool
 *
 * Replaces one record via `PUT /api/state/namespaces/:namespace/records/:recordId`.
 *
 * This is a full REPLACE, not a merge: the record ends up as exactly the `data`
 * you send. Read it first if you only mean to change part of it. (A merge-patch
 * over a body the model can't see is the kind of operation an agent gets subtly
 * wrong, so the API doesn't offer one.)
 *
 * Omitting `ttlSeconds` clears any existing expiry, for the same reason.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  recordUrl,
  recordsFetch,
  requiredString,
  toolError,
  toolOk,
} from '../state-records-http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const updateStateRecordTool: NativeToolDefinition = {
  description:
    'Replace an existing State Record. This overwrites the record body entirely — read it with get_state_record first if you only mean to change part of it. Common use: marking a record handled/resolved.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace the record belongs to.',
      },
      recordId: {
        type: 'string',
        description: 'The record ID to replace.',
      },
      data: {
        type: 'object',
        description:
          'The COMPLETE new record body. Replaces the old one — anything you omit is gone.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'The complete new tag list. Omit to clear the tags.',
      },
      ttlSeconds: {
        type: 'integer',
        description:
          'Optional new time-to-live in seconds. Omit to clear any existing expiry.',
        minimum: 1,
      },
    },
    required: ['namespace', 'recordId', 'data'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const namespace = requiredString(rawArgs.namespace);
    if (!namespace) {
      return toolError('namespace is required and must be a non-empty string');
    }

    const recordId = requiredString(rawArgs.recordId);
    if (!recordId) {
      return toolError('recordId is required and must be a non-empty string');
    }

    const data = rawArgs.data;
    if (data === undefined || data === null) {
      return toolError('data is required (the full replacement record body)');
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
      return toolError('data must be a JSON object');
    }

    const result = await recordsFetch({
      method: 'PUT',
      url: recordUrl(namespace, recordId),
      context,
      body: {
        data,
        ...(Array.isArray(rawArgs.tags) ? { tags: rawArgs.tags } : {}),
        ...(rawArgs.ttlSeconds !== undefined ? { ttlSeconds: rawArgs.ttlSeconds } : {}),
      },
    });

    if (!result.ok) return result.result;

    return toolOk({ ok: true, record: result.data?.record ?? null });
  },
};

export default updateStateRecordTool;
module.exports = updateStateRecordTool;
