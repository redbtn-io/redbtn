/**
 * get_workspace_task — compact status of a run started by `workspace_task`.
 *
 *   queued       accepted, the worker has not made progress yet
 *   working      the worker is making progress
 *   shipped      finished and opened a pull request (prUrl)
 *   completed    finished without shipping
 *   failed       the run ended in an error
 *   interrupted  the run was interrupted, or made no progress for 15 minutes
 *                (none since it started, or since its last heartbeat) —
 *                workspace_task children are in-process runs, so a
 *                worker redeploy kills them and nothing requeues them: start
 *                the task again if it still needs doing
 *   unknown      no record of the run is left (run state expired, no archive)
 *
 * Gated `workspace:read` on the task's workspace (DATA_TOOL_RULES). Only runs
 * of the `workspace-task` graph that belong to the run's user are visible;
 * anything else reads as not found.
 */
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';
import { toolOk, toolError, resolveWorkspaceDb } from './workspace-common';
import { WORKSPACE_TASK_GRAPH_ID, readWorkspaceTaskState } from '../../workspaces/workspace-task-contract';
import { isRunProgressStale } from '../../run/progress-heartbeat';

type AnyObject = Record<string, any>;

/** A worker that has not advanced its heartbeat for this long is reported interrupted. */
export const WORKSPACE_TASK_STALE_MS = 15 * 60 * 1000;
const SUMMARY_CHARS = 2000;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** ISO string of a date-ish value (Date, epoch ms, ISO string), or undefined. */
function isoOf(v: unknown): string | undefined {
  if (!(v instanceof Date) && typeof v !== 'string' && typeof v !== 'number') return undefined;
  const d = new Date(v as string | number | Date);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
}

function prFromTools(tools: unknown): string | null {
  if (!Array.isArray(tools)) return null;
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i] as AnyObject;
    if (t?.toolName !== 'workspace_ship' && t?.name !== 'workspace_ship') continue;
    const raw = t.result ?? t.output;
    const text =
      typeof raw === 'string'
        ? raw
        : Array.isArray(raw?.content)
          ? raw.content.map((c: AnyObject) => (typeof c?.text === 'string' ? c.text : '')).join('')
          : JSON.stringify(raw ?? '');
    const m = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/.exec(text);
    if (m) return m[0];
  }
  return null;
}

