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
        // Config-driven outputs from parserConfig (optional)
        const rawOutputs = (parserConfig as any)?.outputs;
        this._outputs = Array.isArray(rawOutputs) ? rawOutputs : [];
        // Legacy: promote voiceOutput to outputs[] entry
        const legacyVoice = (parserConfig as any)?.voiceOutput;
        if (legacyVoice && !this._outputs.some((o: any) => o.type === 'http' && o.id === 'voice')) {
            this._outputs.push({ id: 'voice', type: 'http', condition: { voiceChannel: true }, ...legacyVoice });
        }
    }

    /** Serialized processing chain — ensures concurrent processChunk calls are queued. */
    private _processingChain!: Promise<void>;

    /**
     * Config-driven output routing.
     *
     * Each output fires independently when its condition matches.
     * Types:
     *   - http: POST to an endpoint with body template
     *   - conversation: publish to conversation stream via RunPublisher
     *   - runStream: publish to run stream (for archivers/UI)
     *
     * All matching outputs fire in parallel per chunk.
     */
    private _outputs: Array<{
        id?: string;
        type: 'http' | 'conversation' | 'runStream' | 'tts_http';
        condition?: Record<string, unknown>;
        sentenceSplit?: boolean;
        // For type: 'http'
        endpoint?: string;
        headers?: Record<string, string>;
        body?: Record<string, string>;
        // For type: 'tts_http' — chains TTS + delivery per sentence
        ttsEndpoint?: string;
        ttsHeaders?: Record<string, string>;
        ttsVoice?: string;
        ttsModel?: string;
        ttsResponsePath?: string;
        deliveryEndpoint?: string;
        deliveryHeaders?: Record<string, string>;
        deliveryBody?: Record<string, string>;
    }>;

    /** Inject context into the parser state (e.g. channelId, triggerType). */
    setContext(ctx: Record<string, any>): void {
        this._parserState._context = { ...this._parserState._context, ...ctx };
    }

    /**
     * Feed raw text directly (bypasses step pipeline).
     * Used by neuronExecutor to route LLM output through configured outputs
     * (voice sentence splitting, etc.) without needing a parser transform step.
     */
    async feedText(text: string): Promise<void> {
        const prev = this._processingChain;
        let resolveNext!: () => void;
        this._processingChain = new Promise<void>((resolve) => { resolveNext = resolve; });
        await prev;
        try {
            this._parserState._textBuffer = (this._parserState._textBuffer || '') + text;
            await this._flushOutputs();
        } finally {
            resolveNext();
        }
    }

    /**
     * Flush any remaining text buffer through outputs (call after streaming ends).
     */
    async flushText(): Promise<void> {
        const prev = this._processingChain;
        let resolveNext!: () => void;
        this._processingChain = new Promise<void>((resolve) => { resolveNext = resolve; });
        await prev;
        try {
            if (this._parserState._textBuffer && this._parserState._textBuffer.length > 0) {
                // Force flush everything remaining
                this._parserState._shouldSendText = true;
                this._parserState._pendingText = this._parserState._textBuffer;
                this._parserState._textBuffer = '';
                // Fire outputs with the remaining text
                for (const output of this._outputs) {
                    if (output.condition) {
                        const ctx = this._parserState._context || {};
                        let matches = true;
                        for (const [k, v] of Object.entries(output.condition)) {
                            if (v === true && !ctx[k]) { matches = false; break; }
                            if (v === false && ctx[k]) { matches = false; break; }
                            if (typeof v === 'string' && ctx[k] !== v) { matches = false; break; }
                        }
                        if (!matches) continue;
                    }
                    if (output.type === 'http') {
                        await this._flushHttpOutput(
                            output,
                            { ...this._parserState, _textBuffer: this._parserState._pendingText },
                            this._parserState._context || {},
                        );
                    }
                }
            }
        } finally {
            resolveNext();
        }
    }

    /**
     * Flush configured outputs — fires AFTER each _processUnit.
     *
     * Iterates all outputs whose conditions match the current context.
     * Each output can independently split sentences, POST to endpoints,
     * or publish to internal streams.
     *
     * Config-driven: the executor has zero platform knowledge.
     */
    private async _flushOutputs(): Promise<void> {
        if (this._outputs.length === 0) return;
        const ps = this._parserState;
        const ctx = ps._context || {};
        if (!ps._textBuffer || ps._textBuffer.length < 5) return;

        for (const output of this._outputs) {
            // Check condition — every key in condition must match context
            if (output.condition) {
                let matches = true;
                for (const [k, v] of Object.entries(output.condition)) {
                    if (v === true && !ctx[k]) { matches = false; break; }
                    if (v === false && ctx[k]) { matches = false; break; }
                    if (typeof v === 'string' && ctx[k] !== v) { matches = false; break; }
                }
                if (!matches) continue;
            }

            if (output.type === 'http') {
                await this._flushHttpOutput(output, ps, ctx);
            } else if (output.type === 'tts_http') {
                await this._flushTtsHttpOutput(output, ps, ctx);
            }
            // Future: conversation, runStream types
        }
    }

    /** Flush text buffer to an HTTP endpoint output. */
    private async _flushHttpOutput(
        output: { sentenceSplit?: boolean; endpoint?: string; headers?: Record<string, string>; body?: Record<string, string>; id?: string },
        ps: Record<string, any>,
        ctx: Record<string, any>,
    ): Promise<void> {
        const { endpoint, headers, body: bodyTemplate, sentenceSplit } = output;
        if (!endpoint) return;

        let chunks: string[];
        if (sentenceSplit !== false) {
            const boundaries = /(?<=[.!?])\s+|(?<=\.)\n|(?<=!)\n|(?<=\?)\n|(?<=—)\s+|(?<=:)\n|\n\n/;
            const sentences = ps._textBuffer.split(boundaries).filter((s: string) => s && s.trim().length > 2);
            if (sentences.length === 0) return;

            const endsClean = /[.!?—]\s*$/.test(ps._textBuffer.trimEnd()) || ps._textBuffer.endsWith('\n\n');
            chunks = endsClean ? sentences : sentences.slice(0, -1);
            const remainder = endsClean ? '' : sentences[sentences.length - 1];
            if (chunks.length === 0) return;
            ps._textBuffer = remainder;
        } else {
            chunks = [ps._textBuffer];
            ps._textBuffer = '';
        }

        ps._shouldSendText = false;

        for (const chunk of chunks) {
            const text = chunk.trim();
            if (!text) continue;
            const label = output.id || 'http';
            console.log(`[ParserExecutor] Output(${label}): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}" (${text.length} chars)`);
            try {
                const renderedBody: Record<string, unknown> = {};
                if (bodyTemplate && typeof bodyTemplate === 'object') {
                    for (const [k, v] of Object.entries(bodyTemplate as Record<string, string>)) {
                        if (v === '{{text}}') renderedBody[k] = text;
                        else if (typeof v === 'string' && v.startsWith('{{context.') && v.endsWith('}}')) {
                            renderedBody[k] = ctx[v.slice(10, -2)] ?? '';
                        } else {
                            renderedBody[k] = v;
                        }
                    }
                } else {
                    renderedBody.text = text;
                }

                fetch(endpoint, {
                    method: 'POST',
                    headers: headers || { 'Content-Type': 'application/json' },
                    body: JSON.stringify(renderedBody),
                }).catch(() => {});
            } catch { /* ignore */ }
        }
    }

    /**
     * TTS + delivery output: for each sentence, call a TTS API to get audio,
     * then forward the audio to a delivery endpoint. All in TypeScript — no
     * config template eval with large base64 strings.
     */
    private async _flushTtsHttpOutput(
        output: Record<string, any>,
        ps: Record<string, any>,
        ctx: Record<string, any>,
    ): Promise<void> {
        const { ttsEndpoint, ttsHeaders, ttsVoice, ttsModel, ttsResponsePath,
                deliveryEndpoint, deliveryHeaders, deliveryBody, sentenceSplit } = output;
        if (!ttsEndpoint || !deliveryEndpoint) return;

        // Split sentences (same logic as _flushHttpOutput)
        let chunks: string[];
        if (sentenceSplit !== false) {
            const boundaries = /(?<=[.!?])\s+|(?<=\.)\n|(?<=!)\n|(?<=\?)\n|(?<=—)\s+|(?<=:)\n|\n\n/;
            const sentences = ps._textBuffer.split(boundaries).filter((s: string) => s && s.trim().length > 2);
            if (sentences.length === 0) return;
            const endsClean = /[.!?—]\s*$/.test(ps._textBuffer.trimEnd()) || ps._textBuffer.endsWith('\n\n');
            chunks = endsClean ? sentences : sentences.slice(0, -1);
            const remainder = endsClean ? '' : sentences[sentences.length - 1];
            if (chunks.length === 0) return;
            ps._textBuffer = remainder;
        } else {
            chunks = [ps._textBuffer];
            ps._textBuffer = '';
        }

        ps._shouldSendText = false;
        const label = output.id || 'tts_http';
        const voice = ttsVoice || 'Kore';

        // Fire ALL TTS calls in parallel, then deliver audio sequentially (preserves order)
        const ttsPromises = chunks.map((chunk) => {
            const text = chunk.trim();
            if (!text) return Promise.resolve(null);
            console.log(`[ParserExecutor] TTS(${label}): "${text.substring(0, 60)}${text.length > 60 ? '...' : ''}" (${text.length} chars)`);

            const ttsBody = {
                contents: [{ parts: [{ text: `Say naturally: ${text}` }] }],
                generationConfig: {
                    responseModalities: ['AUDIO'],
                    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
                },
            };
            const ttsStart = Date.now();

            return fetch(ttsEndpoint, {
                method: 'POST',
                headers: ttsHeaders || { 'Content-Type': 'application/json' },
                body: JSON.stringify(ttsBody),
            }).then(async (resp) => {
                if (!resp.ok) {
                    const errText = await resp.text().catch(() => '');
                    console.error(`[ParserExecutor] TTS(${label}) failed: ${resp.status} ${errText.substring(0, 200)}`);
                    return null;
                }
                const data = await resp.json() as any;
                const audioData = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
                const ttsDuration = Date.now() - ttsStart;
                if (audioData) {
                    console.log(`[ParserExecutor] TTS(${label}): got ${audioData.length} base64 chars in ${ttsDuration}ms`);
                } else {
                    console.error(`[ParserExecutor] TTS(${label}) no audio in response (${ttsDuration}ms)`);
                }
                return audioData || null;
            }).catch((err) => {
                console.error(`[ParserExecutor] TTS(${label}) fetch error:`, err.message);
                return null;
            });
        });

        // Wait for all TTS to complete, then deliver in order
        const audioResults = await Promise.all(ttsPromises);

        for (const audioData of audioResults) {
            if (!audioData) continue;
            try {
                const renderedDelivery: Record<string, unknown> = {};
                if (deliveryBody && typeof deliveryBody === 'object') {
                    for (const [k, v] of Object.entries(deliveryBody as Record<string, string>)) {
                        if (v === '{{audio}}') renderedDelivery[k] = audioData;
                        else if (typeof v === 'string' && v.startsWith('{{context.') && v.endsWith('}}')) {
                            renderedDelivery[k] = ctx[v.slice(10, -2)] ?? '';
                        } else {
                            renderedDelivery[k] = v;
                        }
                    }
                }
                // Await delivery to preserve playback order
                await fetch(deliveryEndpoint, {
                    method: 'POST',
                    headers: deliveryHeaders || { 'Content-Type': 'application/json' },
                    body: JSON.stringify(renderedDelivery),
                });
                console.log(`[ParserExecutor] TTS(${label}): audio delivered`);
            } catch (err: any) {
                console.error(`[ParserExecutor] TTS(${label}) delivery failed:`, err.message);
            }
        }
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
                await this._flushOutputs();
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
                    // Voice mode: flush individual sentences after each event
                    await this._flushOutputs();
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
