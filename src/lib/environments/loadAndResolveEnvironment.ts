/**
 * loadAndResolveEnvironment — bridge between Phase A runtime and Phase B schema.
 *
 * # What this is
 *
 * The Phase A `EnvironmentManager.acquire()` API takes a fully-resolved
 * `IEnvironment` document plus an already-resolved `sshKey: string`. This
 * helper does the lookup + resolution + access check that the caller would
 * otherwise have to inline at every call site (worker tool execution, REST
 * status endpoints, etc.).
 *
 * Phase A intentionally avoided this so the runtime stays free of any hard
 * compile-time dependency on Mongoose or `@redbtn/redsecrets`. Phase B (this
 * module) re-introduces those dependencies at the engine boundary so all
 * call sites use the same lookup + access policy.
 *
 * # What it does (in order)
 *
 *   1. Loads the IEnvironment doc from the `environments` collection by
 *      `environmentId`. Throws `EnvironmentNotFoundError` if missing.
 *   2. Verifies the caller `userId` has access — owner OR `isPublic === true`.
 *      Throws `EnvironmentAccessDeniedError` if not.
 *   3. Resolves `env.secretRef` via `@redbtn/redsecrets` (user scope, app
 *      `redbtn`). Throws `EnvironmentSecretMissingError` if the secret is
 *      not present or empty.
 *   4. Returns `{ env, sshKey }` ready to feed into
 *      `environmentManager.acquire(env, sshKey, userId)`.
 *
 * # Why dynamic imports
 *
 * Both `mongoose` and `@redbtn/redsecrets` are loaded lazily so the engine's
 * non-environment code paths don't pay the cost. This also keeps the engine
 * tarball usable in environments where redsecrets isn't installed (e.g. the
 * MCP-only worker variant some consumers ship).
 *
 * # Phase B vs Phase F
 *
 * The Studio UI (Phase F) goes through the REST API (`/api/v1/environments/:id`),
 * NOT through this helper — the API does its own access checks via
 * Mongoose-side queries. This helper is for the in-process tool path
 * (ssh_shell, ssh_copy, fs pack, process pack), where access has already
 * been gated by the run's userId at the time the graph step fires.
 *
 * @module lib/environments/loadAndResolveEnvironment
 */

import { ENV_DEFAULTS, type IEnvironment, type EnvironmentReconnectPolicy } from './types';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the requested environmentId doesn't exist in the
 * `environments` collection. Tool callers should surface this as a
 * "configuration error" — the graph references an env that was deleted or
 * never created.
 */
export class EnvironmentNotFoundError extends Error {
  readonly code = 'ENV_NOT_FOUND';
  constructor(public readonly environmentId: string) {
    super(`Environment not found: ${environmentId}`);
    this.name = 'EnvironmentNotFoundError';
  }
}

/**
 * Thrown when the caller `userId` does not have access to the environment.
 * Owner-only by default; `isPublic: true` opens read/use to any user. Future
 * Phase B+ may add explicit participants[]; until then we keep the policy
 * tight.
 */
export class EnvironmentAccessDeniedError extends Error {
  readonly code = 'ENV_ACCESS_DENIED';
  constructor(
    public readonly environmentId: string,
    public readonly userId: string,
  ) {
    super(`User ${userId} does not have access to environment ${environmentId}`);
    this.name = 'EnvironmentAccessDeniedError';
  }
}

/**
 * Thrown when `env.secretRef` resolves to a missing or empty secret. The
 * caller can surface this to the user as "the SSH key for this environment
 * is missing or empty — re-add the secret in /settings/secrets".
 */
