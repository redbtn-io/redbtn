/**
 * Delete State Record — Native Tool
 *
 * Deletes one record via
 * `DELETE /api/state/namespaces/:namespace/records/:recordId`.
 *
 * Deleting a record that isn't there is reported as `{ ok: true, deleted: false }`
 * rather than an error: the caller's intent ("this should not exist") is
 * satisfied either way, and an agent retrying a delete shouldn't have to
 * distinguish "I already did this" from a real failure.
 *
 * Scope is per-record. There is deliberately no bulk/filter delete in this
 * slice — "delete everything matching this filter" is exactly the operation you
 * want a human to have thought about first.
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

const deleteStateRecordTool: NativeToolDefinition = {
  description:
    'Delete a single State Record by its recordId. Idempotent — deleting a record that no longer exists reports deleted: false rather than failing.',
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
        description: 'The record ID to delete.',
      },
    },
    required: ['namespace', 'recordId'],
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

    const result = await recordsFetch({
      method: 'DELETE',
      url: recordUrl(namespace, recordId),
      context,
      notFoundValue: { ok: true, deleted: false, recordId },
    });

    if (!result.ok) return result.result;

    return toolOk({ ok: true, deleted: true, recordId });
  },
};

export default deleteStateRecordTool;
module.exports = deleteStateRecordTool;
