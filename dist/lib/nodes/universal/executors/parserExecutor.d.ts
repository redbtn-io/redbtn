/**
 * ParserExecutor -- processes streaming chunks through parser node steps.
 *
 * Handles buffering (line/chunk/json modes), executes transform/conditional
 * steps per-unit, and returns parsed content for conversation streaming.
 *
 * Error-isolated: parser failures never crash the tool execution.
 */
import type { NodeConfig } from '../types';
interface ParserConfig {
    inputField?: string;
    outputField?: string;
    bufferMode?: 'line' | 'chunk' | 'json';
    skipEmpty?: boolean;
}
export declare class ParserExecutor {
    private steps;
    private inputField;
    private outputField;
    private bufferMode;
    private skipEmpty;
    private _buffer;
    private _parserState;
    private _consecutiveErrors;
    private _disabled;
    private _maxErrors;
    constructor(parserNodeConfig: NodeConfig, parserConfig?: ParserConfig);
    /**
     * Process a raw chunk from tool output.
     * Returns array of parsed content strings (may be 0, 1, or many).
     */
    processChunk(rawChunk: string, streamType?: string): Promise<any[]>;
    /**
     * Flush any remaining buffer content (end of stream).
     */
    flush(): Promise<any>;
    /**
     * Process a single complete unit through the parser steps.
     */
    private _processUnit;
}
export {};
