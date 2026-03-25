/**
 * Connection Step Executor
 *
 * Executes connection steps to fetch and prepare user credentials
 * for authenticated API calls to external services.
 */
import type { ConnectionStepConfig } from '../types';
import { renderTemplate } from '../templateRenderer';
import { executeWithErrorHandling } from './errorHandler';

// Debug logging
const DEBUG = false;

/**
 * Execute a connection step (with error handling wrapper)
 */
export async function executeConnection(config: ConnectionStepConfig, state: any): Promise<Partial<any>> {
    // If error handling configured, use it
    if (config.errorHandling) {
        return executeWithErrorHandling(
            () => executeConnectionInternal(config, state),
            config.errorHandling,
            {
                type: 'connection',
                field: config.outputField,
            }
        );
    }
    return executeConnectionInternal(config, state);
}

/**
 * Internal connection execution logic
 */
async function executeConnectionInternal(config: ConnectionStepConfig, state: any): Promise<Partial<any>> {
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
        ? renderTemplate(config.connectionId, state)
        : undefined;

    let context: any;

    if (connectionId) {
        // Fetch specific connection
        context = await connectionManager.getConnection(connectionId);
        if (!context) {
            throw new Error(`Connection not found: ${connectionId}`);
        }
    } else if (config.providerId) {
        // Fetch default connection for provider
        const providerId = renderTemplate(config.providerId, state);
        context = await connectionManager.getDefaultConnection(providerId);
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
    const output: Record<string, any> = {
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
}

export default executeConnection;
