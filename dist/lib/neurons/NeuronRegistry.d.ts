import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { NeuronConfig } from '../types/neuron';
import type { RedConfig } from '../../index';
type PartialRedConfig = Pick<RedConfig, 'databaseUrl'> & Partial<Omit<RedConfig, 'databaseUrl'>>;
export { NeuronConfig, NeuronDocument } from '../types/neuron';
export declare class NeuronNotFoundError extends Error {
    constructor(message: string);
}
export declare class NeuronAccessDeniedError extends Error {
    constructor(message: string);
}
export declare class NeuronProviderError extends Error {
    constructor(message: string);
}
export interface ModelOverrides {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
}
export declare class NeuronRegistry {
    private configCache;
    private db;
    private config;
    constructor(config: PartialRedConfig);
    initialize(): Promise<void>;
    getModel(neuronId: string, userId: string, overrides?: ModelOverrides): Promise<BaseChatModel>;
    getConfig(neuronId: string, userId: string): Promise<NeuronConfig>;
    createModel(config: NeuronConfig): BaseChatModel;
    private validateAccess;
    private getUserTier;
    getUserNeurons(userId: string): Promise<NeuronConfig[]>;
    clearCache(userId?: string): Promise<void>;
    private decryptApiKey;
    subscribeToInvalidations(redisUrl: string): Promise<void>;
    shutdown(): Promise<void>;
}
