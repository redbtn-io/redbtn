"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ParserExecutor = void 0;
class ParserExecutor {
    constructor(parserNodeConfig, parserConfig) {
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
    }
    /**
     * Process a raw chunk from tool output.
     * Returns array of parsed content strings (may be 0, 1, or many).
     */
    processChunk(rawChunk, streamType) {
        return __awaiter(this, void 0, void 0, function* () {
            if (this._disabled) {
                // Passthrough mode after too many errors
                return rawChunk ? [rawChunk] : [];
            }
            if (!rawChunk)
                return [];
            this._buffer += rawChunk;
            const outputs = [];
            try {
                if (this.bufferMode === 'chunk') {
                    // Process entire buffer as one unit
                    const result = yield this._processUnit(this._buffer);
                    this._buffer = '';
                    if (result != null)
                        outputs.push(result);
                }
                else if (this.bufferMode === 'line') {
                    // Split on newlines, process each complete line
                    const lines = this._buffer.split('\n');
                    // Keep the last element (may be incomplete line)
                    this._buffer = lines.pop() || '';
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed && this.skipEmpty)
                            continue;
                        const result = yield this._processUnit(trimmed);
                        if (result != null)
                            outputs.push(result);
                    }
                }
                else if (this.bufferMode === 'json') {
                    // Try to parse buffer as JSON
                    try {
                        const parsed = JSON.parse(this._buffer);
                        this._buffer = '';
                        const result = yield this._processUnit(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
                        if (result != null)
                            outputs.push(result);
                    }
                    catch (_a) {
                        // Not valid JSON yet, keep buffering
                        // But check for buffer overflow (1MB)
                        if (this._buffer.length > 1024 * 1024) {
                            console.warn('[ParserExecutor] Buffer overflow (1MB), flushing');
                            this._buffer = '';
                        }
                    }
                }
            }
            catch (err) {
                console.warn('[ParserExecutor] processChunk error:', err.message || err);
                this._consecutiveErrors++;
                if (this._consecutiveErrors >= this._maxErrors) {
                    console.error(`[ParserExecutor] ${this._maxErrors} consecutive errors, switching to passthrough`);
                    this._disabled = true;
                }
            }
            return outputs;
        });
    }
    /**
     * Flush any remaining buffer content (end of stream).
     */
    flush() {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this._buffer || this._disabled) {
                const remaining = this._buffer;
                this._buffer = '';
                return remaining || null;
            }
            try {
                const result = yield this._processUnit(this._buffer.trim());
                this._buffer = '';
                return result;
            }
            catch (_a) {
                const remaining = this._buffer;
                this._buffer = '';
                return remaining || null;
            }
        });
    }
    /**
     * Process a single complete unit through the parser steps.
     */
    _processUnit(unit) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!unit && this.skipEmpty)
                return null;
            // Build minimal state for parser steps
            const state = {
                [this.inputField]: unit,
                _parserState: this._parserState,
                [this.outputField]: null,
            };
            try {
                // Execute each step in sequence
                for (const step of this.steps) {
                    if (step.type === 'transform') {
                        const { executeTransform } = require('./transformExecutor');
                        const result = yield executeTransform(step.config, state);
                        // Merge result into state
                        if (result && typeof result === 'object') {
                            Object.assign(state, result);
                        }
                    }
                    else if (step.type === 'conditional') {
                        const { executeConditional } = require('./conditionalExecutor');
                        const result = executeConditional(step.config, state);
                        if (result && typeof result === 'object') {
                            Object.assign(state, result);
                        }
                    }
                    // Other step types (neuron, tool, loop) not supported in parsers
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
            }
            catch (err) {
                console.warn(`[ParserExecutor] Step execution error: ${err.message || err}`);
                this._consecutiveErrors++;
                if (this._consecutiveErrors >= this._maxErrors) {
                    console.error(`[ParserExecutor] Too many errors, disabling parser`);
                    this._disabled = true;
                }
                return null;
            }
        });
    }
}
exports.ParserExecutor = ParserExecutor;
