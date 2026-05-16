/**
 * System resource identification and gating
 *
 * The platform uses a canonical system-user ID for ownership tracking.
 * During the migration from legacy 'system' string IDs, we check both
 * the canonical ID and the legacy string for backward compatibility.
 */

export const SYSTEM_USER_ID = '000000000000000000000001';
export const LEGACY_SYSTEM_USER_ID = 'system';

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
  return (
    String(ownerId) === SYSTEM_USER_ID ||
    String(ownerId) === LEGACY_SYSTEM_USER_ID
  );
}
