/**
 * System-user identity
 *
 * Platform-owned resources (system graphs, nodes, neurons) are stored with a
 * sentinel `userId` rather than a real account id. Historically that sentinel
 * was the literal string `'system'`. The platform-ownership-unify migration
 * introduced a canonical 24-char hex ObjectId — `SYSTEM_USER_ID` — so system
 * resources look like every other resource at the schema level.
 *
 * The two ids coexist during (and after) the migration: a freshly migrated
 * prod DB owns system resources by the canonical id, while a not-yet-migrated
 * environment — or a rolled-back one — still owns them by `'system'`. The
 * engine must therefore treat BOTH ids as "the system user" so it can load
 * system graphs/neurons regardless of which id the DB currently holds. This
 * also makes re-running the migration safe with respect to a deployed engine.
 *
 * @see GraphRegistry, NeuronRegistry — query system resources with
 *      `{ userId: { $in: SYSTEM_USER_IDS } }`.
 */

/** Canonical system-user ObjectId (post-migration). */
export const SYSTEM_USER_ID = '000000000000000000000001';

/** Legacy system-user sentinel string (pre-migration / rolled-back). */
export const LEGACY_SYSTEM_USER_ID = 'system';

/**
 * Every value that identifies the platform system user. Use this in MongoDB
 * queries (`{ userId: { $in: SYSTEM_USER_IDS } }`) so a query matches system
 * resources whichever id form the DB currently stores.
 */
export const SYSTEM_USER_IDS: readonly string[] = [
  LEGACY_SYSTEM_USER_ID,
  SYSTEM_USER_ID,
];

/**
 * True when `userId` identifies the platform system user — i.e. it is either
 * the legacy `'system'` sentinel or the canonical `SYSTEM_USER_ID`.
 *
 * Returns false for any other value, including a real 24-char ObjectId that
 * merely belongs to a normal user.
 */
export function isSystemUserId(userId: string | null | undefined): boolean {
  return userId != null && SYSTEM_USER_IDS.includes(userId);
}
