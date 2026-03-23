/**
 * Connection Manager
 *
 * Runtime utility for accessing and using user connections in graph execution.
 * Fetches connections from the database, decrypts credentials, and provides
 * helpers for making authenticated API calls.
 *
 * This is designed to work with a callback pattern where the actual database
 * access is provided by the caller (typically the webapp which has Mongoose access).
 */
import { isEncrypted, decrypt } from '../crypto';

export interface ConnectionCredentials {
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  username?: string;
  password?: string;
  customFields?: Record<string, string>;
}

export interface TokenMetadata {
  expiresAt?: Date;
  issuedAt?: Date;
  scope?: string;
  tokenType?: string;
}

export interface AccountInfo {
  externalId?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  metadata?: Record<string, any>;
}

export interface UserConnection {
  _id: string;
  connectionId: string;
  userId: string;
  providerId: string;
  label?: string;
  status: 'active' | 'expired' | 'revoked' | 'error' | 'pending';
  credentials: ConnectionCredentials;
  tokenMetadata?: TokenMetadata;
  accountInfo?: AccountInfo;
  isDefault: boolean;
  autoRefresh: boolean;
  lastUsedAt?: Date;
  lastValidatedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConnectionProvider {
  _id: string;
  providerId: string;
  name: string;
  description: string;
  icon?: string;
  color?: string;
  authType: 'oauth2' | 'api_key' | 'basic' | 'multi_credential' | 'custom';
  apiKeyConfig?: {
    headerName: string;
    headerFormat: string;
    testEndpoint?: string;
    testMethod?: string;
    testExpectedStatus?: number;
  };
  basicAuthConfig?: {
    headerFormat: 'basic' | 'custom';
    customHeaderName?: string;
    customHeaderFormat?: string;
    testEndpoint?: string;
    testMethod?: string;
    testExpectedStatus?: number;
  };
  oauth2Config?: {
    tokenUrl: string;
    revokeUrl?: string;
    userinfoUrl?: string;
  };
}

export interface ResolvedCredentials {
  type: 'api_key' | 'bearer' | 'basic' | 'custom';
  headers: Record<string, string>;
  raw: {
    apiKey?: string;
    accessToken?: string;
    username?: string;
    password?: string;
    customFields?: Record<string, string>;
  };
}

export interface ConnectionContext {
  connection: UserConnection;
  provider: ConnectionProvider;
  credentials: ResolvedCredentials;
}

export function decryptCredentials(credentials: ConnectionCredentials): ConnectionCredentials {
  const decrypted: ConnectionCredentials = {};
  if (credentials.apiKey) {
    decrypted.apiKey = isEncrypted(credentials.apiKey) ? decrypt(credentials.apiKey) : credentials.apiKey;
  }
  if (credentials.accessToken) {
    decrypted.accessToken = isEncrypted(credentials.accessToken) ? decrypt(credentials.accessToken) : credentials.accessToken;
  }
  if (credentials.refreshToken) {
    decrypted.refreshToken = isEncrypted(credentials.refreshToken) ? decrypt(credentials.refreshToken) : credentials.refreshToken;
  }
  if (credentials.username) {
    decrypted.username = credentials.username;
  }
  if (credentials.password) {
    decrypted.password = isEncrypted(credentials.password) ? decrypt(credentials.password) : credentials.password;
  }
  if (credentials.customFields) {
    decrypted.customFields = {};
    for (const [key, value] of Object.entries(credentials.customFields)) {
      decrypted.customFields[key] = isEncrypted(value) ? decrypt(value) : value;
    }
  }
  return decrypted;
}

export function buildAuthHeaders(
  provider: ConnectionProvider,
  credentials: ConnectionCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (provider.authType) {
    case 'api_key':
      if (provider.apiKeyConfig && credentials.apiKey) {
        const { headerName, headerFormat } = provider.apiKeyConfig;
        headers[headerName] = headerFormat.replace('{{key}}', credentials.apiKey);
      }
      break;
    case 'oauth2':
      if (credentials.accessToken) {
        headers['Authorization'] = `Bearer ${credentials.accessToken}`;
      }
      break;
    case 'basic':
      if (credentials.username && credentials.password) {
        if (
          provider.basicAuthConfig?.headerFormat === 'custom' &&
          provider.basicAuthConfig.customHeaderName &&
          provider.basicAuthConfig.customHeaderFormat
        ) {
          const value = provider.basicAuthConfig.customHeaderFormat
            .replace('{{username}}', credentials.username)
            .replace('{{password}}', credentials.password);
          headers[provider.basicAuthConfig.customHeaderName] = value;
        } else {
          const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
        }
      }
      break;
    default:
      if (credentials.accessToken) {
        headers['Authorization'] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers['Authorization'] = `Bearer ${credentials.apiKey}`;
      }
  }
  return headers;
}

export function resolveCredentials(connection: UserConnection, provider: ConnectionProvider): ResolvedCredentials {
  const decrypted = decryptCredentials(connection.credentials);
  const headers = buildAuthHeaders(provider, decrypted);
  let type: ResolvedCredentials['type'] = 'custom';
  if (provider.authType === 'api_key') type = 'api_key';
  else if (provider.authType === 'oauth2') type = 'bearer';
  else if (provider.authType === 'basic') type = 'basic';
  return {
    type,
    headers,
    raw: {
      apiKey: decrypted.apiKey,
      accessToken: decrypted.accessToken,
      username: decrypted.username,
      password: decrypted.password,
      customFields: decrypted.customFields,
    },
  };
}

export function isTokenExpiring(tokenMetadata?: TokenMetadata, bufferSeconds = 300): boolean {
  if (!tokenMetadata?.expiresAt) return false;
  const expiresAt = new Date(tokenMetadata.expiresAt);
  const bufferMs = bufferSeconds * 1000;
  return expiresAt.getTime() - Date.now() < bufferMs;
}

export class ConnectionManager {
  private connectionsCache: Map<string, ConnectionContext> = new Map();
  private userId: string;
  private fetchConnection: (connectionId: string) => Promise<{ connection: UserConnection; provider: ConnectionProvider } | null>;
  private fetchDefaultConnection: (providerId: string) => Promise<{ connection: UserConnection; provider: ConnectionProvider } | null>;
  private refreshConnection?: (connectionId: string) => Promise<UserConnection | null>;

