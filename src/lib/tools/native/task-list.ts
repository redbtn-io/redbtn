/**
 * Task List — Native Tool
 *
 * Lists agent tasks from a Global State namespace.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase E + §4.3
 *   - inputs: status?, parentTaskId?, limit?, scope?
 *   - output: { tasks: AgentTask[] }
 *
 * Filtering:
 *   - status        — exact match against `'pending' | 'in_progress' | 'completed' | 'cancelled'`
 *   - parentTaskId  — exact match (use this to enumerate children of a parent)
 *   - limit         — caps result count after filtering (default: no cap)
 *
 * Default sort: `createdAt` ascending (FIFO). Stable for equal timestamps.
 *
 * 404 from the upstream namespace = empty list (no tasks created yet) —
 * not an error.
 */

import type {
  NativeToolDefinition,
  NativeToolContext,
  NativeMcpResult,
} from '../native-registry';
import {
  loadTasks,
  resolveScopeNamespace,
  validationError,
  type AgentTask,
  type TaskScope,
  type TaskStatus,
} from './_task-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TaskListArgs {
  status?: TaskStatus;
  parentTaskId?: string;
  limit?: number;
  scope?: TaskScope;
}

const ALLOWED_STATUSES: ReadonlyArray<TaskStatus> = [
  'pending',
  'in_progress',
  'completed',
  'cancelled',
];

const taskListTool: NativeToolDefinition = {
  description:
    'List agent tasks scoped to the current run (default) or conversation. Optional filters: status (pending/in_progress/completed/cancelled), parentTaskId (children of a parent), limit. Default sort is createdAt ascending (FIFO).',
  server: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'cancelled'],
        description: 'Optional status filter — only tasks in this state are returned.',
      },
      parentTaskId: {
        type: 'string',
        description:
          'Optional parent task ID — only direct children of this task are returned. Use to walk a sub-task tree.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        description: 'Optional cap on the number of tasks returned (after filtering).',
      },
      scope: {
        type: 'string',
        enum: ['run', 'conversation'],
        description:
          'Which task list to read. Default "run" reads tasks scoped to the current runId; "conversation" reads tasks scoped to the current conversationId.',
        default: 'run',
      },
    },
    required: [],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = (rawArgs ?? {}) as Partial<TaskListArgs>;

    let statusFilter: TaskStatus | undefined;
    if (args.status !== undefined) {
      if (typeof args.status !== 'string' || !ALLOWED_STATUSES.includes(args.status as TaskStatus)) {
        return validationError(
          `status must be one of: ${ALLOWED_STATUSES.join(', ')}`,
        );
      }
      statusFilter = args.status as TaskStatus;
    }

    const parentTaskId =
      typeof args.parentTaskId === 'string' && args.parentTaskId.trim()
        ? args.parentTaskId.trim()
        : undefined;

    let limit: number | undefined;
    if (args.limit !== undefined) {
      const n = Number(args.limit);
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        return validationError('limit must be a positive integer when provided');
      }
      limit = Math.floor(n);
    }

    const scope: TaskScope = args.scope === 'conversation' ? 'conversation' : 'run';
    const namespaceResult = resolveScopeNamespace(scope, context);
    if (!namespaceResult.ok) {
      return validationError(namespaceResult.error);
    }
    const { namespace } = namespaceResult;

    const loadResult = await loadTasks(namespace, context);
    if (!loadResult.ok) return loadResult.error;

    let tasks: AgentTask[] = loadResult.tasks;

    if (statusFilter !== undefined) {
      tasks = tasks.filter(t => t?.status === statusFilter);
    }
    if (parentTaskId !== undefined) {
      tasks = tasks.filter(t => t?.parentTaskId === parentTaskId);
    }

    // Sort by createdAt ascending. Tasks without a createdAt sort to the end.
    tasks = [...tasks].sort((a, b) => {
      const aT = a?.createdAt ?? '';
      const bT = b?.createdAt ?? '';
      if (!aT && !bT) return 0;
      if (!aT) return 1;
      if (!bT) return -1;
      return aT < bT ? -1 : aT > bT ? 1 : 0;
    });

    if (limit !== undefined) {
      tasks = tasks.slice(0, limit);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tasks }),
        },
      ],
    };
  },
};

export default taskListTool;
module.exports = taskListTool;
