/**
 * Internal helpers shared by the task pack (ENVIRONMENT-HANDOFF.md §4.3).
 *
 * Centralises:
 *   - AgentTask + TaskScope types
 *   - Scope → namespace resolution (run vs conversation)
 *   - Webapp base URL + auth header building (mirrors GlobalStateClient)
 *   - VALIDATION-coded error result shape
 *   - The well-known Global State key all task lists are stored under
 *
 * Filename is prefixed with `_` so any auto-loader that scans the native
 * directory can skip it (it's not a tool, it's a helper). The native registry
 * registers tools by explicit name, so this file is never accidentally loaded
 * as a tool.
 */

import type { NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskScope = 'run' | 'conversation';

export interface AgentTask {
  taskId: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  parentTaskId?: string;
  result?: unknown;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

/** All task pack entries store their list under this key in the namespace. */
export const AGENT_TASKS_KEY = 'tasks';

/** Namespace prefix used for the per-run / per-conversation task list. */
export const AGENT_TASKS_NS_PREFIX = 'agent-tasks';

export type ScopeResolution =
  | { ok: true; namespace: string; scopeId: string; scope: TaskScope }
  | { ok: false; error: string };

/**
 * Resolve a scope value to the Global State namespace it maps to.
 *
 * - scope='run'          → `agent-tasks:${runId}`
 *                          runId from `context.runId` first, then `state.runId`,
 *                          then `state.data.runId`.
 * - scope='conversation' → `agent-tasks:${conversationId}`
 *                          conversationId from `state.conversationId` first,
 *                          then `state.data.conversationId`, then
 *                          `state.options.conversationId`.
 *
 * Returns `{ ok: false }` when the requested scope ID isn't available.
 */
export function resolveScopeNamespace(
  scope: TaskScope,
  context: NativeToolContext,
): ScopeResolution {
  const state = (context?.state ?? {}) as AnyObject;
  if (scope === 'run') {
    const runId =
      context?.runId ||
      (state.runId as string | undefined) ||
      (state.data?.runId as string | undefined);
    if (!runId || typeof runId !== 'string' || !runId.trim()) {
      return {
        ok: false,
        error:
          'scope is "run" but no runId is available on context. Pass scope:"conversation" or invoke this tool from within a graph run.',
      };
    }
    return {
      ok: true,
      namespace: `${AGENT_TASKS_NS_PREFIX}:${runId.trim()}`,
      scopeId: runId.trim(),
      scope,
    };
  }

  // scope === 'conversation'
  const conversationId =
    (state.conversationId as string | undefined) ||
    (state.data?.conversationId as string | undefined) ||
    (state.options?.conversationId as string | undefined);
  if (!conversationId || typeof conversationId !== 'string' || !conversationId.trim()) {
    return {
      ok: false,
      error:
        'scope is "conversation" but no conversationId is available on context. Run within a conversation context or pass scope:"run".',
    };
  }
  return {
    ok: true,
    namespace: `${AGENT_TASKS_NS_PREFIX}:${conversationId.trim()}`,
    scopeId: conversationId.trim(),
    scope,
  };
}

/**
 * Webapp base URL — same env precedence as the global-state pack.
 */
export function getBaseUrl(): string {
  return process.env.WEBAPP_URL || 'http://localhost:3000';
}

/**
 * Build auth + content headers for a webapp state-API call.
 *
 * Mirrors GlobalStateClient.getHeaders():
 *   - Bearer ${authToken} when context.state.authToken is set
 *   - X-User-Id when context.state.userId is set
 *   - X-Internal-Key when env INTERNAL_SERVICE_KEY is set
 */
export function buildHeaders(context: NativeToolContext): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  const state = (context?.state ?? {}) as AnyObject;
  const authToken =
    (state.authToken as string | undefined) ||
    (state.data?.authToken as string | undefined);
  const userId =
    (state.userId as string | undefined) ||
    (state.data?.userId as string | undefined);
  const internalKey = process.env.INTERNAL_SERVICE_KEY;

  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (userId) headers['X-User-Id'] = userId;
  if (internalKey) headers['X-Internal-Key'] = internalKey;

  return headers;
}

/**
 * Standard validation-error result shape used by every tool.
 */
export function validationError(message: string): NativeMcpResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: message, code: 'VALIDATION' }),
      },
    ],
    isError: true,
  };
}

/**
 * Read the persisted `{ tasks }` envelope for a namespace.
 *
 * Returns:
 *   - `{ ok: true, tasks }` on success (404 → empty list)
 *   - `{ ok: false, error }` on upstream failure
 */
export async function loadTasks(
  namespace: string,
  context: NativeToolContext,
): Promise<
  | { ok: true; tasks: AgentTask[] }
  | { ok: false; error: NativeMcpResult }
> {
  const baseUrl = getBaseUrl();
  const url =
    `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}` +
    `/values/${encodeURIComponent(AGENT_TASKS_KEY)}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: buildHeaders(context) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      },
    };
  }

  if (response.status === 404) {
    return { ok: true, tasks: [] };
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Global state API ${response.status} ${response.statusText}` +
                (body ? `: ${body.slice(0, 200)}` : ''),
              status: response.status,
            }),
          },
        ],
        isError: true,
      },
    };
  }

  let data: AnyObject;
  try {
    data = (await response.json()) as AnyObject;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Failed to parse task-list response: ${message}`,
            }),
          },
        ],
        isError: true,
      },
    };
  }

  const v = data?.value;
  if (!v || typeof v !== 'object') return { ok: true, tasks: [] };
  const arr = (v as AnyObject).tasks;
  if (!Array.isArray(arr)) return { ok: true, tasks: [] };
  return { ok: true, tasks: arr as AgentTask[] };
}

/**
 * Persist the `{ tasks }` envelope for a namespace.
 *
 * Returns:
 *   - `{ ok: true }` on success
 *   - `{ ok: false, error }` on upstream failure
 */
export async function saveTasks(
  namespace: string,
  scope: TaskScope,
  tasks: AgentTask[],
  context: NativeToolContext,
): Promise<{ ok: true } | { ok: false; error: NativeMcpResult }> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/api/v1/state/namespaces/${encodeURIComponent(namespace)}/values`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(context),
      body: JSON.stringify({
        key: AGENT_TASKS_KEY,
        value: { tasks },
        description: `Agent task list (${scope}-scoped)`,
      }),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      },
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
      ok: false,
      error: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error:
                `Global state API ${response.status} ${response.statusText}` +
                (body ? `: ${body.slice(0, 200)}` : ''),
              status: response.status,
            }),
          },
        ],
        isError: true,
      },
    };
  }

  return { ok: true };
}
