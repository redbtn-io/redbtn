/**
 * Get Graph — Native Graph Tool
 *
 * Returns the full definition of a single graph the caller can access via the
 * webapp API (`GET /api/v1/graphs/:graphId`).
 *
 * Spec: TOOL-HANDOFF.md §4.9
 *   - inputs: graphId
 *   - output: full graph definition (nodes, edges, layout, schema, metadata)
 *
 * Access is enforced server-side by `verifyGraphAccess` — owner, participant,
 * public, or system. Forbidden / not-found surface as `isError: true`.
 *
 * Use this to inspect a graph's input schema (`inputSchema`) before invoking
 * it via `invoke_graph`, or to introspect the node/edge structure.
 *
 * `nodes` / `edges` are the RUNTIME config — exactly what the engine executes
 * for an automation or chat run (`GraphRegistry.getConfig`: the published
 * version when the graph has one, otherwise the graph's live nodes/edges).
 * Until 2026-10-12 the hub answered with the Studio DRAFT here, which on
 * graphs edited through graph_patch was days stale (graph_patch writes the
 * live config, never the draft). Unpublished Studio edits are now shown
 * separately under `draft`, and only when they differ from what runs.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface GetGraphArgs {
  graphId?: string;
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

/**
 * Make the hub's graph payload unambiguous for an agent, and smaller.
 *
 * The hub (2026-10-12+) returns the RUNTIME config as `nodes`/`edges` plus a
 * `runtime` block, a `draft` block (published graphs only — the Studio working
 * copy, which always carries nodes for Studio's sake) and a `published` block
 * that repeats the runtime nodes. For an agent:
 *   - a draft with no unpublished changes is noise: keep its timestamps only;
 *   - a draft WITH unpublished changes is kept whole and labelled as not live;
 *   - the published block's nodes/edges duplicate `nodes`/`edges` when the
 *     published version is what runs: keep its metadata only.
 * An older hub (no `runtime` block) is passed through unchanged.
 */
export function shapeGraphForAgent(graph: AnyObject): AnyObject {
  if (!graph || typeof graph !== 'object' || !graph.runtime || typeof graph.runtime !== 'object') {
    return graph;
  }
  const out: AnyObject = { ...graph };
  const draft = graph.draft;
  if (draft && typeof draft === 'object') {
    if (draft.hasUnpublishedChanges === true) {
      out.draft = {
        ...draft,
        note: 'Unpublished Studio edits. NOT what runs; publish_graph makes them live (and replaces the published nodes/edges above).',
      };
    } else {
      out.draft = {
        savedAt: draft.savedAt ?? null,
        hasUnpublishedChanges: false,
        note: 'No unpublished edits: the draft matches the published version (nodes omitted).',
      };
    }
  }
  const published = graph.published;
  if (published && typeof published === 'object' && graph.runtime.source === 'published') {
    const { nodes: _nodes, edges: _edges, ...meta } = published;
    out.published = { ...meta, note: 'nodes/edges are the top-level nodes/edges (this version is what runs).' };
  }
  return out;
}

const getGraphTool: NativeToolDefinition = {
  description:
    'Fetch the full definition of a single graph (nodes, edges, layout, input schema, metadata). Use to inspect a graph\'s shape and required inputs before invoking it via invoke_graph. nodes/edges are the RUNTIME config: exactly what automation and chat runs execute (the published version of a published graph). `runtime.source` says which; unpublished Studio edits, when any exist, appear separately under `draft` (hasUnpublishedChanges: true) and do NOT run until publish_graph.',
  server: 'graph',
  inputSchema: {
    type: 'object',
    properties: {
      graphId: {
        type: 'string',
        description: 'The graphId of the graph to fetch.',
      },
    },
    required: ['graphId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<GetGraphArgs>;
    const graphId = typeof args.graphId === 'string' ? args.graphId.trim() : '';

    if (!graphId) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'graphId is required', code: 'VALIDATION' }),
          },
        ],
        isError: true,
      };
    }

    const baseUrl = getBaseUrl();
    const url = `${baseUrl}/api/v1/graphs/${encodeURIComponent(graphId)}`;

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
                  `Graph API ${response.status} ${response.statusText}` +
                  (errBody ? `: ${errBody.slice(0, 200)}` : ''),
                status: response.status,
                graphId,
              }),
            },
          ],
          isError: true,
        };
      }

      const data = (await response.json()) as AnyObject;
      // Route returns { graph: {...} } — surface the inner object directly so
      // agents don't need to peel off the wrapper.
      const graph = shapeGraphForAgent((data?.graph ?? data) as AnyObject);

      return {
        content: [
          { type: 'text', text: JSON.stringify({ graph }) },
        ],
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ error: message, graphId }) },
        ],
        isError: true,
      };
    }
  },
};

export default getGraphTool;
module.exports = getGraphTool;
