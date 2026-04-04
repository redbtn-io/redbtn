/**
 * Global State Client for AI Library
 *
 * Provides access to persistent global state that can be shared across
 * workflow executions. This enables workflows to read and write values
 * that persist beyond a single run.
 */
export declare class GlobalStateClient {
    private baseUrl;
    private userId?;
    private authToken?;
    private workflowId?;
    private internalKey?;
    private cache;
    private cacheTTLMs;
    constructor(options?: Record<string, any>);
    private getHeaders;
    getValue(namespace: string, key: string): Promise<any>;
    getNamespaceValues(namespace: string): Promise<Record<string, any>>;
    setValue(namespace: string, key: string, value: any, options?: {
        description?: string;
        ttlSeconds?: number;
    }): Promise<boolean | undefined>;
    deleteValue(namespace: string, key: string): Promise<boolean>;
    clearCache(): void;
    prefetch(namespace: string): Promise<void>;
    resolveTemplatePath(path: string): Promise<any>;
}
export declare function getGlobalStateClient(options?: Record<string, any>): GlobalStateClient;
export declare function getGlobalValue(namespace: string, key: string): Promise<any>;
export declare function setGlobalValue(namespace: string, key: string, value: any, options?: {
    description?: string;
    ttlSeconds?: number;
}): Promise<boolean | undefined>;
