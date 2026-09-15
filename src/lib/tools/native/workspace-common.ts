/**
 * Shared plumbing for the managed-workspace tools (`workspace_for_repo`,
 * `workspace_ship`, `workspace_merge`).
 */
import type { NativeToolContext, NativeMcpResult } from '../native-registry';
import { bullLifecycleQueue, type LifecycleQueue } from '../../workspaces/WorkspaceLifecycle';

type AnyObject = Record<string, any>;

export function toolOk(payload: AnyObject): NativeMcpResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

export function toolError(message: string, code = 'VALIDATION'): NativeMcpResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message, code }) }], isError: true };
}

/** The run's Mongo handle: an injected one (tests) or the live mongoose connection. */
export function resolveWorkspaceDb(context: NativeToolContext): AnyObject | null {
  if (context?.state?.workspaceDb) return context.state.workspaceDb;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mongoose = require('mongoose');
    if (mongoose?.connection?.readyState === 1 && mongoose.connection.db) return mongoose.connection.db;
  } catch {
    /* mongoose unavailable */
  }
  return null;
}

/** The lifecycle queue: an injected one (tests) or BullMQ. */
export function resolveLifecycleQueue(context: NativeToolContext): LifecycleQueue {
  return (context?.state?.workspaceQueue as LifecycleQueue | undefined) || bullLifecycleQueue;
}

export function resolveRunUserId(context: NativeToolContext): string | null {
  const s = context?.state;
  const id = s?.data?.userId || s?.userId || s?.data?.options?.userId;
  return typeof id === 'string' && id ? id : null;
}

/** `owner/name`, a github.com URL, or an ssh remote → canonical parts + clone URL. */
export function normalizeGithubRepo(input: unknown): { owner: string; repo: string; url: string } | null {
  const raw = String(input ?? '').trim();
  const m =
    /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw) ||
    /^https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw) ||
    /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(raw);
  if (!m) return null;
  const [, owner, repo] = m;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;
