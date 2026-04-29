/**
 * Task Get — Native Tool
 *
 * Returns the full task document by ID. `null` when not found.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase E + §4.3
 *   - inputs: taskId (required), scope?
 *   - output: full task doc — `{ task: AgentTask | null }`
 *
 * "Returns null for missing" mirrors the spec wording. We wrap it in a
 * `task` envelope (instead of returning the doc at the top level) so the
 * presence/absence signal stays unambiguous and the result shape stays
 * stable when fields evolve.
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
  type TaskScope,
} from './_task-helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface TaskGetArgs {
  taskId: string;
  scope?: TaskScope;
}

const taskGetTool: NativeToolDefinition = {
  description:
    'Read a single agent task by ID. Returns the full task document, or { task: null } when no task with that ID exists in the chosen scope.',
  server: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The task ID returned by task_create.',
      },
      scope: {
        type: 'string',
        enum: ['run', 'conversation'],
        description:
          'Which task list to read. Defaults to "run" — must match the scope used at task_create time.',
        default: 'run',
      },
    },
    required: ['taskId'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TaskGetArgs>;
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

    const task = loadResult.tasks.find(t => t?.taskId === taskId) ?? null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ task }),
        },
      ],
    };
  },
};

export default taskGetTool;
module.exports = taskGetTool;
