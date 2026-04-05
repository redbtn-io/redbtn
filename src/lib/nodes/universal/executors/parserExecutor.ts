/**
 * ParserExecutor -- processes streaming chunks through parser node steps.
 *
 * Handles buffering (line/chunk/json modes), executes transform/conditional/tool
 * steps per-unit, and returns parsed content for conversation streaming.
 *
 * Tool steps enable side-effects (e.g. send-discord) directly from the parser.
 * The caller provides an `executeTool` callback that handles the actual invocation.
 *
 * Error-isolated: parser failures never crash the tool execution.
 */
import type { NodeConfig, UniversalStep } from '../types';

interface ParserConfig {
    inputField?: string;
    outputField?: string;
    bufferMode?: 'line' | 'chunk' | 'json';
    skipEmpty?: boolean;
}

/**
 * Callback for executing tool steps within the parser.
 * Fire-and-forget: the parser doesn't wait for results.
 */
export type ParserToolExecutor = (
    toolName: string,
    parameters: Record<string, any>,
) => Promise<any>;

export class ParserExecutor {
    private steps: UniversalStep[];
    private inputField: string;
    private outputField: string;
    private bufferMode: 'line' | 'chunk' | 'json';
    private skipEmpty: boolean;
    private _buffer: string;
    private _parserState: Record<string, any>;
    private _consecutiveErrors: number;
    private _disabled: boolean;
    private _maxErrors: number;
    private _executeTool: ParserToolExecutor | null;

    constructor(
        parserNodeConfig: NodeConfig,
        parserConfig?: ParserConfig,
        executeTool?: ParserToolExecutor,
    ) {
        this.steps = parserNodeConfig.steps || [];
        this.inputField = (parserConfig && parserConfig.inputField) || 'chunk';
        this.outputField = (parserConfig && parserConfig.outputField) || 'parsedContent';
        this.bufferMode = (parserConfig && parserConfig.bufferMode) || 'line';
        this.skipEmpty = parserConfig ? parserConfig.skipEmpty !== false : true;
        this._buffer = '';
        this._parserState = {};
        this._consecutiveErrors = 0;
        this._disabled = false;
        this._maxErrors = 5;
        this._executeTool = executeTool || null;
        this._processingChain = Promise.resolve();
    }

    /** Serialized processing chain — ensures concurrent processChunk calls are queued. */
    private _processingChain!: Promise<void>;

    /** Inject context into the parser state (e.g. channelId, triggerType). */
    setContext(ctx: Record<string, any>): void {
        this._parserState._context = { ...this._parserState._context, ...ctx };
    }

    /**
     * Process a raw chunk from tool output.
     * Returns array of parsed content strings (may be 0, 1, or many).
     *
     * Calls are serialized via an internal promise chain — this is critical
     * for parsers with awaited tool steps (e.g. Discord sends). Without
     * serialization, concurrent invocations would interleave their mutations
     * to _parserState and cause duplicate messages, lost captured IDs, etc.
     */
    async processChunk(rawChunk: string, streamType?: string): Promise<any[]> {
        // Queue on the processing chain — each call waits for the previous
        const prev = this._processingChain;
        let resolveNext!: () => void;
        this._processingChain = new Promise<void>((resolve) => { resolveNext = resolve; });
        await prev;
        try {
            return await this._processChunkInternal(rawChunk, streamType);
        } finally {
            resolveNext();
        }
    }

    private async _processChunkInternal(rawChunk: string, _streamType?: string): Promise<any[]> {
        if (this._disabled) {
            // Passthrough mode after too many errors
            return rawChunk ? [rawChunk] : [];
        }

        if (!rawChunk) return [];

        this._buffer += rawChunk;
        const outputs: any[] = [];

        try {
            if (this.bufferMode === 'chunk') {
                // Process entire buffer as one unit
                const result = await this._processUnit(this._buffer);
                this._buffer = '';
                if (result != null) outputs.push(result);
            } else if (this.bufferMode === 'line') {
                // Split on newlines, process each complete line
                const lines = this._buffer.split('\n');
                // Keep the last element (may be incomplete line)
                this._buffer = lines.pop() || '';
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed && this.skipEmpty) continue;
                    const result = await this._processUnit(trimmed);
                    if (result != null) outputs.push(result);
                }
            } else if (this.bufferMode === 'json') {
                // Try to parse buffer as JSON
                try {
                    const parsed = JSON.parse(this._buffer);
                    this._buffer = '';
                    const result = await this._processUnit(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
                    if (result != null) outputs.push(result);
                } catch {
                    // Not valid JSON yet, keep buffering
                    // But check for buffer overflow (1MB)
                    if (this._buffer.length > 1024 * 1024) {
                        console.warn('[ParserExecutor] Buffer overflow (1MB), flushing');
                        this._buffer = '';
                    }
                }
            }
        } catch (err: any) {
            console.warn('[ParserExecutor] processChunk error:', err.message || err);
            this._consecutiveErrors++;
            if (this._consecutiveErrors >= this._maxErrors) {
                console.error(`[ParserExecutor] ${this._maxErrors} consecutive errors, switching to passthrough`);
                this._disabled = true;
            }
        }

