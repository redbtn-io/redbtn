/**
 * Exec-guard — runtime gates for exec/computer tools (exec-binding Goal 2).
 *
 * Runs AFTER the capability check passes (enforce.ts) and BEFORE the tool
 * handler, at the single `callTool` chokepoint. Only exec/computer/environment
 * tools are guarded; everything else returns immediately.
 *
 * Gates (defense-in-depth layers 7-8, all fail-closed):
 *   - KILL SWITCH (D11): an out-of-band Redis flag (global / per-user / per-env)
 *     disables all exec instantly without a redeploy. Set → DENY.
 *   - RATE LIMIT: per-user + per-env fixed-window exec caps bound runaway loops.
 *   - DURABLE AUDIT (D12): every exec/computer ATTEMPT is recorded via the webapp.
 *     For these high-risk resources the audit is FAIL-CLOSED — an attempt that
 *     cannot be durably logged is DENIED (no silent unlogged exec).
 *
 * On block, throws `ExecBlockedError`; the caller (callTool) maps it to a
 * model-readable `isError` result (same shape as a capability denial).
 *
 * Env:
 *   REDIS_URL              redis connection (default redis://localhost:6379)
 *   WEBAPP_URL             audit sink (default http://localhost:3000)
 *   EXEC_RATE_MAX          per-user attempts per window (default 30)
 *   EXEC_RATE_MAX_ENV      per-env attempts per window (default 60)
 *   EXEC_RATE_WINDOW_S     window seconds (default 60)
 *   EXEC_AUDIT_FAIL_OPEN   'true' disables fail-closed-on-audit (NOT recommended)
 *
 * @module lib/permissions/exec-guard
 */

import type { NativeToolContext } from '../tools/native-registry';
import { getDataToolRule } from './tool-map';
import { isFailClosedResource } from './enforce';
import { resolveWebappBase, buildAuthHeaders, resolveField } from './persist-denial';

/** Thrown when a runtime gate (kill switch / rate limit / audit) blocks an exec op. */
export class ExecBlockedError extends Error {
  readonly code: 'kill_switch' | 'rate_limited' | 'audit_unavailable';
  readonly resource: string;
  readonly address: string;
  constructor(args: { code: ExecBlockedError['code']; resource: string; address: string; message: string }) {
    super(args.message);
    this.name = 'ExecBlockedError';
    this.code = args.code;
    this.resource = args.resource;
    this.address = args.address;
  }
}

/** True if this tool is a fail-closed exec/computer/environment tool (guarded). */
export function isGuardedExecTool(name: string): boolean {
  const rule = getDataToolRule(name);
  return !!rule && isFailClosedResource(rule.resource);
}

// ── Redis (lazy singleton, mirrors desktop-request.ts) ─────────────────────
interface RedisLike {
  get(k: string): Promise<string | null>;
  incr(k: string): Promise<number>;
  expire(k: string, s: number): Promise<number>;
}
let _redis: RedisLike | null | undefined;

/** Test seam: inject a fake redis client (or null to disable). */
export function __setRedisForTest(client: RedisLike | null): void {
  _redis = client;
}

function redis(): RedisLike | null {
  if (_redis !== undefined) return _redis; // injected (incl. explicit null) or already built
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ioredis');
    const IORedis = mod?.default ?? mod; // interop: module.exports=class AND .default
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    _redis = new IORedis(url, { maxRetriesPerRequest: 3 }) as RedisLike;
  } catch {
    _redis = null;
  }
  return _redis;
}

