/**
 * Update Library — Native Library Tool
 *
 * Updates a Knowledge Library's metadata via the webapp API
 * (`PATCH /api/v1/libraries/:libraryId`).
 *
 * Spec: TOOL-HANDOFF.md §4.4
 *   - inputs: libraryId (required), name?, description?, metadata?
 *   - output: { ok: true }
 *
 * The webapp PATCH route accepts `name`, `description`, `icon`, `color`,
 * and (owner-only) `access`. Anything in `metadata` is forwarded as-is —
 * the route silently drops fields it doesn't understand.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface UpdateLibraryArgs {
  libraryId: string;
  name?: string;
  description?: string;
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

const updateLibraryTool: NativeToolDefinition = {
  description:
    'Update a Knowledge Library\'s name, description, or metadata. Use to rename or re-tag an existing library without recreating it.',
  server: 'library',
  inputSchema: {
    type: 'object',
    properties: {
      libraryId: {
        type: 'string',
        description: 'Library id to update.',
      },
      name: {
        type: 'string',
        description: 'New display name (1..100 chars).',
      },
      description: {
        type: 'string',
        description: 'New description.',
      },
      metadata: {
        type: 'object',
        description: 'Optional metadata bag forwarded to the PATCH call.',
        additionalProperties: true,
      },
    },
    required: ['libraryId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<UpdateLibraryArgs>;
    const libraryId =
      typeof args.libraryId === 'string' ? args.libraryId.trim() : '';

    if (!libraryId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'libraryId is required',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    const name = typeof args.name === 'string' ? args.name : undefined;
    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' ? args.metadata : undefined;

    if (
      name === undefined &&
      description === undefined &&
      metadata === undefined
    ) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Provide at least one of: name, description, metadata',
              code: 'VALIDATION',
            }),
          },
        ],
        isError: true,
      };
    }

    if (name !== undefined && name.length > 100) {
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

    const body: AnyObject = {};
    if (name !== undefined) body.name = name;
    if (description !== undefined) body.description = description;
    if (metadata !== undefined) body.metadata = metadata;

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/libraries/${encodeURIComponent(libraryId)}`;

    try {
      const response = await fetch(url, {
        method: 'PATCH',
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

      // Drain the response body even if we ignore it — keeps fetch happy.
      try {
        await response.json();
      } catch {
        /* ignore */
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
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

export default updateLibraryTool;
module.exports = updateLibraryTool;