        return outputs;
    }

    /**
     * Flush any remaining buffer content (end of stream).
     * Serialized on the same chain as processChunk.
     */
    async flush(): Promise<any> {
        const prev = this._processingChain;
        let resolveNext!: () => void;
        this._processingChain = new Promise<void>((resolve) => { resolveNext = resolve; });
        await prev;
        try {
            return await this._flushInternal();
        } finally {
            resolveNext();
        }
    }

    private async _flushInternal(): Promise<any> {
        if (!this._buffer || this._disabled) {
            const remaining = this._buffer;
            this._buffer = '';
            return remaining || null;
        }

        try {
            const result = await this._processUnit(this._buffer.trim());
            this._buffer = '';
            return result;
        } catch {
            const remaining = this._buffer;
            this._buffer = '';
            return remaining || null;
        }
    }

    /**
     * Process a single complete unit through the parser steps.
     */
    private async _processUnit(unit: string): Promise<any> {
        if (!unit && this.skipEmpty) return null;

        // Build minimal state for parser steps
        const state: Record<string, any> = {
            [this.inputField]: unit,
            _parserState: this._parserState,
            [this.outputField]: null,
        };

        try {
            // Execute each step in sequence
            for (const step of this.steps) {
                if (step.type === 'transform') {
                    // Check condition if present (transform steps can have conditions too)
                    const tCondition = (step as any).condition;
                    if (tCondition) {
                        const { resolveValue } = require('../templateRenderer');
                        try {
                            const ok = Boolean(resolveValue(tCondition, state));
                            if (!ok) continue;
                        } catch {
                            continue;
                        }
                    }
                    const { executeTransform } = require('./transformExecutor');
                    const result = await executeTransform(step.config, state);
                    // Merge result into state — with special handling for nested
                    // paths like `_parserState.X` that should be written into the
                    // actual _parserState object (transformExecutor returns these
                    // as flat keys with dots in the name).
                    if (result && typeof result === 'object') {
                        for (const [key, value] of Object.entries(result)) {
                            if (key.startsWith('_parserState.')) {
                                const path = key.substring('_parserState.'.length).split('.');
                                let cur: any = this._parserState;
                                for (let i = 0; i < path.length - 1; i++) {
                                    if (cur[path[i]] == null || typeof cur[path[i]] !== 'object') cur[path[i]] = {};
                                    cur = cur[path[i]];
                                }
                                cur[path[path.length - 1]] = value;
                            } else {
                                state[key] = value;
                            }
                        }
                    }
                } else if (step.type === 'conditional') {
                    const { executeConditional } = require('./conditionalExecutor');
                    const result = executeConditional(step.config, state);
                    if (result && typeof result === 'object') {
                        Object.assign(state, result);
                    }
                } else if (step.type === 'tool' && this._executeTool) {
                    const { resolveValue, renderTemplate } = require('../templateRenderer');
                    // Check condition if present
                    const condition = (step as any).condition;
                    if (condition) {
                        try {
                            const ok = Boolean(resolveValue(condition, state));
                            if (!ok) continue;
                        } catch (condErr: any) {
                            console.warn(`[ParserExecutor] Condition eval error: ${condErr.message}`);
                            continue;
                        }
                    }
                    // Render parameters from state
                    const toolConfig = (step as any).config || {};
                    const toolName = renderTemplate(toolConfig.toolName || '', state);
                    const rawParams = toolConfig.parameters || {};
                    const rendered: Record<string, any> = {};
                    for (const [k, v] of Object.entries(rawParams)) {
                        rendered[k] = typeof v === 'string' ? resolveValue(v, state) : v;
                    }
                    // Log the tool call for diagnostics (parser tool steps don't
                    // show up in the ToolExecutor's normal logging path).
                    console.log(`[ParserExecutor] tool step: ${toolName} params=${JSON.stringify(rendered).substring(0, 400)}`);
                    // If outputField is specified, await the result and store it in _parserState.
                    // Otherwise fire-and-forget (doesn't block parser processing).
                    const outputField = toolConfig.outputField;
                    if (outputField) {
                        try {
                            const result = await this._executeTool(toolName, rendered);
                            // Unwrap common result shapes: MCP { content: [{text: jsonStr}] } or plain
                            let extracted: any = result;
                            if (result && typeof result === 'object' && Array.isArray((result as any).content)) {
                                const textBlock = (result as any).content.find((b: any) => b?.type === 'text');
                                if (textBlock?.text) {
                                    try { extracted = JSON.parse(textBlock.text); } catch { extracted = textBlock.text; }
                                }
                            }
                            // Store at the path in _parserState
                            const setPath = (obj: any, path: string, val: any) => {
                                const keys = path.split('.');
                                let cur = obj;
                                for (let i = 0; i < keys.length - 1; i++) {
                                    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
                                    cur = cur[keys[i]];
                                }
                                cur[keys[keys.length - 1]] = val;
                            };
                            setPath(this._parserState, outputField, extracted);
                            console.log(`[ParserExecutor] tool step ${toolName} → ${outputField}: ${JSON.stringify(extracted).substring(0, 200)}`);
                        } catch (err: any) {
                            console.warn(`[ParserExecutor] Tool step "${toolName}" failed:`, err.message);
                        }
                    } else {
                        this._executeTool(toolName, rendered).catch((err: any) => {
                            console.warn(`[ParserExecutor] Tool step "${toolName}" failed:`, err.message);
                        });
                    }
                }
            }

            // Extract output
            const output = state[this.outputField];

            if (output == null || (this.skipEmpty && output === '')) {
                return null;
            }

            this._consecutiveErrors = 0; // Reset on success
            // Return as-is — strings, arrays, and objects are all valid
            // The toolExecutor handles routing based on type
            return output;
        } catch (err: any) {
            console.warn(`[ParserExecutor] Step execution error: ${err.message || err}`);
            this._consecutiveErrors++;
            if (this._consecutiveErrors >= this._maxErrors) {
                console.error(`[ParserExecutor] Too many errors, disabling parser`);
                this._disabled = true;
            }
            return null;
        }
    }
}
