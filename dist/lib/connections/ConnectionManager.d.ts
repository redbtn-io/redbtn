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
export declare function decryptCredentials(credentials: ConnectionCredentials): ConnectionCredentials;
export declare function buildAuthHeaders(provider: ConnectionProvider, credentials: ConnectionCredentials): Record<string, string>;
export declare function resolveCredentials(connection: UserConnection, provider: ConnectionProvider): ResolvedCredentials;
export declare function isTokenExpiring(tokenMetadata?: TokenMetadata, bufferSeconds?: number): boolean;
export declare class ConnectionManager {
    private connectionsCache;
    private userId;
    private fetchConnection;
    private fetchDefaultConnection;
    private refreshConnection?;
    constructor(options: {
        userId: string;
        fetchConnection: (connectionId: string) => Promise<{
            connection: UserConnection;
            provider: ConnectionProvider;
        } | null>;
        fetchDefaultConnection: (providerId: string) => Promise<{
            connection: UserConnection;
            provider: ConnectionProvider;
        } | null>;
        refreshConnection?: (connectionId: string) => Promise<UserConnection | null>;
    });
    getConnection(connectionId: string): Promise<ConnectionContext | null>;
    getDefaultConnection(providerId: string): Promise<ConnectionContext | null>;
    getAuthHeaders(connectionIdOrProviderId: string, useDefault?: boolean): Promise<Record<string, string> | null>;
    clearCache(connectionId?: string): void;
}
export default ConnectionManager;
