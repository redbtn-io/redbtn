/**
 * Connection Step Executor
 *
 * Executes connection steps to fetch and prepare user credentials
 * for authenticated API calls to external services.
 */
import type { ConnectionStepConfig } from '../types';
/**
 * Execute a connection step (with error handling wrapper)
 */
export declare function executeConnection(config: ConnectionStepConfig, state: any): Promise<Partial<any>>;
export default executeConnection;
