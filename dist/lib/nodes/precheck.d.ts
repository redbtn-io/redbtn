import { Red } from '../..';
/**
 * Precheck Node - Fast pattern matching for unambiguous commands
 *
 * This node bypasses LLM calls for simple, direct commands that can be
 * pattern-matched. Think "turn on the lights" vs "help me with something".
 *
 * Patterns are loaded dynamically from MCP servers via resources.
 * Each server exposes patterns like:
 * {
 *   pattern: "^turn\\s+(on|off)\\s+(?:the\\s+)?(.+?)\\s+lights?$",
 *   tool: "control_light",
 *   parameterMapping: { action: 1, location: 2 },
 *   confidence: 0.95
 * }
 *
 * Flow:
 * 1. Load patterns from all MCP servers at initialization
 * 2. Match user input against patterns (regex)
 * 3. If match with high confidence → fast path (execute command directly)
 * 4. If no match or low confidence → router (LLM-based decision)
 */
export interface CommandPattern {
    id: string;
    pattern: string;
    flags: string;
    tool: string;
    description: string;
    parameterMapping: Record<string, number>;
    examples: string[];
    confidence: number;
    server: string;
}
export interface PatternMatch {
    pattern: CommandPattern;
    matches: RegExpMatchArray;
    parameters: Record<string, string>;
    confidence: number;
}
/**
 * Load command patterns from all MCP servers
 */
export declare function loadPatterns(redInstance: Red): Promise<CommandPattern[]>;
/**
 * Match user input against loaded patterns
 */
export declare function matchPattern(input: string, patterns: CommandPattern[]): PatternMatch | null;
/**
 * Precheck Node - Pattern matching before LLM routing
 */
export declare const precheckNode: (state: any) => Promise<{
    precheckDecision: string;
    precheckReason: string;
    precheckMatch?: undefined;
    fastpathTool?: undefined;
    fastpathServer?: undefined;
    fastpathParameters?: undefined;
} | {
    precheckDecision: string;
    precheckMatch: PatternMatch;
    precheckReason: string;
    fastpathTool: string;
    fastpathServer: string;
    fastpathParameters: Record<string, string>;
}>;
