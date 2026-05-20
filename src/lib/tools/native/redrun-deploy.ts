/**
 * redrun_deploy — Native Tool
 *
 * Deploy a RedRun workspace: git-sync → build → redeploy → poll until done.
 * Returns build state, runtime status, and the workspace's public URL.
 *
 * Sequence:
 *   1. POST /api/workspaces/:id/git?sync=1         (git-sync if git-sourced)
 *   2. POST /api/workspaces/:id/build?force=true   (enqueue build/redeploy)
 *   3. POST /api/workspaces/:id/lifecycle          (action: redeploy)
 *   4. Poll  GET /api/workspaces/:id every 10s until buildState != 'building'
 *
 * Required env vars:
 *   REDRUN_API_URL   — base URL, e.g. https://run.redbtn.io
 *   REDRUN_API_KEY   — sent as `x-api-key`; must match RedRun's INTERNAL_SERVICE_KEY
 *
 * Optional:
 *   REDRUN_USER_ID   — scope to a specific user's workspaces (`x-user-id`)
 */

import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

interface RedrunDeployArgs {
  workspaceId: string;
  /** Max seconds to wait for build. Default 600. */
  timeoutSeconds?: number;
}

const DEFAULT_TIMEOUT_SECONDS = 600;
const POLL_INTERVAL_MS = 10_000;

function getRedrunBaseUrl(): string {
  return (process.env.REDRUN_API_URL || '').replace(/\/$/, '');
}

function buildRedrunHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const apiKey = process.env.REDRUN_API_KEY;
  const userId = process.env.REDRUN_USER_ID;
  if (apiKey) headers['x-api-key'] = apiKey;
  if (userId) headers['x-user-id'] = userId;
  return headers;
}

async function fetchWorkspace(baseUrl: string, workspaceId: string): Promise<AnyObject | null> {
  const res = await fetch(`${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`, {
    headers: buildRedrunHeaders(),
  });
  if (!res.ok) return null;
  return res.json() as Promise<AnyObject>;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const redrunDeployTool: NativeToolDefinition = {
  description:
    'Deploy a RedRun workspace: runs git-sync (if git-sourced), triggers a build/redeploy, then polls until the build completes and the container is running. Returns buildState, runtime status, and the public URL.',
  inputSchema: {
    type: 'object',
    properties: {
      workspaceId: {
        type: 'string',
        description: 'The RedRun workspace ID (24-char hex).',
      },
      timeoutSeconds: {
        type: 'number',
        description: 'Maximum seconds to wait for the build. Default 600 (10 min).',
        minimum: 30,
        maximum: 1800,
      },
    },
    required: ['workspaceId'],
  },

  async handler(rawArgs: AnyObject, _context: NativeToolContext): Promise<NativeMcpResult> {
    const args = rawArgs as Partial<RedrunDeployArgs>;
    const workspaceId = typeof args.workspaceId === 'string' ? args.workspaceId.trim() : '';
    const timeoutMs = ((typeof args.timeoutSeconds === 'number' && args.timeoutSeconds > 0)
      ? args.timeoutSeconds
      : DEFAULT_TIMEOUT_SECONDS) * 1000;

    if (!workspaceId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'workspaceId is required', code: 'VALIDATION' }) }],
        isError: true,
      };
    }

    const baseUrl = getRedrunBaseUrl();
    if (!baseUrl) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'REDRUN_API_URL env var is not set', code: 'CONFIG' }) }],
        isError: true,
      };
    }

    const headers = buildRedrunHeaders();
    const wsUrl = `${baseUrl}/api/workspaces/${encodeURIComponent(workspaceId)}`;

    // Step 0: fetch workspace to verify it exists and check if git-sourced
    const ws = await fetchWorkspace(baseUrl, workspaceId);
    if (!ws) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Workspace ${workspaceId} not found or API unreachable`, code: 'NOT_FOUND' }) }],
        isError: true,
      };
    }

    const isGitSourced = !!ws.gitSource?.repo;
    const steps: string[] = [];

    // Step 1: git-sync (only if git-sourced)
    if (isGitSourced) {
      try {
        const syncRes = await fetch(`${wsUrl}/git?sync=1`, { method: 'POST', headers });
        steps.push(`git-sync: ${syncRes.status}`);
      } catch (err) {
        steps.push(`git-sync: failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    // Step 2: enqueue build
    try {
      const buildRes = await fetch(`${wsUrl}/build?force=true`, { method: 'POST', headers });
      steps.push(`build-enqueue: ${buildRes.status}`);
    } catch (err) {
      steps.push(`build-enqueue: failed (${err instanceof Error ? err.message : String(err)})`);
    }

    // Step 3: trigger redeploy lifecycle
    try {
      const deployRes = await fetch(`${wsUrl}/lifecycle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action: 'redeploy' }),
      });
      steps.push(`redeploy: ${deployRes.status}`);
    } catch (err) {
      steps.push(`redeploy: failed (${err instanceof Error ? err.message : String(err)})`);
    }

    // Step 4: poll until build completes or timeout
    const deadline = Date.now() + timeoutMs;
    let buildState = 'building';
    let runtimeStatus = '';
    let domain = '';
    let pollCount = 0;

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      pollCount++;

      try {
        const current = await fetchWorkspace(baseUrl, workspaceId);
        if (!current) continue;

        buildState = current.buildState ?? 'unknown';
        runtimeStatus = current.appRuntime?.status ?? '';
        domain = current.appRuntime?.domain || current.appRuntime?.exposedUrl || '';

        if (buildState !== 'building') break;
      } catch {
        // transient error — keep polling
      }
    }

    const timedOut = Date.now() >= deadline && buildState === 'building';

    // If runtime stopped after successful build, kick it
    if (buildState === 'built' && runtimeStatus !== 'running') {
      try {
        await fetch(`${wsUrl}/lifecycle`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action: 'start' }),
        });
        steps.push('start: kicked (was stopped after build)');
        // brief re-poll
        await sleep(5000);
        const final = await fetchWorkspace(baseUrl, workspaceId);
        if (final) {
          runtimeStatus = final.appRuntime?.status ?? runtimeStatus;
          domain = final.appRuntime?.domain || final.appRuntime?.exposedUrl || domain;
        }
      } catch { /* non-fatal */ }
    }

    const success = buildState === 'built' && runtimeStatus === 'running';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: success,
          workspaceId,
          name: ws.name,
          buildState,
          runtimeStatus,
          domain: domain || null,
          pollCount,
          timedOut,
          steps,
          ...(timedOut ? { warning: 'Build did not complete within the timeout. It may still be running.' } : {}),
          ...(!success && !timedOut ? { hint: buildState === 'failed' ? 'Build failed — check build logs in the RedRun UI.' : `Unexpected state: buildState=${buildState}, runtime=${runtimeStatus}` } : {}),
        }),
      }],
      isError: !success && !timedOut,
    };
  },
};

export default redrunDeployTool;
module.exports = redrunDeployTool;
