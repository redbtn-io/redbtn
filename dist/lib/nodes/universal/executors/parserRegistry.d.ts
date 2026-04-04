import type { NodeConfig } from '../types';
interface ParserConfig {
    inputField: string;
    outputField: string;
    bufferMode: 'line' | 'chunk' | 'json';
    skipEmpty: boolean;
}
interface ParserData {
    config: NodeConfig;
    parserConfig: ParserConfig;
}
declare class ParserRegistry {
    private _cache;
    private _builtins;
    constructor();
    registerBuiltin(parserId: string, config: ParserData): void;
    getParser(parserId: string): Promise<ParserData | null>;
    invalidate(parserId?: string): void;
}
export declare function getParserRegistry(): ParserRegistry;
export {};
