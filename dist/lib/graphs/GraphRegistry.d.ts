import type { Db } from 'mongodb';
import { GraphConfig, CompiledGraph } from '../types/graph';
import type { RedConfig } from '../../index';
type PartialRedConfig = Pick<RedConfig, 'databaseUrl'> & Partial<Omit<RedConfig, 'databaseUrl'>>;
export declare class GraphNotFoundError extends Error {
    constructor(message: string);
}
export declare class GraphAccessDeniedError extends Error {
    constructor(message: string);
}
export declare class GraphRegistry {
    private compiledCache;
    private configCache;
    private db;
    private config;
    constructor(config: PartialRedConfig);
    initialize(): Promise<void>;
    getGraph(graphId: string, userId: string): Promise<CompiledGraph>;
    getConfig(graphId: string, userId: string): Promise<GraphConfig>;
    private validateAccess;
    private getUserTier;
    getUserGraphs(userId: string): Promise<GraphConfig[]>;
    private updateUsageStats;
    clearCache(userId?: string): Promise<void>;
    getCacheStats(): {
        compiled: {
            size: number;
            max: number;
        };
        config: {
            size: number;
            max: number;
        };
    };
    subscribeToInvalidations(redisUrl: string): Promise<void>;
    watchCollection(mongoDb: Db): Promise<void>;
    shutdown(): Promise<void>;
}
export {};