  constructor(options: {
    userId: string;
    fetchConnection: (connectionId: string) => Promise<{ connection: UserConnection; provider: ConnectionProvider } | null>;
    fetchDefaultConnection: (providerId: string) => Promise<{ connection: UserConnection; provider: ConnectionProvider } | null>;
    refreshConnection?: (connectionId: string) => Promise<UserConnection | null>;
  }) {
    this.userId = options.userId;
    this.fetchConnection = options.fetchConnection;
    this.fetchDefaultConnection = options.fetchDefaultConnection;
    this.refreshConnection = options.refreshConnection;
  }

  async getConnection(connectionId: string): Promise<ConnectionContext | null> {
    let cached = this.connectionsCache.get(connectionId);
    if (cached) {
      if (cached.provider.authType === 'oauth2' && isTokenExpiring(cached.connection.tokenMetadata)) {
        if (this.refreshConnection) {
          const refreshed = await this.refreshConnection(connectionId);
          if (refreshed) {
            cached = { ...cached, connection: refreshed, credentials: resolveCredentials(refreshed, cached.provider) };
            this.connectionsCache.set(connectionId, cached);
          }
        }
      }
      return cached;
    }
    const result = await this.fetchConnection(connectionId);
    if (!result) return null;
    const { connection, provider } = result;
    if (connection.userId !== this.userId) {
      console.warn(`[ConnectionManager] Connection ${connectionId} does not belong to user ${this.userId}`);
      return null;
    }
    if (provider.authType === 'oauth2' && isTokenExpiring(connection.tokenMetadata) && this.refreshConnection) {
      const refreshed = await this.refreshConnection(connectionId);
      if (refreshed) {
        const context: ConnectionContext = { connection: refreshed, provider, credentials: resolveCredentials(refreshed, provider) };
        this.connectionsCache.set(connectionId, context);
        return context;
      }
    }
    const context: ConnectionContext = { connection, provider, credentials: resolveCredentials(connection, provider) };
    this.connectionsCache.set(connectionId, context);
    return context;
  }

  async getDefaultConnection(providerId: string): Promise<ConnectionContext | null> {
    const result = await this.fetchDefaultConnection(providerId);
    if (!result) return null;
    const { connection } = result;
    if (connection.userId !== this.userId) return null;
    return this.getConnection(connection.connectionId);
  }

  async getAuthHeaders(connectionIdOrProviderId: string, useDefault = false): Promise<Record<string, string> | null> {
    const context = useDefault
      ? await this.getDefaultConnection(connectionIdOrProviderId)
      : await this.getConnection(connectionIdOrProviderId);
    return context?.credentials.headers ?? null;
  }

  clearCache(connectionId?: string): void {
    if (connectionId) {
      this.connectionsCache.delete(connectionId);
    } else {
      this.connectionsCache.clear();
    }
  }
}

export default ConnectionManager;
