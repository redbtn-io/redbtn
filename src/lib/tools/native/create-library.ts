/**
 * Create Library — Native Library Tool
 *
 * Creates a new Knowledge Library via the webapp API
 * (`POST /api/v1/libraries`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: name (required), description?, chunkSize?, chunkOverlap?, metadata?
 *   - output: { libraryId }
 *
 * Note on `metadata`: the current webapp POST route persists `name`,
 * `description`, `icon`, `color`, `access`, `embeddingModel`, `chunkSize`,
 * and `chunkOverlap`. `metadata` is forwarded as-is for forward-compatibility;
 * fields the route doesn't recognise are ignored server-side.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface CreateLibraryArgs {
  name: string;
  description?: string;
  chunkSize?: number;
  chunkOverlap?: number;
  metadata?: Record<string, unknown>;
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

const createLibraryTool: NativeToolDefinition = {
  description:
    'Create a new Knowledge Library. Use to spin up a fresh document collection (e.g. for a project, agent, or topic) before adding documents.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Display name for the new library (1..100 chars).',
      },
      description: {
        type: 'string',
        description: 'Optional human-readable description.',
      },
      chunkSize: {
        type: 'number',
        description:
          'Optional maximum token/character chunk size for documents in this library (e.g. 100000 for unchunked memory cards).',
      },
      chunkOverlap: {
        type: 'number',
        description:
          'Optional chunk overlap for document splitting (e.g. 0 for strict unchunked memory cards).',
      },
      metadata: {
        type: 'object',
        description:
          'Optional metadata bag forwarded to the create call. Free-form JSON.',
        additionalProperties: true,
      },
    },
    required: ['name'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<CreateLibraryArgs>;
    const name = typeof args.name === 'string' ? args.name.trim() : '';

    if (!name) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'name is required and must be a non-empty string',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }
    if (name.length > 100) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'name too long (max 100 characters)',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (args.chunkSize !== undefined) {
      const cs = Number(args.chunkSize);
      if (!Number.isFinite(cs) || cs <= 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'chunkSize must be a positive number',
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    if (args.chunkOverlap !== undefined) {
      const co = Number(args.chunkOverlap);
      if (!Number.isFinite(co) || co < 0) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'chunkOverlap must be a non-negative number',
                code: 'VALIDATION',
              }),
            },
          ],
          isError: true,
        };
      }
    }

    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const chunkSize =
      args.chunkSize !== undefined ? Number(args.chunkSize) : undefined;
    const chunkOverlap =
      args.chunkOverlap !== undefined ? Number(args.chunkOverlap) : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined;

    const body: AnyObject = { name };
    if (description !== undefined) body.description = description;
    if (chunkSize !== undefined) body.chunkSize = chunkSize;
    if (chunkOverlap !== undefined) body.chunkOverlap = chunkOverlap;
    if (metadata !== undefined) body.metadata = metadata;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(context),
        body: JSON.stringify(body),
      });

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
                  `Library API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      const lib = (data?.library as AnyObject) ?? {};
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              libraryId: lib.libraryId ?? null,
            }),
          },
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

export default createLibraryTool;
module.exports = createLibraryTool;