function intEnv(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ── The gate ────────────────────────────────────────────────────────────────

/**
 * Run the exec runtime gates for a guarded tool. Resolves on ALLOW (after a
 * durable audit); throws ExecBlockedError on any block. No-op for non-exec tools.
 */
export async function runExecGuard(
  context: NativeToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const rule = getDataToolRule(name);
  if (!rule || !isFailClosedResource(rule.resource)) return; // not a guarded tool

  const resource = rule.resource;
  const userId = resolveField(context, 'userId') ?? '';
  const envId = typeof args?.environmentId === 'string' ? args.environmentId.trim() : '';
  const address = envId || '*';
  const r = redis();

  // ── Gate 8a: kill switch. Fail-closed on a genuine flag; if Redis is
  //    UNREACHABLE we do NOT block here (the audit gate below is the hard
  //    fail-closed — a kill switch that can't be read shouldn't wedge all exec,
  //    but an unloggable exec must be denied). ─────────────────────────────────
  if (r) {
    try {
      const flags = await Promise.all([
        r.get('exec:kill:global'),
        userId ? r.get(`exec:kill:user:${userId}`) : Promise.resolve(null),
        envId ? r.get(`exec:kill:env:${envId}`) : Promise.resolve(null),
      ]);
      const which = ['global', 'user', 'env'][flags.findIndex((f) => f)] ?? '';
      if (flags.some((f) => f)) {
        throw new ExecBlockedError({
          code: 'kill_switch', resource, address,
          message: `Permission denied: exec is disabled by the ${which} kill switch. An operator has halted command execution.`,
        });
      }
    } catch (e) {
      if (e instanceof ExecBlockedError) throw e;
      /* Redis read failed — don't wedge on kill-switch read; audit gate is the hard stop. */
    }

    // ── Gate 8b: rate limit (fixed window, per-user + per-env). ───────────────
    try {
      const win = intEnv('EXEC_RATE_WINDOW_S', 60);
      const bucket = Math.floor(Date.now() / 1000 / win);
      const checks: Array<{ key: string; max: number }> = [];
      if (userId) checks.push({ key: `exec:rate:user:${userId}:${bucket}`, max: intEnv('EXEC_RATE_MAX', 30) });
      if (envId) checks.push({ key: `exec:rate:env:${envId}:${bucket}`, max: intEnv('EXEC_RATE_MAX_ENV', 60) });
      for (const c of checks) {
        const n = await r.incr(c.key);
        if (n === 1) await r.expire(c.key, win + 5);
        if (n > c.max) {
          throw new ExecBlockedError({
            code: 'rate_limited', resource, address,
            message: `Permission denied: exec rate limit exceeded (${c.max}/${win}s). Slow down or an operator must raise the limit.`,
          });
        }
      }
    } catch (e) {
      if (e instanceof ExecBlockedError) throw e;
      /* Redis error on rate path — non-fatal; the audit gate still applies. */
    }
  }

  // ── Gate 7: durable audit, FAIL-CLOSED (D12). Record the ATTEMPT; if it
  //    cannot be durably written, DENY (no silent unlogged exec). ─────────────
  const ok = await auditAttempt(context, name, resource, rule.action, address, 'allowed');
  if (!ok && process.env.EXEC_AUDIT_FAIL_OPEN !== 'true') {
    throw new ExecBlockedError({
      code: 'audit_unavailable', resource, address,
      message: `Permission denied: exec attempt could not be durably audited (audit sink unavailable). ${resource} is fail-closed on audit — no unlogged execution.`,
    });
  }
}

/**
 * POST an exec-attempt audit record to the webapp. Returns true iff durably
 * written (2xx). Never throws. NOTE: we do NOT send the full command (may carry
 * secrets) — only tool/resource/address/outcome. Trust boundary: userId derived
 * from the token/header by the webapp, never from the body.
 */
export async function auditAttempt(
  context: NativeToolContext,
  name: string,
  resource: string,
  action: string,
  address: string,
  outcome: 'allowed' | 'blocked',
  blockCode?: string,
): Promise<boolean> {
  try {
    const base = resolveWebappBase();
    const { headers, canAuth } = buildAuthHeaders(context);
    if (!base || !canAuth) return false; // cannot durably persist → caller decides (fail-closed)
    const body = {
      runId: resolveField(context, 'runId') ?? null,
      graphId: resolveField(context, 'graphId') ?? null,
      conversationId: resolveField(context, 'conversationId') ?? null,
      agentId: resolveField(context, 'agentId') ?? null,
      resource, action, address, toolName: name, outcome,
      blockCode: blockCode ?? null,
    };
    const res = await fetch(`${base}/api/v1/permissions/exec-attempts`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}
