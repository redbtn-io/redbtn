/**
 * Task Complete — Native Tool
 *
 * Convenience tool that marks a task as completed in one call. Equivalent to
 * `task_update` + sets `status='completed'`, `completedAt=now`, and an
 * optional `result` payload.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase E + §4.3
 *   - inputs: taskId (required), result?, scope?
 *   - output: { ok: true }
 *
 * The `result` field is stored verbatim on the task doc — accepts any
 * JSON-serialisable value (string, number, boolean, object, array, null).
 *
 * `completedAt` is always stamped (current ISO timestamp). If the task is
 * already completed, this acts as a re-completion (refreshes the timestamp
 * and overwrites the result). The handoff doesn't forbid that — and it
 * matches the convenience-of-use expectation.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  loadTasks,
  resolveScopeNamespace,
  saveTasks,
  validationError,
  type AgentTask,
  type TaskScope,
} from './_task-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TaskCompleteArgs {
  taskId: string;
  result?: unknown;
  scope?: TaskScope;
}

const taskCompleteTool: NativeToolDefinition = {
  description:
    'Mark an agent task as completed. Sets status="completed", stamps completedAt, and optionally stores a result payload. Convenience wrapper around task_update.',
  server: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID returned by task_create.',
      },
      result: {
        description:
          'Optional result payload to attach to the task (any JSON-serialisable value). Stored verbatim on the task doc.',
      },
      scope: {
        type: 'string',
        enum: ['run', 'conversation'],
        description:
          'Which task list to mutate. Defaults to "run" — must match the scope used at task_create time.',
        default: 'run',
      },
    },
    required: ['taskId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TaskCompleteArgs>;
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';

    if (!taskId) {
      return validationError('taskId is required and must be a non-empty string');
    }

    const scope: TaskScope = args.scope === 'conversation' ? 'conversation' : 'run';
    const namespaceResult = resolveScopeNamespace(scope, context);
    if (!namespaceResult.ok) {
      return validationError(namespaceResult.error);
    }
    const { namespace } = namespaceResult;

    const loadResult = await loadTasks(namespace, context);
    if (!loadResult.ok) return loadResult.error;

    const tasks = loadResult.tasks;
    const idx = tasks.findIndex(t => t?.taskId === taskId);
    if (idx < 0) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: `Task not found: ${taskId}`,
              code: 'NOT_FOUND',
            }),
          },
        ],
        isError: true,
      };
    }

    const existing = tasks[idx];
    const now = new Date().toISOString();
    const updated: AgentTask = {
      ...existing,
      status: 'completed',
      updatedAt: now,
      completedAt: now,
    };
    if (args.result !== undefined) updated.result = args.result;

    const next = tasks.slice();
    next[idx] = updated;

    const saveResult = await saveTasks(namespace, scope, next, context);
    if (!saveResult.ok) return saveResult.error;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true }),
        },
      ],
    };
  },
};

export default taskCompleteTool;
module.exports = taskCompleteTool;
