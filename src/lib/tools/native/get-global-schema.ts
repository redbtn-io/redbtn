/**
 * Get Global Schema — Native Tool
 *
 * Reads schema metadata from a global-state namespace via the webapp API
 * (`GET /api/v1/state/namespaces/:namespace?details=schema`).
 *
 * Inputs:
 *   - namespace (required, string)
 *   - key? (optional, string) — when provided, returns the effective schema for that key
 *                               (per-key override OR namespace default OR null)
 *                               When omitted, returns the full namespace schema config
 *                               (default, mode, per-key overrides)
 *
 * Output when key is provided:
 *   - { schemaId: string | null, name: string | null, description: string | null,
 *       schema: object | null, mode: 'strict' | 'lenient' | null }
 *
 * Output when key is omitted:
 *   - { defaultSchemaId: string | null, mode: 'strict' | 'lenient' | null,
 *       schemaByKey: Record<string, string>, schemaCatalog: Record<string, any> }
 *
 * Use case: Before writing to a namespace with set_global_state or state_patch,
 * query the active schema to understand validation constraints.
 *
 * Auth: Bearer token or X-Internal-Key + X-User-Id headers.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetGlobalSchemaArgs {
  namespace: string;
  key?: string;
}

function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const authToken =
    (context?.state?.authToken as string | undefined) ||
    (context?.state?.data?.authToken as string | undefined);
  const userId =
    (context?.state?.userId as string | undefined) ||
    (context?.state?.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

const getGlobalSchemaTool: NativeToolDefinition = {
  description:
    'Fetch schema metadata for a global-state namespace. Use before writing to understand ' +
    'validation constraints. Pass `key` to get the effective schema for a specific key; ' +
    'omit `key` to get the full namespace schema config (default, mode, per-key overrides).',
  server: 'state',
  inputSchema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description:
          'The namespace name. Must exist and be readable by the caller.',
      },
      key: {
        type: 'string',
        description:
          'Optional. When provided, returns the effective schema for this key ' +
          '(per-key override or namespace default). When omitted, returns full ' +
          'namespace schema config (defaultSchemaId, mode, schemaByKey, schemaCatalog).',
      },
    },
    required: ['namespace'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetGlobalSchemaArgs>;
    const namespace = typeof args.namespace === 'string' ? args.namespace.trim() : '';
    const key = typeof args.key === 'string' ? args.key.trim() : undefined;

    if (!namespace) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'namespace is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url =
      `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}?details=schema`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });

      // 404 → namespace not found is a normal "not found" result for schema info.
      if (response.status === 404) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                schemaId: null,
                name: null,
                description: null,
                schema: null,
                mode: null,
                exists: false,
              }),
            },
          ],
        };
      }

      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Global state namespace API ${response.status} ${response.statusText}` +
                  (body ? `: ${body.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;

      // If key is provided, return the effective schema for that key
      if (key) {
        const perKeySchemaId = data.schemaByKey?.[key];
        const effectiveSchemaId = perKeySchemaId || data.schemaId;

        // Look up the schema details from schemaCatalog
        const schemaCatalog = data.schemaCatalog || {};
        const effectiveSchema = effectiveSchemaId ? schemaCatalog[effectiveSchemaId] : null;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                schemaId: effectiveSchemaId || null,
                name: effectiveSchema?.name || null,
                description: effectiveSchema?.description || null,
                schema: effectiveSchema?.schema || null,
                mode: data.schemaMode || null,
              }),
            },
          ],
        };
      }

      // If key is NOT provided, return full namespace schema config
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              defaultSchemaId: data.schemaId || null,
              mode: data.schemaMode || null,
              schemaByKey: data.schemaByKey || {},
              schemaCatalog: data.schemaCatalog || {},
            }),
          },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  },
};

export default getGlobalSchemaTool;
module.exports = getGlobalSchemaTool;
