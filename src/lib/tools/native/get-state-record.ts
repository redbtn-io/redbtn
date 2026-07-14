/**
 * Get State Record — Native Tool
 *
 * Reads one record via `GET /api/state/namespaces/:namespace/records/:recordId`.
 *
 * A missing record is a normal `{ found: false }` result, not a tool error —
 * "check whether this exists" is a legitimate question, and failing the call
 * would make an agent treat an ordinary miss as something to recover from.
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

const getStateRecordTool: NativeToolDefinition = {
  description:
    'Read a single State Record by its recordId. Returns { found: false } if it does not exist in this namespace.',
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
        description: 'The record ID (e.g. "rec_1a2b3c..."), as returned by create_state_record.',
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
      method: 'GET',
      url: recordUrl(namespace, recordId),
      context,
      notFoundValue: { found: false, record: null },
    });

    if (!result.ok) return result.result;

    return toolOk({ found: true, record: result.data?.record ?? null });
  },
};

export default getStateRecordTool;
module.exports = getStateRecordTool;
