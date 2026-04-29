/**
 * Task Create — Native Tool
 *
 * Creates a new agent task and persists it via Global State. Backed by the
 * existing `/api/v1/state/namespaces/:ns/values` API — no new storage.
 *
 * Spec: ENVIRONMENT-HANDOFF.md §2 Phase E + §4.3
 *   - inputs: subject (required), description?, parentTaskId?, metadata?,
 *             scope? ('run' | 'conversation', default 'run')
 *   - output: { taskId }
 *
 * Storage layout:
 *   - namespace = `agent-tasks:${runId}` (scope='run')
 *               | `agent-tasks:${conversationId}` (scope='conversation')
 *   - key       = 'tasks'
 *   - value     = { tasks: AgentTask[] }
 *
 * Concurrency: read-mutate-write. v1 assumes a single agent owns its task
 * list per run/conversation — concurrent writers from different agents would
 * race. Adequate per the handoff: "for v1 the read-mutate-write pattern is
 * acceptable since each agent typically owns its own task list".
 */

import { randomBytes } from 'crypto';
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

interface TaskCreateArgs {
  subject: string;
  description?: string;
  parentTaskId?: string;
  metadata?: Record<string, unknown>;
  scope?: TaskScope;
}

const NANOID_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/**
 * Generate `task_` + 8-char nanoid-style ID. Same alphabet/byte-mask trick as
 * generate-id.ts so we don't need to pull in `nanoid` for one call site.
 */
function nanoid8(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += NANOID_ALPHABET[bytes[i] & 0x3f];
  return out;
}

const taskCreateTool: NativeToolDefinition = {
  description:
    'Create a new agent task with TODO-style tracking. Tasks persist for the lifetime of the run (default) or the conversation (scope: "conversation"). Returns a taskId that can be used with task_update / task_complete / task_get.',
  server: 'task',
  inputSchema: {
    type: 'object',
    properties: {
      subject: {
        type: 'string',
        description:
          'Short human-readable summary of the task (e.g. "Refactor router.ts").',
      },
      description: {
        type: 'string',
        description: 'Optional longer free-form description.',
      },
      parentTaskId: {
        type: 'string',
        description:
          'Optional parent task ID for sub-task trees. Use with task_list({ parentTaskId }) to enumerate children.',
      },
      metadata: {
        type: 'object',
        description:
          'Optional arbitrary metadata (any JSON-serialisable object). Stored as-is on the task doc.',
        additionalProperties: true,
      },
      scope: {
        type: 'string',
        enum: ['run', 'conversation'],
        description:
          'Scope for the task list. "run" (default) ties tasks to the current runId; "conversation" ties them to the current conversationId so they survive across runs in the same conversation.',
        default: 'run',
      },
    },
    required: ['subject'],
  },

  async handler(rawArgs: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<TaskCreateArgs>;
    const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
    const description =
      typeof args.description === 'string' ? args.description : undefined;
    const parentTaskId =
      typeof args.parentTaskId === 'string' && args.parentTaskId.trim()
        ? args.parentTaskId.trim()
        : undefined;
    const metadata =
      args.metadata && typeof args.metadata === 'object' && !Array.isArray(args.metadata)
        ? (args.metadata as Record<string, unknown>)
        : undefined;
    const scope: TaskScope = args.scope === 'conversation' ? 'conversation' : 'run';

    if (!subject) {
      return validationError('subject is required and must be a non-empty string');
    }

    const namespaceResult = resolveScopeNamespace(scope, context);
    if (!namespaceResult.ok) {
      return validationError(namespaceResult.error);
    }
    const { namespace } = namespaceResult;

    // 1. Read current state
    const loadResult = await loadTasks(namespace, context);
    if (!loadResult.ok) return loadResult.error;

    // 2. Mutate — append new task
    const now = new Date().toISOString();
    const taskId = `task_${nanoid8()}`;
    const newTask: AgentTask = {
      taskId,
      subject,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    if (description !== undefined) newTask.description = description;
    if (parentTaskId !== undefined) newTask.parentTaskId = parentTaskId;
    if (metadata !== undefined) newTask.metadata = metadata;

    const next = [...loadResult.tasks, newTask];

    // 3. Write back
    const saveResult = await saveTasks(namespace, scope, next, context);
    if (!saveResult.ok) return saveResult.error;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ taskId }),
        },
      ],
    };
  },
};

export default taskCreateTool;
module.exports = taskCreateTool;
