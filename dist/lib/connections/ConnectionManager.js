"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionManager = void 0;
exports.decryptCredentials = decryptCredentials;
exports.buildAuthHeaders = buildAuthHeaders;
exports.resolveCredentials = resolveCredentials;
exports.isTokenExpiring = isTokenExpiring;
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
const crypto_1 = require("../crypto");
function decryptCredentials(credentials) {
    const decrypted = {};
    if (credentials.apiKey) {
        decrypted.apiKey = (0, crypto_1.isEncrypted)(credentials.apiKey) ? (0, crypto_1.decrypt)(credentials.apiKey) : credentials.apiKey;
    }
    if (credentials.accessToken) {
        decrypted.accessToken = (0, crypto_1.isEncrypted)(credentials.accessToken) ? (0, crypto_1.decrypt)(credentials.accessToken) : credentials.accessToken;
    }
    if (credentials.refreshToken) {
        decrypted.refreshToken = (0, crypto_1.isEncrypted)(credentials.refreshToken) ? (0, crypto_1.decrypt)(credentials.refreshToken) : credentials.refreshToken;
    }
    if (credentials.username) {
        decrypted.username = credentials.username;
    }
    if (credentials.password) {
        decrypted.password = (0, crypto_1.isEncrypted)(credentials.password) ? (0, crypto_1.decrypt)(credentials.password) : credentials.password;
    }
    if (credentials.customFields) {
        decrypted.customFields = {};
        for (const [key, value] of Object.entries(credentials.customFields)) {
            decrypted.customFields[key] = (0, crypto_1.isEncrypted)(value) ? (0, crypto_1.decrypt)(value) : value;
        }
    }
    return decrypted;
}
function buildAuthHeaders(provider, credentials) {
    var _a;
    const headers = {};
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
                if (((_a = provider.basicAuthConfig) === null || _a === void 0 ? void 0 : _a.headerFormat) === 'custom' &&
                    provider.basicAuthConfig.customHeaderName &&
                    provider.basicAuthConfig.customHeaderFormat) {
                    const value = provider.basicAuthConfig.customHeaderFormat
                        .replace('{{username}}', credentials.username)
                        .replace('{{password}}', credentials.password);
                    headers[provider.basicAuthConfig.customHeaderName] = value;
                }
                else {
                    const encoded = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
                    headers['Authorization'] = `Basic ${encoded}`;
                }
            }
            break;
        default:
            if (credentials.accessToken) {
                headers['Authorization'] = `Bearer ${credentials.accessToken}`;
            }
            else if (credentials.apiKey) {
                headers['Authorization'] = `Bearer ${credentials.apiKey}`;
            }
    }
    return headers;
}
function resolveCredentials(connection, provider) {
    const decrypted = decryptCredentials(connection.credentials);
    const headers = buildAuthHeaders(provider, decrypted);
    let type = 'custom';
    if (provider.authType === 'api_key')
        type = 'api_key';
    else if (provider.authType === 'oauth2')
        type = 'bearer';
    else if (provider.authType === 'basic')
        type = 'basic';
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
function isTokenExpiring(tokenMetadata, bufferSeconds = 300) {
    if (!(tokenMetadata === null || tokenMetadata === void 0 ? void 0 : tokenMetadata.expiresAt))
        return false;
    const expiresAt = new Date(tokenMetadata.expiresAt);
    const bufferMs = bufferSeconds * 1000;
    return expiresAt.getTime() - Date.now() < bufferMs;
}
class ConnectionManager {
    constructor(options) {
        this.connectionsCache = new Map();
        this.userId = options.userId;
        this.fetchConnection = options.fetchConnection;
        this.fetchDefaultConnection = options.fetchDefaultConnection;
        this.refreshConnection = options.refreshConnection;
    }
    getConnection(connectionId) {
        return __awaiter(this, void 0, void 0, function* () {
            let cached = this.connectionsCache.get(connectionId);
            if (cached) {
                if (cached.provider.authType === 'oauth2' && isTokenExpiring(cached.connection.tokenMetadata)) {
                    if (this.refreshConnection) {
                        const refreshed = yield this.refreshConnection(connectionId);
                        if (refreshed) {
                            cached = Object.assign(Object.assign({}, cached), { connection: refreshed, credentials: resolveCredentials(refreshed, cached.provider) });
                            this.connectionsCache.set(connectionId, cached);
                        }
                    }
                }
                return cached;
            }
            const result = yield this.fetchConnection(connectionId);
            if (!result)
                return null;
            const { connection, provider } = result;
            if (connection.userId !== this.userId) {
                console.warn(`[ConnectionManager] Connection ${connectionId} does not belong to user ${this.userId}`);
                return null;
            }
            if (provider.authType === 'oauth2' && isTokenExpiring(connection.tokenMetadata) && this.refreshConnection) {
                const refreshed = yield this.refreshConnection(connectionId);
                if (refreshed) {
                    const context = { connection: refreshed, provider, credentials: resolveCredentials(refreshed, provider) };
                    this.connectionsCache.set(connectionId, context);
                    return context;
                }
            }
            const context = { connection, provider, credentials: resolveCredentials(connection, provider) };
            this.connectionsCache.set(connectionId, context);
            return context;
        });
    }
    getDefaultConnection(providerId) {
        return __awaiter(this, void 0, void 0, function* () {
            const result = yield this.fetchDefaultConnection(providerId);
            if (!result)
                return null;
            const { connection } = result;
            if (connection.userId !== this.userId)
                return null;
            return this.getConnection(connection.connectionId);
        });
    }
    getAuthHeaders(connectionIdOrProviderId_1) {
        return __awaiter(this, arguments, void 0, function* (connectionIdOrProviderId, useDefault = false) {
            var _a;
            const context = useDefault
                ? yield this.getDefaultConnection(connectionIdOrProviderId)
                : yield this.getConnection(connectionIdOrProviderId);
            return (_a = context === null || context === void 0 ? void 0 : context.credentials.headers) !== null && _a !== void 0 ? _a : null;
        });
    }
    clearCache(connectionId) {
        if (connectionId) {
            this.connectionsCache.delete(connectionId);
        }
        else {
            this.connectionsCache.clear();
        }
    }
}
exports.ConnectionManager = ConnectionManager;
exports.default = ConnectionManager;
