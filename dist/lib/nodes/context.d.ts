import { InvokeOptions, Red } from '../..';
interface ContextNodeState {
    redInstance: Red;
    options?: InvokeOptions;
    messageId?: string;
    nodeNumber?: number;
    contextMessages?: any[];
    contextSummary?: string;
    contextLoaded?: boolean;
}
export declare const contextNode: (state: ContextNodeState) => Promise<{
    contextLoaded: boolean;
    nodeNumber: number;
    contextMessages?: undefined;
    contextSummary?: undefined;
} | {
    contextMessages: any[];
    contextSummary: string;
    contextLoaded: boolean;
    nodeNumber: number;
}>;
export {};