export class EnvironmentSecretMissingError extends Error {
  readonly code = 'ENV_SECRET_MISSING';
  constructor(
    public readonly environmentId: string,
    public readonly secretRef: string,
  ) {
    super(`Secret '${secretRef}' for environment ${environmentId} is missing or empty`);
    this.name = 'EnvironmentSecretMissingError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Apply Phase A defaults to a raw Mongo doc. The Mongoose schema (Phase B)
 * also enforces these defaults at insert time, but applying them here too
 * means we tolerate documents that pre-date the schema (or that were
 * inserted via the native driver).
 */
function applyDefaults(raw: Record<string, unknown>): IEnvironment {
  const reconnectRaw = (raw.reconnect ?? {}) as Partial<EnvironmentReconnectPolicy>;
  return {
    environmentId: String(raw.environmentId),
    userId: String(raw.userId),
    name: String(raw.name ?? ''),
    description: raw.description as string | undefined,
    kind: 'self-hosted',
    host: String(raw.host),
    port: typeof raw.port === 'number' ? raw.port : ENV_DEFAULTS.port,
    user: String(raw.user),
    secretRef: String(raw.secretRef ?? ''),
    workingDir: raw.workingDir as string | undefined,
    idleTimeoutMs: typeof raw.idleTimeoutMs === 'number' ? raw.idleTimeoutMs : ENV_DEFAULTS.idleTimeoutMs,
    maxLifetimeMs: typeof raw.maxLifetimeMs === 'number' ? raw.maxLifetimeMs : ENV_DEFAULTS.maxLifetimeMs,
    reconnect: {
      maxAttempts: typeof reconnectRaw.maxAttempts === 'number' ? reconnectRaw.maxAttempts : ENV_DEFAULTS.reconnect.maxAttempts,
      backoffMs: typeof reconnectRaw.backoffMs === 'number' ? reconnectRaw.backoffMs : ENV_DEFAULTS.reconnect.backoffMs,
      maxBackoffMs: typeof reconnectRaw.maxBackoffMs === 'number' ? reconnectRaw.maxBackoffMs : ENV_DEFAULTS.reconnect.maxBackoffMs,
    },
    openCommand: raw.openCommand as string | undefined,
    closeCommand: raw.closeCommand as string | undefined,
    archiveOutputLogs: typeof raw.archiveOutputLogs === 'boolean' ? raw.archiveOutputLogs : ENV_DEFAULTS.archiveOutputLogs,
    isPublic: typeof raw.isPublic === 'boolean' ? raw.isPublic : ENV_DEFAULTS.isPublic,
    createdAt: raw.createdAt instanceof Date ? raw.createdAt : new Date(raw.createdAt as string | number),
    updatedAt: raw.updatedAt instanceof Date ? raw.updatedAt : new Date(raw.updatedAt as string | number),
    lastUsedAt: raw.lastUsedAt
      ? (raw.lastUsedAt instanceof Date ? raw.lastUsedAt : new Date(raw.lastUsedAt as string | number))
      : undefined,
  };
}

/**
 * Owner OR public access. Future versions may add explicit participants[];
 * for now we keep the same policy as ENVIRONMENT-HANDOFF.md §3.5: only the
 * owner can use a non-public environment.
 */
function hasAccess(env: IEnvironment, userId: string): boolean {
  if (env.userId === userId) return true;
  if (env.isPublic) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Optional dependency injection for tests. Production callers pass nothing
 * and the helper picks up `mongoose` + `@redbtn/redsecrets` via dynamic
 * import. Tests pass mocked versions to avoid spinning up a Mongo + Mongo
 * `secrets` collection.
 *
 * `secretsResolver` returns the raw secret value (PEM string) for a given
 * (name, userId) pair. Production wires this to `repository.resolve(...)`
 * from `@redbtn/redsecrets` scoped to the user.
 *
 * `findEnvironment` returns the raw Mongo doc by environmentId, or null.
 * Production wires this to `db.collection('environments').findOne(...)`.
 */
export interface LoadEnvironmentDeps {
  findEnvironment?: (environmentId: string) => Promise<Record<string, unknown> | null>;
  secretsResolver?: (name: string, userId: string) => Promise<string | null>;
}

/**
 * Load + access-check + secret-resolve an environment.
 *
 * @param environmentId — ID from the graph node config (or REST path param)
 * @param userId — Caller user (must own OR env must be public)
 * @param deps — Optional injection point for tests
 * @returns `{ env, sshKey }` ready to pass to `environmentManager.acquire()`
 *
 * @throws EnvironmentNotFoundError — env doesn't exist
 * @throws EnvironmentAccessDeniedError — userId lacks access
 * @throws EnvironmentSecretMissingError — secretRef resolves to nothing
 */
export async function loadAndResolveEnvironment(
  environmentId: string,
  userId: string,
  deps: LoadEnvironmentDeps = {},
): Promise<{ env: IEnvironment; sshKey: string }> {
  if (!environmentId || typeof environmentId !== 'string') {
    throw new Error(`loadAndResolveEnvironment: environmentId must be a non-empty string, got: ${typeof environmentId}`);
  }
  if (!userId || typeof userId !== 'string') {
    throw new Error(`loadAndResolveEnvironment: userId must be a non-empty string, got: ${typeof userId}`);
  }

  // -------------------------------------------------------------------------
  // 1. Load the Mongo doc
  // -------------------------------------------------------------------------
  const findEnvironment = deps.findEnvironment ?? (await defaultFindEnvironment());
  const raw = await findEnvironment(environmentId);
  if (!raw) {
    throw new EnvironmentNotFoundError(environmentId);
  }

  const env = applyDefaults(raw);

  // -------------------------------------------------------------------------
  // 2. Access check
  // -------------------------------------------------------------------------
  if (!hasAccess(env, userId)) {
    throw new EnvironmentAccessDeniedError(environmentId, userId);
  }

  // -------------------------------------------------------------------------
  // 3. Secret resolution
  // -------------------------------------------------------------------------
  if (!env.secretRef) {
    throw new EnvironmentSecretMissingError(environmentId, '<missing>');
  }
  const secretsResolver = deps.secretsResolver ?? (await defaultSecretsResolver());
  // Resolve in the OWNER's scope, not the caller's scope. Public envs are
  // intentionally usable by other users but they share the owner's key.
  const sshKey = await secretsResolver(env.secretRef, env.userId);
  if (!sshKey) {
    throw new EnvironmentSecretMissingError(environmentId, env.secretRef);
  }

  return { env, sshKey };
}

// ---------------------------------------------------------------------------
// Default dependency factories — production-only
// ---------------------------------------------------------------------------

/**
 * Default `findEnvironment` — uses the active Mongoose connection's native
 * driver to look up `environments.findOne({ environmentId })`. Returns null
 * on miss.
 *
 * Lazily imports mongoose so the engine doesn't hard-depend on it for users
 * who only use Phase A in-process (no schema lookups).
 */
async function defaultFindEnvironment(): Promise<(environmentId: string) => Promise<Record<string, unknown> | null>> {
  const mongoose = (await import('mongoose')).default;
  return async (environmentId: string) => {
    const db = mongoose.connection?.db;
    if (!db) {
      throw new Error('loadAndResolveEnvironment: mongoose is not connected — call connectToDatabase() first');
    }
    const doc = await db.collection('environments').findOne({ environmentId });
    return doc as Record<string, unknown> | null;
  };
}

/**
 * Default `secretsResolver` — uses `@redbtn/redsecrets` scoped to the user
 * and the `redbtn` app namespace.
 *
 * Lazily imports redsecrets so the engine tarball remains usable in
 * environments where the package isn't installed (degraded behaviour: any
 * environmentId-based tool call will throw at this line, which is correct —
 * those tools fundamentally need the secret store).
 */
async function defaultSecretsResolver(): Promise<(name: string, userId: string) => Promise<string | null>> {
  const mongoose = (await import('mongoose')).default;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { repository: secretsRepo } = await import('@redbtn/redsecrets' as any);
  return async (name: string, userId: string) => {
    const db = mongoose.connection?.db;
    if (!db) {
      throw new Error('loadAndResolveEnvironment: mongoose is not connected — secret resolution requires Mongo');
    }
    const batch = await secretsRepo.resolve(
      db,
      {
        names: [name],
        appName: 'redbtn',
        scope: 'user',
        scopeId: userId,
      },
      'secrets',
    );
    const value = batch?.[name];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
}
