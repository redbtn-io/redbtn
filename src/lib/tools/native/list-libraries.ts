/**
 * List Libraries — Native Library Tool
 *
 * Lists Knowledge Libraries the caller can access (owned + shared) via the
 * webapp API (`GET /api/v1/libraries`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: search?, limit?
 *   - output: { libraries: [{ id, name, description, documentCount }] }
 *
 * The webapp route does not implement server-side text search yet — we apply
 * the `search` filter client-side (case-insensitive substring on name and
 * description).
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface ListLibrariesArgs {
  search?: string;
  limit?: number;
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

const listLibrariesTool: NativeToolDefinition = {
  description:
    'List Knowledge Libraries the caller can access (owned + shared). Returns id/name/description/documentCount for each. Use to discover libraries before reading or writing documents.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      search: {
        type: 'string',
        description:
          'Optional case-insensitive substring filter on name and description (applied client-side).',
      },
      limit: {
        type: 'integer',
        description: 'Maximum number of libraries to return (default 100, max 200).',
        minimum: 1,
        maximum: 200,
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<ListLibrariesArgs>;
    const search = typeof args.search === 'string' ? args.search.trim() : '';
    const limit =
      args.limit !== undefined && Number.isFinite(Number(args.limit))
        ? Math.min(200, Math.max(1, Math.floor(Number(args.limit))))
        : 100;

    const baseUrl = getBaseUrl();
    // includeShared=true is the route default; pass explicitly for clarity.
    const url = `${baseUrl}/api/v1/libraries?includeShared=true`;

    try {
      const response = await fetch(url, { headers: buildHeaders(context) });
      if (!response.ok) {
        let errBody = '';
        try {
          errBody = await response.text();
        } catch {
          /* ignore */
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error:
                  `Library list API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const raw = Array.isArray(data?.libraries) ? (data.libraries as AnyObject[]) : [];

      let mapped = raw.map((l) => ({
        id: typeof l.libraryId === 'string' ? l.libraryId : String(l.id ?? ''),
        name: l.name ?? '',
        description: l.description ?? '',
        documentCount:
          typeof l.documentCount === 'number' ? l.documentCount : 0,
      }));

      if (search) {
        const needle = search.toLowerCase();
        mapped = mapped.filter(
          (l) =>
            String(l.name ?? '').toLowerCase().includes(needle) ||
            String(l.description ?? '').toLowerCase().includes(needle),
        );
      }

      mapped = mapped.slice(0, limit);

      return {
        content: [
          { type: 'text', text: JSON.stringify({ libraries: mapped }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message }) },
        ],
        isError: true,
      };
    }
  },
};

export default listLibrariesTool;
module.exports = listLibrariesTool;
