/**
 * Create State Record — Native Tool
 *
 * Appends one record to a namespace's record store via
 * `POST /api/state/namespaces/:namespace/records`.
 *
 * State Records are the append-and-query half of Global State: one document per
 * record, individually searchable, with no shared size ceiling. Use them when a
 * namespace is accumulating a growing LIST of things (events, observations,
 * findings) rather than a handful of named settings — `set_global_state` is
 * still the right tool for the latter.
 *
 * The namespace is created on first write with the caller as owner, so an agent
 * does not have to provision anything before logging its first record.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  recordsUrl,
  recordsFetch,
  requiredString,
  toolError,
  toolOk,
} from '../state-records-http';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

const createStateRecordTool: NativeToolDefinition = {
  description:
    'Append a record to a namespace\'s State Records store. Use for a growing list of individually-searchable items (events, errors, observations, findings) that you will want to query later — not for a handful of settings (use set_global_state for those). Returns the new recordId.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to append to (created on first write if absent).',
      },
      data: {
        // Object-only: the query language addresses record fields as `data.<path>`,
        // so a scalar body would be storable but not searchable.
        type: 'object',
        description:
          'The record body — a JSON object (e.g. { "level": "error", "message": "...", "service": "worker" }). Wrap scalars/arrays in an object.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Optional flat labels for cheap filtering (e.g. ["prod", "billing"]). Max 20.',
      },
      ttlSeconds: {
        type: 'integer',
        description:
          'Optional time-to-live in seconds. The record is automatically deleted after this long.',
        minimum: 1,
      },
    },
    required: ['namespace', 'data'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const namespace = requiredString(rawArgs.namespace);
    if (!namespace) {
      return toolError('namespace is required and must be a non-empty string');
    }

    const data = rawArgs.data;
    if (data === undefined || data === null) {
      return toolError('data is required');
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
      return toolError(
        'data must be a JSON object (wrap scalars/arrays, e.g. { "items": [...] })',
      );
    }

    const result = await recordsFetch({
      method: 'POST',
      url: recordsUrl(namespace),
      context,
      body: {
        data,
        ...(Array.isArray(rawArgs.tags) ? { tags: rawArgs.tags } : {}),
        ...(rawArgs.ttlSeconds !== undefined ? { ttlSeconds: rawArgs.ttlSeconds } : {}),
      },
    });

    if (!result.ok) return result.result;

    const record = result.data?.record ?? {};
    return toolOk({ ok: true, recordId: record.recordId, record });
  },
};

export default createStateRecordTool;
module.exports = createStateRecordTool;
