/**
 * System resource identification and gating
 *
 * The platform uses a canonical system-user ID for ownership tracking.
 * (The legacy 'system' string sentinel was fully migrated away on
 * 2026-08-05 — canonical is the only representation.)
 */

export const SYSTEM_USER_ID = '000000000000000000000001';

/**
 * Check if a resource is owned by the system
 * @param resource - The resource object to check
 * @param ownerField - The field name containing the owner ID (default: 'userId')
 * @returns true if the resource is system-owned
 */
export function isSystemResource(
  resource: Record<string, unknown> | null | undefined,
  ownerField = 'userId'
): boolean {
  if (!resource || typeof resource !== 'object') return false;
  
  // Check isSystem flag first (explicit marker)
  if (resource.isSystem === true) return true;
  
  // Check canonical and legacy system user IDs
  const ownerId = resource[ownerField];
  return String(ownerId) === SYSTEM_USER_ID;
}
