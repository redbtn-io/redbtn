/**
 * Task Update — Native Tool
 *
 * Mutates fields on an existing agent task. Persists via Global State.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase E + §4.3
 *   - inputs: taskId (required), status?, subject?, description?, scope?
 *   - output: { ok: true }
 *
 * At least one of `status`, `subject`, `description` must be provided —
 * otherwise the call is a no-op and we surface a validation error.
 *
 * `updatedAt` is bumped on every successful write. We do NOT bump
 * `completedAt` here even when status flips to 'completed' — task_complete
 * exists for that codepath. (Updating status to 'completed' here is allowed
 * but it's a manual mutation, not a completion event.)
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
  type TaskStatus,
} from './_task-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TaskUpdateArgs {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  scope?: TaskScope;
}

const ALLOWED_STATUSES: ReadonlyArray<TaskStatus> = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
];

const taskUpdateTool: NativeToolDefinition = {
  description:
    'Update fields on an existing agent task: status, subject, or description. Returns { ok: true } on success. Use task_complete to mark a task done in one call (it also stamps completedAt + result).',
  server: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID returned by task_create.',
      },
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'cancelled'],
        description: 'Optional new status.',
      },
      subject: {
        type: 'string',
        description: 'Optional new subject (short summary).',
      },
      description: {
        type: 'string',
        description: 'Optional new description (long-form).',
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
    const args = rawArgs as Partial<TaskUpdateArgs>;
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';

    if (!taskId) {
      return validationError('taskId is required and must be a non-empty string');
    }

    let status: TaskStatus | undefined;
    if (args.status !== undefined) {
      if (typeof args.status !== 'string' || !ALLOWED_STATUSES.includes(args.status as TaskStatus)) {
        return validationError(
          `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
        );
      }
      status = args.status as TaskStatus;
    }

    const subject =
      args.subject !== undefined && typeof args.subject === 'string'
        ? args.subject
        : undefined;
    const description =
      args.description !== undefined && typeof args.description === 'string'
        ? args.description
        : undefined;

    if (status === undefined && subject === undefined && description === undefined) {
      return validationError(
        'At least one of status, subject, description must be provided',
      );
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
    const updated: AgentTask = { ...existing };
    if (status !== undefined) updated.status = status;
    if (subject !== undefined) updated.subject = subject;
    if (description !== undefined) updated.description = description;
    updated.updatedAt = new Date().toISOString();

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

export default taskUpdateTool;
module.exports = taskUpdateTool;
