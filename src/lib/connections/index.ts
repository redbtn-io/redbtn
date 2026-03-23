/**
 * Connections Module
 *
 * Runtime utilities for managing and using user connections in graph execution.
 */
export {
  ConnectionManager,
  decryptCredentials,
  buildAuthHeaders,
  resolveCredentials,
  isTokenExpiring,
  type ConnectionCredentials,
  type TokenMetadata,
  type AccountInfo,
  type UserConnection,
  type ConnectionProvider,
  type ResolvedCredentials,
  type ConnectionContext,
} from './ConnectionManager';
