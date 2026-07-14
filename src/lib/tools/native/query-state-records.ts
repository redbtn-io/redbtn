/**
 * Query State Records — Native Tool
 *
 * Searches a namespace's record store via
 * `POST /api/state/namespaces/:namespace/records/query`.
 *
 * This is the tool that makes State Records worth having: it answers "have I
 * seen this before?" / "how many happened this month?" WITHOUT loading the
 * namespace. With no filter it simply lists the newest records.
 *
 * The filter is compiled server-side from an allowlist of fields and operators
 * — raw Mongo operators (`$where`, `$or`, …) are refused with a 400, not
 * silently dropped. That error text reaches the model, so a bad filter is
 * self-correcting rather than a silent empty result.
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

const queryStateRecordsTool: NativeToolDefinition = {
  description:
    'Search a namespace\'s State Records. Filter on record fields ("data.*" paths), tags, or timestamps — e.g. answer "have I seen this error before?" or "what happened this month?" without loading everything. Omit the filter to list the newest records.',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'The namespace to search.',
      },
      filter: {
        type: 'object',
        description:
          'Optional filter. Keys are "data.<path>" (into the record body), or one of: tags, recordId, createdBy, createdAt, updatedAt. ' +
          'A bare value means equals; otherwise use an operator object. ' +
          'Operators: eq, ne, gt, gte, lt, lte, in, nin, exists, contains, startsWith. ' +
          'Example: { "data.level": "error", "data.resolvedAt": { "exists": false }, "createdAt": { "gte": "2026-07-01T00:00:00Z" } }. ' +
          'Raw MongoDB operators ($where, $or, ...) are rejected.',
      },
      sortBy: {
        type: 'string',
        description:
          'Field to sort by: createdAt (default), updatedAt, or a "data.*" path.',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction. Default desc (newest first).',
      },
      limit: {
        type: 'integer',
        description: 'Max records to return (default 25, max 100).',
        minimum: 1,
      },
      skip: {
        type: 'integer',
        description: 'Offset for paging through results.',
        minimum: 0,
      },
      includeTotal: {
        type: 'boolean',
        description:
          'Also return the total count of MATCHING records (not just this page). Use when you need "how many", not just the records.',
      },
    },
    required: ['namespace'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const namespace = requiredString(rawArgs.namespace);
    if (!namespace) {
      return toolError('namespace is required and must be a non-empty string');
    }

    if (
      rawArgs.filter !== undefined &&
      rawArgs.filter !== null &&
      (typeof rawArgs.filter !== 'object' || Array.isArray(rawArgs.filter))
    ) {
      return toolError('filter must be an object');
    }

    const result = await recordsFetch({
      method: 'POST',
      url: recordsUrl(namespace, '/query'),
      context,
      body: {
        ...(rawArgs.filter ? { filter: rawArgs.filter } : {}),
        ...(rawArgs.sortBy !== undefined ? { sortBy: rawArgs.sortBy } : {}),
        ...(rawArgs.order !== undefined ? { order: rawArgs.order } : {}),
        ...(rawArgs.limit !== undefined ? { limit: rawArgs.limit } : {}),
        ...(rawArgs.skip !== undefined ? { skip: rawArgs.skip } : {}),
        ...(rawArgs.includeTotal !== undefined ? { includeTotal: rawArgs.includeTotal } : {}),
      },
    });

    if (!result.ok) return result.result;

    return toolOk({
      records: result.data?.records ?? [],
      count: result.data?.count ?? 0,
      hasMore: result.data?.hasMore ?? false,
      ...(result.data?.total !== undefined ? { total: result.data.total } : {}),
    });
  },
};

export default queryStateRecordsTool;
module.exports = queryStateRecordsTool;
