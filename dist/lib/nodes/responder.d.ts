import { InvokeOptions, Red } from '../../index';
/**
 * Responder Node - Final node that generates LLM responses
 *
 * This node:
 * 1. Loads conversation context (if not provided in state)
 * 2. Uses system message from state or default
 * 3. Streams LLM response
 * 4. Handles thinking extraction
 *
 * Always the final node in the graph after router and optional tool nodes
 */
interface ResponderState {
    query: {
        message: string;
    };
    options: InvokeOptions;
    redInstance: Red;
    contextMessages?: any[];
    systemMessage?: string;
    messages?: any[];
    messageId?: string;
    directResponse?: string;
    nodeNumber?: number;
    finalResponse?: string;
}
export declare const responderNode: (state: ResponderState) => Promise<any>;
export {};