const tool: NativeToolDefinition = {
  description:
    'Status of a worker run started by workspace_task: queued | working | shipped | completed | failed | interrupted | ' +
    'unknown, with prUrl when it shipped and a short summary of what it reported. "interrupted" means the worker stopped ' +
    '(e.g. a platform redeploy) and will not resume — start the task again with workspace_task if it still needs doing.',
  inputSchema: {
    type: 'object',
    properties: {
      runId: { type: 'string', description: 'The runId workspace_task returned.' },
    },
    required: ['runId'],
  },
  handler: async (args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> => {
    const runId = str(args?.runId);
    if (!/^run_[A-Za-z0-9_-]{4,80}$/.test(runId)) return toolError('runId is not a run id');
    const state: AnyObject = context?.state || {};
    const owner: string = (typeof state.userId === 'string' && state.userId) || str(state.data?.userId);
    if (!owner) return toolError('the run has no userId', 'NO_USER');

    const rs = await readWorkspaceTaskState(context, runId);
    if (rs) {
      if (rs.graphId !== WORKSPACE_TASK_GRAPH_ID || rs.userId !== owner) {
        return toolError(`workspace task ${runId} not found`, 'NOT_FOUND');
      }
      const workspaceId = str(rs.input?.workspaceId) || null;
      let prUrl = prFromTools(rs.tools);
      if (!prUrl && workspaceId) prUrl = await prFromWorkspace(context, workspaceId, runId);
      const content = typeof rs.output?.content === 'string' ? rs.output.content : '';
      let status: string;
      switch (rs.status) {
        case 'completed':
          status = prUrl ? 'shipped' : 'completed';
          break;
        case 'error':
        case 'failed':
          status = 'failed';
          break;
        case 'interrupted':
          status = 'interrupted';
          break;
        default: {
          // Liveness is the progress heartbeat, else the start time: a run that
          // has done nothing for the stale window (killed before its first
          // heartbeat, or since its last one) will not resume.
          const started = Array.isArray(rs.graph?.executionPath) && rs.graph.executionPath.length > 0;
          const since = isoOf(rs.lastProgressAt) ?? isoOf(rs.startedAt);
          const stale = since ? isRunProgressStale(since, { staleAfterMs: WORKSPACE_TASK_STALE_MS }) : false;
          status = stale ? 'interrupted' : !rs.lastProgressAt && !started ? 'queued' : 'working';
        }
      }
      return toolOk({
        runId,
        workspaceId,
        status,
        ...(prUrl ? { prUrl } : {}),
        summary: content ? content.slice(-SUMMARY_CHARS) : null,
        ...(rs.error ? { error: String(rs.error).slice(0, 500) } : {}),
        startedAt: isoOf(rs.startedAt) ?? null,
        completedAt: isoOf(rs.completedAt) ?? null,
        lastProgressAt: isoOf(rs.lastProgressAt) ?? null,
      });
    }

    // Run state expires an hour after the run ends: fall back to the archive.
    const db = resolveWorkspaceDb(context);
    if (!db) return toolOk({ runId, status: 'unknown' });
    try {
      const doc = await (db as any)
        .collection('runEvents')
        .findOne({ runId }, { projection: { runId: 1, graphId: 1, userId: 1, status: 1, startedAt: 1, completedAt: 1 } });
      if (!doc) return toolOk({ runId, status: 'unknown' });
      if (doc.graphId !== WORKSPACE_TASK_GRAPH_ID || doc.userId !== owner) {
        return toolError(`workspace task ${runId} not found`, 'NOT_FOUND');
      }
      const prUrl = await prFromWorkspaceAnywhere(context, runId);
      const status =
        doc.status === 'completed' ? (prUrl ? 'shipped' : 'completed')
          : doc.status === 'error' || doc.status === 'failed' ? 'failed'
            : 'interrupted';
      return toolOk({
        runId,
        status,
        ...(prUrl ? { prUrl } : {}),
        startedAt: isoOf(doc.startedAt) ?? null,
        completedAt: isoOf(doc.completedAt) ?? null,
      });
    } catch (err: unknown) {
      return toolError(`get_workspace_task failed: ${err instanceof Error ? err.message : String(err)}`, 'FAILED');
    }
  },
};

/** The PR a run's checkout of `workspaceId` recorded (active checkout or history). */
async function prFromWorkspace(context: NativeToolContext, workspaceId: string, runId: string): Promise<string | null> {
  const db = resolveWorkspaceDb(context);
  if (!db) return null;
  try {
    const ws = await (db as any)
      .collection('agentWorkspaces')
      .findOne({ workspaceId }, { projection: { activeCheckouts: 1, checkoutHistory: 1 } });
    const all = [...(ws?.activeCheckouts ?? []), ...(ws?.checkoutHistory ?? [])];
    const hit = all.reverse().find((c: AnyObject) => c?.runId === runId && typeof c?.pr?.url === 'string');
    return hit?.pr?.url ?? null;
  } catch {
    return null;
  }
}

async function prFromWorkspaceAnywhere(context: NativeToolContext, runId: string): Promise<string | null> {
  const db = resolveWorkspaceDb(context);
  if (!db) return null;
  try {
    const ws = await (db as any)
      .collection('agentWorkspaces')
      .findOne(
        { $or: [{ 'activeCheckouts.runId': runId }, { 'checkoutHistory.runId': runId }] },
        { projection: { workspaceId: 1 } },
      );
    return ws?.workspaceId ? prFromWorkspace(context, ws.workspaceId, runId) : null;
  } catch {
    return null;
  }
}

export default tool;
module.exports = tool;
