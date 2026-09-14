/**
 * `rreg_` — the ONE credential a workspace container holds.
 *
 * Minted here (the engine is the producer that spawns the container) and
 * verified by the desktop gateway, which binds it to the installId it was issued
 * for, so a token for workspace A cannot register as B.
 *
 * There is deliberately no literal fallback secret: the previous
 * `'redbtn-workspace-gateway-secret'` default meant that in any deployment
 * missing both env vars, anyone could forge a token for any userId (48a P1-2).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface IWorkspaceTokenPayload {
  sub: 'workspace-connector';
  workspaceId: string;
  checkoutId: string;
  installId: string;
  userId: string;
  scope: 'workspace:connect';
  iat: number;
  exp: number;
}

export type VerifiedWorkspaceToken = IWorkspaceTokenPayload & {
  bearerType: 'workspace-registration';
};

export class WorkspaceTokenSecretMissingError extends Error {
  constructor() {
    super(
      'Cannot mint or verify a workspace registration token: neither INTERNAL_SERVICE_KEY nor JWT_SECRET is set.'
    );
    this.name = 'WorkspaceTokenSecretMissingError';
  }
}

function getSecret(): string {
  const secret = process.env.INTERNAL_SERVICE_KEY || process.env.JWT_SECRET;
  if (!secret) throw new WorkspaceTokenSecretMissingError();
  return secret;
}

export function isWorkspaceRegistrationToken(token: unknown): token is string {
  return typeof token === 'string' && token.startsWith('rreg_');
}

export function createWorkspaceRegistrationToken(params: {
  workspaceId: string;
  checkoutId: string;
  installId: string;
  userId: string;
  ttlSeconds?: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  // Default TTL tracks the lease, not an arbitrary hour: the token is checked at
  // handshake, and a reconnect after expiry (a WS drop, a webapp deploy) would
  // otherwise kill a still-leased run (48a S7).
  const ttl = params.ttlSeconds ?? DEFAULT_TOKEN_TTL_SECONDS;
  const payload: IWorkspaceTokenPayload = {
    sub: 'workspace-connector',
    workspaceId: params.workspaceId,
    checkoutId: params.checkoutId,
    installId: params.installId,
    userId: params.userId,
    scope: 'workspace:connect',
    iat: now,
    exp: now + ttl,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `rreg_${payloadB64}.${signature}`;
}

export const DEFAULT_TOKEN_TTL_SECONDS = 4 * 60 * 60;

export function verifyWorkspaceRegistrationToken(token: string): VerifiedWorkspaceToken | null {
  if (!isWorkspaceRegistrationToken(token)) return null;

  const raw = token.slice(5);
  const dotIdx = raw.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payloadB64 = raw.slice(0, dotIdx);
  const sigB64 = raw.slice(dotIdx + 1);

  const expectedSig = createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  const sigBuf = Buffer.from(sigB64);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as IWorkspaceTokenPayload;
    if (payload.sub !== 'workspace-connector' || payload.scope !== 'workspace:connect') return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp < now) return null;
    if (!payload.workspaceId || !payload.checkoutId || !payload.installId || !payload.userId) return null;
    return { ...payload, bearerType: 'workspace-registration' };
  } catch {
    return null;
  }
}
