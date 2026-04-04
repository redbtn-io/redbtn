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
exports.executeConnection = executeConnection;
const templateRenderer_1 = require("../templateRenderer");
const errorHandler_1 = require("./errorHandler");
// Debug logging
const DEBUG = false;
/**
 * Execute a connection step (with error handling wrapper)
 */
function executeConnection(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        // If error handling configured, use it
        if (config.errorHandling) {
            return (0, errorHandler_1.executeWithErrorHandling)(() => executeConnectionInternal(config, state), config.errorHandling, {
                type: 'connection',
                field: config.outputField,
            });
        }
        return executeConnectionInternal(config, state);
    });
}
/**
 * Internal connection execution logic
 */
function executeConnectionInternal(config, state) {
    return __awaiter(this, void 0, void 0, function* () {
        // Validate required fields
        if (!config.outputField) {
            throw new Error('Connection step missing required field: outputField');
        }
        if (!config.connectionId && !config.providerId) {
            throw new Error('Connection step requires either connectionId or providerId');
        }
        // Get ConnectionManager from state
        const connectionManager = state.connectionManager;
        if (!connectionManager) {
            throw new Error('ConnectionManager not available in state. Connections feature may not be enabled.');
        }
        // Render any template variables in connectionId
        const connectionId = config.connectionId
            ? (0, templateRenderer_1.renderTemplate)(config.connectionId, state)
            : undefined;
        let context;
        if (connectionId) {
            // Fetch specific connection
            context = yield connectionManager.getConnection(connectionId);
            if (!context) {
                throw new Error(`Connection not found: ${connectionId}`);
            }
        }
        else if (config.providerId) {
            // Fetch default connection for provider
            const providerId = (0, templateRenderer_1.renderTemplate)(config.providerId, state);
            context = yield connectionManager.getDefaultConnection(providerId);
            if (!context) {
                throw new Error(`No connection found for provider: ${providerId}`);
            }
        }
        if (!context) {
            throw new Error('Failed to resolve connection');
        }
        if (DEBUG) {
            console.log('[ConnectionExecutor] Resolved connection:', {
                connectionId: context.connection.connectionId,
                providerId: context.provider.providerId,
                status: context.connection.status,
            });
        }
        // Check connection status
        if (context.connection.status !== 'active') {
            throw new Error(`Connection is not active (status: ${context.connection.status})`);
        }
        // Build output based on include setting
        const include = config.include || 'headers';
        const output = {
            headers: context.credentials.headers,
            providerId: context.provider.providerId,
            connectionId: context.connection.connectionId,
            status: context.connection.status,
        };
        if (include === 'account' || include === 'full') {
            output.accountInfo = context.connection.accountInfo ? {
                email: context.connection.accountInfo.email,
                name: context.connection.accountInfo.name,
                avatarUrl: context.connection.accountInfo.avatarUrl,
                externalId: context.connection.accountInfo.externalId,
            } : undefined;
        }
        // Note: We intentionally don't expose raw credentials in 'headers' or 'account' mode
        // for security. Only 'full' mode includes them, and should be used carefully.
        if (include === 'full') {
            // Include raw credentials for custom header building
            output.credentials = {
                apiKey: context.credentials.raw.apiKey,
                accessToken: context.credentials.raw.accessToken,
                // Note: We don't expose username/password for basic auth by default
            };
        }
        return {
            [config.outputField]: output,
        };
    });
}
exports.default = executeConnection;
