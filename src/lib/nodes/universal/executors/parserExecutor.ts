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
    }

    /** Inject context into the parser state (e.g. channelId, triggerType). */
    setContext(ctx: Record<string, any>): void {
        this._parserState._context = { ...this._parserState._context, ...ctx };
    }

    /**
     * Process a raw chunk from tool output.
     * Returns array of parsed content strings (may be 0, 1, or many).
     */
    async processChunk(rawChunk: string, streamType?: string): Promise<any[]> {
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
     */
    async flush(): Promise<any> {
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
                    const { executeTransform } = require('./transformExecutor');
                    const result = await executeTransform(step.config, state);
                    // Merge result into state
                    if (result && typeof result === 'object') {
                        Object.assign(state, result);
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
                        } catch {
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
                    // Fire-and-forget — don't block the parser
                    this._executeTool(toolName, rendered).catch((err: any) => {
                        console.warn(`[ParserExecutor] Tool step "${toolName}" failed:`, err.message);
                    });
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
