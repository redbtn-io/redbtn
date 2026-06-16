/**
 * Neuron Step Executor
 *
 * Executes LLM calls with template rendering for prompts.
 * Supports custom neurons or default LLM with configurable parameters.
 *
 * Parameter Override Flow:
 * 1. Node definition has `parameters` map with defaults (e.g., temperature: 0.1)
 * 2. Graph can override via `config.parameters: { temperature: 0.3 }`
 * 3. Resolved parameters are injected into state as `state.parameters`
 * 4. Step configs can use `"{{parameters.temperature}}"` to reference them
 * 5. This executor resolves those templates to actual values before using them
 */

import type { NeuronStepConfig } from '../types';
import { renderTemplate, getNestedProperty } from '../templateRenderer';
import { executeWithErrorHandling } from './errorHandler';
import { AudioStreamPipeline } from '../../../tts/audio-stream';
import { ParserExecutor, type ParserToolExecutor } from './parserExecutor';
import { getParserRegistry } from './parserRegistry';
import { getNativeRegistry } from '../../../tools/native-registry';
import { runControlRegistry } from '../../../run/RunControlRegistry';
import { getRunPublisher, getNeuronRegistry, getMcpClient, getGraphRegistry, getMeteringClient } from '../../../run/contextLookup';
import { HumanMessage } from '@langchain/core/messages';
import { resolveToolStrategy, type ToolStrategy } from '../../../neurons/capability-matrix';
import { resolveTools, toBindToolsPayload, type ResolvedTool } from '../../../tools/tool-resolver';
import { coerceArgsToSchema } from '../../../tools/coerce-args';

/**
 * Resolve the run-level AbortSignal — see universalNode.ts for the full
 * rationale. Reads from the per-process RunControlRegistry (survives
 * checkpoint round-trips), with `state._abortController` as a fallback for
 * direct/test callers.
 */
function getRunSignal(state: any): AbortSignal | undefined {
    const runId = state?.runId || state?.data?.runId;
    const ctx = runControlRegistry.get(runId);
    if (ctx) return ctx.controller.signal;
    return state?._abortController?.signal;
}

/**
 * Resolve the subgraph visibility tag from graph state. Mirrors the helper in
 * toolExecutor.ts: when a neuron step runs inside a subgraph, `graphExecutor`
 * has written `state.data._subgraph = { depth, graphId, name }`. Any tool the
 * LLM invokes (triggeredBy:'neuron') is then tagged so the UI can filter it.
 * Returns undefined for top-level neurons — those tools stay untagged.
 */
function resolveSubgraphTag(
    state: any,
): { depth: number; graphId: string; name: string } | undefined {
    const tag = state?.data?._subgraph;
    if (
        tag &&
        typeof tag === 'object' &&
        typeof tag.depth === 'number' &&
        typeof tag.graphId === 'string'
    ) {
        return {
            depth: tag.depth,
            graphId: tag.graphId,
            name: typeof tag.name === 'string' ? tag.name : tag.graphId,
        };
    }
    return undefined;
}

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

// Timeout for stream to start (180 seconds - longer for local models with large context)
const STREAM_START_TIMEOUT = 180000;

// Default inactivity timeout once streaming has begun (120 seconds without any token = stall)
const DEFAULT_STREAM_INACTIVITY_TIMEOUT = 120000;

// Multimodal-safe message normalization. Extracted to a standalone module
// so it can be unit-tested without dragging in templateRenderer's runtime-
// only require graph. The named re-export keeps the public surface.
import { mergeMessageContent, normalizeMessages } from './normalizeMessages';
export { mergeMessageContent, normalizeMessages };

/**
 * Resolve a config value that might be a template string like "{{parameters.temperature}}"
 * Returns the resolved value (as number if it was a parameter reference) or the original value
 *
 * Supports:
 *   - "{{parameters.someField}}"
 *   - "{{parameters.someField || 'default'}}"
 *   - "{{state.data.someField}}"
 *   - "{{state.data.someField || 'default'}}"
 */
function resolveConfigValue(value: any, state: any): any {
  if (typeof value !== 'string') {
    return value;
  }

  // Match: {{<expr>}} where <expr> may be "path || 'fallback'" or just "path"
  const templateMatch = value.match(/^\{\{(.+?)\}\}$/);
  if (!templateMatch) return value;

  const expr = templateMatch[1].trim();

  // Split on || to get primary and optional fallback
  // e.g. "parameters.neuronId || 'gemini-2-5-flash-chat'" → ["parameters.neuronId", "'gemini-2-5-flash-chat'"]
  const parts = expr.split(/\s*\|\|\s*/);
  const primaryExpr = parts[0].trim();
  const fallbackExpr = parts[1]?.trim();

  function resolveExpr(e: string): any {
    // parameters.someField
    const paramMatch = e.match(/^parameters\.(\w+)$/);
    if (paramMatch && state.parameters) {
      return state.parameters[paramMatch[1]];
    }
    // state.someField (e.g. state.data.environmentId)
    const stateMatch = e.match(/^state\.(.+)$/);
    if (stateMatch) {
      return getNestedProperty(state, stateMatch[1]);
    }
    return undefined;
  }

  function parseLiteral(e: string): any {
    // Quoted string: 'value' or "value"
    const strMatch = e.match(/^['"](.*)['"]$/);
    if (strMatch) return strMatch[1];
    // Number
    const n = Number(e);
    if (!isNaN(n)) return n;
    // Boolean
    if (e === 'true') return true;
    if (e === 'false') return false;
    return undefined;
  }

  const primary = resolveExpr(primaryExpr);
  if (primary !== undefined && primary !== null && primary !== '') {
    if (DEBUG) console.log(`[NeuronExecutor] Resolved template "${expr}":`, primary);
    return primary;
  }

  if (fallbackExpr !== undefined) {
    const fallbackResolved = resolveExpr(fallbackExpr);
    if (fallbackResolved !== undefined) {
      if (DEBUG) console.log(`[NeuronExecutor] Resolved fallback template "${fallbackExpr}":`, fallbackResolved);
      return fallbackResolved;
    }
    const literal = parseLiteral(fallbackExpr);
    if (literal !== undefined) {
      if (DEBUG) console.log(`[NeuronExecutor] Using literal fallback for "${primaryExpr}":`, literal);
      return literal;
    }
  }

  // Not a recognized template or couldn't resolve — return as-is
  return value;
}

// Multimodal HumanMessage builder lives in its own module so it can be
// unit-tested without the runtime-only require graph this file inherits.
// The named re-export keeps the existing call-site (line ~635) working,
// and any future consumer can `import { buildMultimodalMessage } from
// './multimodalMessage'` directly. See Phase 8 (media-wire-attachments-neuron).
import { buildMultimodalMessage, type AttachmentRef } from './multimodalMessage';
export { buildMultimodalMessage };
export type { AttachmentRef };

/**
 * Execute a neuron step (with error handling wrapper)
 *
 * @param config - Neuron step configuration
 * @param state - Current graph state
 * @returns Partial state with output field set to LLM response
 */
export async function executeNeuron(config: NeuronStepConfig, state: any): Promise<Partial<any>> {
  // If error handling configured, wrap execution
  if (config.errorHandling) {
    const result = await executeWithErrorHandling(
      () => executeNeuronInternal(config, state),
      config.errorHandling,
      {
        type: 'neuron',
        field: config.outputField
      }
    );

    // If fallback was used, the result will be the raw fallback value (e.g., a string)
    // We need to wrap it in the expected format: { [outputField]: value }
    // Check if result is already in the correct format (has outputField as a key)
    if (result && typeof result === 'object' && config.outputField in result) {
      // Already in correct format (normal execution succeeded)
      return result;
    } else if (result !== undefined) {
      // Fallback was used - wrap the raw value in the expected format
      const resultStr = typeof result === 'string' ? result : String(result);
      console.log('[NeuronExecutor] Wrapping fallback value in outputField format:', {
        outputField: config.outputField,
        fallbackType: typeof result,
        fallbackPreview: resultStr.substring(0, 50)
      });
      return {
        [config.outputField]: result
      };
    }

    return result;
  }

  // Otherwise execute directly
  return executeNeuronInternal(config, state);
}

/**
 * Internal neuron execution (actual LLM call logic)
 *
 * Flow:
 * 1. Get neuron instance (or use default LLM)
 * 2. Render system and user prompt templates
 * 3. Build messages array
 * 4. Invoke LLM with configured parameters
 * 5. Return result in specified output field
 *
 * @param config - Neuron step configuration
 * @param state - Current graph state (includes accumulated updates from previous steps + infrastructure)
 * @returns Partial state with output field set to LLM response
 */
async function executeNeuronInternal(config: NeuronStepConfig, state: any): Promise<Partial<any>> {
  console.log('[NeuronExecutor] ====== STARTING NEURON EXECUTION ======');
  console.log('[NeuronExecutor] config:', {
    neuronId: config.neuronId,
    outputField: config.outputField,
    hasSystemPrompt: !!config.systemPrompt,
    userPromptPreview: config.userPrompt?.substring(0, 100),
    hasStructuredOutput: !!config.structuredOutput,
    stream: config.stream,
    temperature: config.temperature,
    maxTokens: config.maxTokens
  });

  try {
    // Get neuron registry from run-context registry (with state fallback for tests)
    const neuronRegistry = getNeuronRegistry(state);

    // Pull the run-level AbortSignal once. Sourced from RunControlRegistry
    // so it survives any LangGraph checkpoint round-trip (state-stashed
    // controllers are stripped between nodes — see RunControlRegistry.ts).
    //
    // LangChain's BaseChatModel (.invoke / .stream) accepts `{ signal }` as
    // a call option and routes it through to the underlying transport — this
    // is how mid-step interrupt cancels a long LLM generation cooperatively.
    // For the cases LangChain's signal forwarding doesn't cover, we also
    // route the call through `neuronRegistry.callNeuron()` which registers
    // the in-flight call with RunControlRegistry so a process-level
    // interrupt can force-close it.
    const abortSignal: AbortSignal | undefined = getRunSignal(state);

    // Run identifier — needed by callNeuron for direct cancellation.
    const callRunId: string | undefined = state?.runId || state?.data?.runId;

    // Determine which neuron ID to use
    const neuronId = config.neuronId || state.defaultNeuronId || state.data?.defaultNeuronId;
    if (!neuronId) {
      throw new Error('No neuron available: config.neuronId not set and no default neuron in state');
    }

    // Resolve any template values in config (e.g., "{{parameters.temperature}}" -> 0.3)
    const resolvedTemperature = resolveConfigValue(config.temperature, state);
    const resolvedMaxTokens = resolveConfigValue(config.maxTokens, state);

    // Build overrides object for model creation (only include resolved numeric values)
    const modelOverrides: Record<string, any> = {};
    if (typeof resolvedTemperature === 'number') {
      modelOverrides.temperature = resolvedTemperature;
    }
    if (typeof resolvedMaxTokens === 'number') {
      modelOverrides.maxTokens = resolvedMaxTokens;
    }

    if (DEBUG && Object.keys(modelOverrides).length > 0) {
      console.log('[NeuronExecutor] Applying model overrides:', modelOverrides);
    }

    // Get model instance from registry (returns LangChain BaseChatModel)
    // Support userId at root or in data
    const userId = state.userId || state.data?.userId;

    // redToken usage metering (shadow mode) — see emitNeuronUsage(). Thin
    // closure binding the common per-execution args; each call path passes its
    // own providerResponse (+ optional stepId override for the tool loop).
    const emitUsage = (providerResponse: any, modelHint?: string, stepIdOverride?: string): void =>
      emitNeuronUsage({
        state, neuronRegistry, config, neuronId, userId, callRunId,
        providerResponse, modelHint, stepIdOverride,
      });

    let model: any = await neuronRegistry.getModel(
      neuronId,
      userId,
      Object.keys(modelOverrides).length > 0 ? modelOverrides : undefined
    );

    if (!model) {
      throw new Error(`Failed to get model for neuron: ${neuronId}`);
    }

    // Check if this is an Ollama model for special handling
    const isOllamaModel = model.constructor.name === 'ChatOllama';

    // -------------------------------------------------------------------------
    // Neuron-attached tools — capability-aware strategy routing
    //
    // When `config.tools` is non-empty, the executor runs a tool-use loop
    // instead of a single LLM call. The strategy is resolved from
    // `config.toolStrategy` (defaults to 'auto' -> capability matrix).
    //
    // Backward-compat: when `config.tools` is empty/missing, we fall through
    // to the existing plain-LLM / structuredOutput path unchanged.
    // -------------------------------------------------------------------------
    const attachedTools = Array.isArray(config.tools) ? config.tools : [];
    if (attachedTools.length > 0) {
      // Mutually exclusive: structured-output + tools is a config error
      if (config.structuredOutput && config.toolStrategy !== 'structured-output') {
        // 'structured-output' strategy is allowed (it just ignores tools), but
        // any other combo with structuredOutput defined is invalid.
        if (!config.toolStrategy || config.toolStrategy === 'auto'
            || config.toolStrategy === 'native' || config.toolStrategy === 'prompt-injection') {
          throw new Error(
            'Neuron step config error: `tools` and `structuredOutput` are mutually exclusive. ' +
            'Either drop `structuredOutput` or set `toolStrategy: "structured-output"` to ignore the attached tools.'
          );
        }
      }

      // Resolve strategy from the model's neuron config
      let neuronCfg: any;
      try {
        neuronCfg = await neuronRegistry.getConfig(neuronId, userId);
      } catch (cfgErr) {
        console.warn('[NeuronExecutor] Could not load neuron config for capability matrix; falling back to "none":', cfgErr);
        neuronCfg = null;
      }
      const strategy: ToolStrategy = neuronCfg
        ? resolveToolStrategy(neuronCfg.provider, neuronCfg.model, config.toolStrategy)
        : (config.toolStrategy && config.toolStrategy !== 'auto' ? config.toolStrategy as ToolStrategy : 'none');

      console.log('[NeuronExecutor] Tool strategy resolved:', {
        neuronId,
        provider: neuronCfg?.provider,
        model: neuronCfg?.model,
        override: config.toolStrategy,
        resolved: strategy,
        toolCount: attachedTools.length,
      });

      if (strategy === 'native') {
        // Resolve all tools through native/MCP/graph registries
        const resolved = await resolveTools(attachedTools, state);
        const finalContent = await runNativeToolUseLoop({
          config,
          state,
          model,
          baseMessages: await buildBaseMessagesForToolLoop(config, state),
          resolvedTools: resolved,
          neuronId,
          userId,
          callRunId,
          abortSignal,
          neuronRegistry,
        });
        return { [config.outputField]: finalContent };
      }

      if (strategy === 'prompt-injection') {
        throw new Error(
          'Neuron step config error: prompt-injection tool strategy is not yet implemented. ' +
          'Use a tool-capable model (e.g. llama3.1+, qwen2.5+, mistral-nemo, gpt-4*, claude-*, gemini-1.5+) ' +
          'or set `toolStrategy: "none"` to ignore attached tools for now.'
        );
      }

      if (strategy === 'structured-output') {
        // User explicitly opted into structured output despite attaching
        // tools — fall through to the existing structuredOutput path. Tools
        // are silently ignored (the LLM won't be told about them).
        console.warn('[NeuronExecutor] toolStrategy: "structured-output" — attached tools are ignored.');
        // fall through to existing logic below
      } else if (strategy === 'none') {
        console.warn('[NeuronExecutor] toolStrategy: "none" — attached tools are ignored. Falling through to plain LLM call.');
        // fall through to existing logic below
      }
    }

    // For structured output, we need different handling based on provider
    let useNativeFormat = false;

    // Apply structured output if configured
    if (config.structuredOutput) {
      if (DEBUG)
        console.log('[NeuronExecutor] Using structured output with schema', {
          neuronId,
          outputField: config.outputField,
          schemaKeys: Object.keys(config.structuredOutput.schema),
          isOllamaModel
        });

      if (isOllamaModel) {
        // For Ollama, we'll pass the format at invocation time instead of using withStructuredOutput
        // This avoids the tool-binding issues with Ollama's JSON schema validation
        useNativeFormat = true;
        if (DEBUG) console.log('[NeuronExecutor] Will use Ollama native format at invocation');
      } else {
        // For other providers (OpenAI, Anthropic), use standard withStructuredOutput
        model = model.withStructuredOutput(config.structuredOutput.schema, {
          method: config.structuredOutput.method || 'jsonSchema',
          name: config.structuredOutput.name || 'extract'
        });
      }
    }

    // Check if userPrompt is a reference to an existing messages array
    // Pattern: {{state.messages}} or {{state.someMessagesField}} or {{state.data.messages}}
    const messagesFieldMatch = config.userPrompt.match(/^\{\{state\.([\w\.]+)\}\}$/);
    let messages: any[];

    if (messagesFieldMatch) {
      // User prompt is a direct reference to a messages field (e.g., {{state.messages}})
      const fieldName = messagesFieldMatch[1];
      console.log('[NeuronExecutor] ====== MESSAGES FIELD MODE ======');
      console.log('[NeuronExecutor] Field name:', fieldName);

      const messagesArray = getNestedProperty(state, fieldName);

      // Debug: log what we got
      console.log('[NeuronExecutor] Looking for messages at field:', fieldName);
      console.log('[NeuronExecutor] state.data keys:', state.data ? Object.keys(state.data) : 'no data');
      console.log(
        '[NeuronExecutor] messagesArray type:',
        typeof messagesArray,
        Array.isArray(messagesArray) ? 'is array' : 'not array'
      );

      if (Array.isArray(messagesArray)) {
        messages = [...messagesArray]; // Clone array to avoid mutating state

        // If config.systemPrompt is provided or systemPrefix exists, prepend/replace system message
        if (config.systemPrompt || state.systemPrefix) {
          let systemPrompt = config.systemPrompt
            ? renderTemplate(config.systemPrompt, state)
            : '';

          if (state.systemPrefix) {
            systemPrompt = systemPrompt
              ? `${state.systemPrefix}\n\n${systemPrompt}`
              : state.systemPrefix;
          }

          // Check if first message is already a system message
          if (messages.length > 0 && messages[0].role === 'system') {
            // Replace existing system message
            messages[0] = { role: 'system', content: systemPrompt };
            if (DEBUG)
              console.log('[NeuronExecutor] Using pre-built messages with system override', {
                fieldName,
                messageCount: messages.length
              });
          } else {
            // Prepend system message
            messages.unshift({ role: 'system', content: systemPrompt });
            if (DEBUG)
              console.log('[NeuronExecutor] Using pre-built messages with prepended system', {
                fieldName,
                messageCount: messages.length
              });
          }
        } else {
          if (DEBUG)
            console.log('[NeuronExecutor] Using pre-built messages array', {
              fieldName,
              messageCount: messages.length
            });
        }
      } else {
        // The field resolved to a non-array (string, undefined, etc.).
        // Fall through to standard template rendering rather than throwing —
        // the intent is a string userPrompt like {{state.data.task}}, not a
        // messages-array reference.  Treat it as regular template interpolation.
        console.log('[NeuronExecutor] userPrompt field resolved to non-array, treating as string prompt', {
          fieldName,
          type: typeof messagesArray
        });
        // Fall into the else branch below by reassigning the local var used there
        // We do this by rebuilding messages via the standard path.
        let systemPrompt: string | undefined = config.systemPrompt
          ? renderTemplate(config.systemPrompt, state)
          : undefined;
        if (state.systemPrefix) {
          systemPrompt = systemPrompt
            ? `${state.systemPrefix}\n\n${systemPrompt}`
            : state.systemPrefix;
        }
        const resolvedPrompt = messagesArray != null ? String(messagesArray) : renderTemplate(config.userPrompt, state);
        messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        const multimodalMsg = buildMultimodalMessage(config, resolvedPrompt, state);
        if (multimodalMsg) {
          messages.push(multimodalMsg);
        } else {
          messages.push({ role: 'user', content: resolvedPrompt });
        }
      }

      // In messages-array mode, if multimodal is configured and audio/image data
      // exists, upgrade the last user message to a multimodal HumanMessage.
      // We extract the text from the last user message and pass it to
      // buildMultimodalMessage so the content parts are: [audio/images..., text].
      if (config.audioInput || config.imageInput || config.multimodal) {
        const lastUserIdx = messages.reduceRight((found, msg, idx) =>
          found === -1 && (msg.role === 'user' || msg instanceof HumanMessage) ? idx : found, -1
        );
        if (lastUserIdx !== -1) {
          const lastMsg = messages[lastUserIdx];
          const existingText = typeof lastMsg.content === 'string'
            ? lastMsg.content
            : (lastMsg.content?.find?.((p: any) => p.type === 'text')?.text ?? '');
          const multimodalMsg = buildMultimodalMessage(config, existingText, state);
          if (multimodalMsg) {
            messages[lastUserIdx] = multimodalMsg;
            console.log('[NeuronExecutor] Upgraded last user message to multimodal HumanMessage');
          }
        }
      }
    } else {
      // Standard template rendering for prompts
      let systemPrompt: string | undefined = config.systemPrompt
        ? renderTemplate(config.systemPrompt, state)
        : undefined;

      // Prepend system prefix if available
      if (state.systemPrefix) {
        systemPrompt = systemPrompt
          ? `${state.systemPrefix}\n\n${systemPrompt}`
          : state.systemPrefix;
      }

      const userPrompt = renderTemplate(config.userPrompt, state);

      if (DEBUG)
        console.log('[NeuronExecutor] Building messages from templates', {
          neuronId: neuronId,
          outputField: config.outputField
        });

      // Build messages — try multimodal first when configured
      messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }

      // Attempt to build a multimodal HumanMessage (audio + image content parts)
      const multimodalMessage = buildMultimodalMessage(config, userPrompt, state);
      if (multimodalMessage) {
        messages.push(multimodalMessage);
        console.log('[NeuronExecutor] Using multimodal HumanMessage for LLM call');
      } else {
        messages.push({ role: 'user', content: userPrompt });
      }
    }

    // Normalize messages before sending to LLM
    messages = normalizeMessages(messages);

    // Check if this step should stream to user
    const streamToUser = config.stream === true;

    // Set flag in state so the streaming execution path (run.ts) can filter
    // which LLM streaming events are forwarded to the client via RunPublisher.
    state._currentStepStreamToUser = streamToUser;

    // Structured output doesn't support streaming - use invoke instead
    let response: any;

    if (config.structuredOutput) {
      // Invoke for structured output. We route through `callNeuron` (rather
      // than calling `model.invoke()` directly) so the call gets registered
      // with RunControlRegistry — that gives the interrupt subscriber a
      // direct handle on this in-flight LLM call (cooperative abort +
      // optional force-close after grace period).
      //
      // We pass `modelOverride` because the local `model` may have been
      // wrapped with `withStructuredOutput()` further up — the wrapped
      // instance still has `.invoke()` so it's compatible with callNeuron.
      let rawResponse: any;

      if (useNativeFormat) {
        // For Ollama, pass the format option at invocation time.
        // Signal threads through to the underlying HTTP request so external
        // interrupt cancels a stuck Ollama call instead of hanging.
        rawResponse = await neuronRegistry.callNeuron(neuronId, userId, messages, {
          signal: abortSignal,
          runId: callRunId,
          stream: false,
          modelOverride: model,
          invokeOptions: { format: config.structuredOutput.schema },
        });
      } else {
        // For other providers using withStructuredOutput
        rawResponse = await neuronRegistry.callNeuron(neuronId, userId, messages, {
          signal: abortSignal,
          runId: callRunId,
          stream: false,
          modelOverride: model,
        });
      }

      // Emit usage for the non-streaming (structured-output) call. rawResponse
      // is the raw provider message for native/Ollama; for withStructuredOutput
      // it's the parsed object (no usage → extractor returns zeros, acceptable).
      emitUsage(rawResponse);

      // Handle different response formats based on provider
      if (useNativeFormat) {
        // Ollama with native format returns AIMessage with JSON string content
        const content =
          typeof rawResponse.content === 'string'
            ? rawResponse.content
            : String(rawResponse.content);

        try {
          response = JSON.parse(content);
          if (DEBUG)
            console.log('[NeuronExecutor] Parsed Ollama native format response', {
              outputField: config.outputField,
              responseKeys: Object.keys(response)
            });
        } catch (parseError) {
          console.error('[NeuronExecutor] Failed to parse JSON from Ollama response', {
            content: content.substring(0, 200),
            error: parseError instanceof Error ? parseError.message : String(parseError)
          });
          throw new Error(`Failed to parse structured output: ${content.substring(0, 100)}`);
        }
      } else {
        // withStructuredOutput returns parsed object directly
        response = rawResponse;
      }

      if (DEBUG)
        console.log('[NeuronExecutor] Structured output received', {
          outputField: config.outputField,
          responseKeys: typeof response === 'object' ? Object.keys(response) : 'N/A'
        });
    } else {
      // Stream from LangChain model for standard text responses
      // Always use streaming internally for 10-20% performance improvement
      // The streamToUser flag controls whether chunks reach the client
      console.log('[NeuronExecutor] ====== ENTERING STREAMING PATH ======');

      // DEBUG: Log RAW messages BEFORE any normalization to find duplication source
      console.log('[NeuronExecutor] RAW messages BEFORE normalization:', {
        count: messages.length,
        roles: messages.map((m: any) => m.role),
        // Show content previews to identify duplicates
        previews: messages.map((m: any, i: number) => ({
          idx: i,
          role: m.role,
          contentStart: m.content?.substring(0, 80),
          contentLength: m.content?.length
        }))
      });

      // Normalize messages to prevent consecutive same-role messages (causes Ollama to hang)
      const normalizedMessages = normalizeMessages(messages);

      // Debug: Log message payload info before streaming
      const totalChars = normalizedMessages.reduce(
        (sum: number, m: any) => sum + (m.content?.length || 0),
        0
      );
      console.log('[NeuronExecutor] AFTER normalization:', {
        messageCount: normalizedMessages.length,
        totalChars,
        roles: normalizedMessages.map((m: any) => m.role),
        wasNormalized: normalizedMessages.length !== messages.length
      });

      const streamStartTime = Date.now();

      // Add timeout to stream start to avoid indefinite hangs.
      //
      // Routed through `callNeuron` so the in-flight stream is registered
      // with RunControlRegistry — that lets `runControlRegistry.cancel()`
      // reach this call directly (cooperative abort + optional force-close
      // after grace period). LangChain's BaseChatModel.stream still honors
      // the AbortSignal cooperatively, so this is belt-and-suspenders for
      // providers where signal forwarding is incomplete.
      const streamPromise = neuronRegistry.callNeuron(
        neuronId,
        userId,
        normalizedMessages,
        {
          signal: abortSignal,
          runId: callRunId,
          stream: true,
          modelOverride: model,
        },
      );
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Stream start timeout after ${STREAM_START_TIMEOUT}ms - model may be overloaded or unreachable`
            )
          );
        }, STREAM_START_TIMEOUT);
      });

      const stream: any = await Promise.race([streamPromise, timeoutPromise]);

      console.log(`[NeuronExecutor] Stream started after ${Date.now() - streamStartTime}ms`);

      // -----------------------------------------------------------------------
      // Server-side TTS: Set up AudioStreamPipeline if the neuron is audio-optimized
      // -----------------------------------------------------------------------
      let audioPipeline: AudioStreamPipeline | null = null;
      const streamPublisher = getRunPublisher(state);
      if (streamToUser && streamPublisher) {
        try {
          const neuronConfig = await neuronRegistry.getConfig(neuronId, userId);
          if (neuronConfig.audioOptimized) {
            audioPipeline = new AudioStreamPipeline({
              publisher: streamPublisher,
              ttsOptions: {
                voice: (state.data?.ttsVoice as string) || undefined,
                speed: (state.data?.ttsSpeed as number) || undefined,
              },
              // Thread the run-level abort signal so an external interrupt
              // cancels in-flight Kokoro fetches immediately.
              signal: abortSignal,
            });
            console.log('[NeuronExecutor] TTS audio pipeline enabled for audio-optimized neuron:', neuronId);
          }
        } catch (ttsSetupErr) {
          // Don't block execution if TTS setup fails
          console.warn('[NeuronExecutor] TTS setup failed, continuing without audio:', ttsSetupErr instanceof Error ? ttsSetupErr.message : ttsSetupErr);
        }
      }

      response = '';
      let chunkCount = 0;
      // Capture the chunk carrying provider usage for metering. LangChain emits
      // usage_metadata on (usually) the final chunk when stream-usage is on.
      let streamUsageChunk: any = null;

      // -----------------------------------------------------------------------
      // Stream parser support: if config has streamParser, set up a ParserExecutor
      // that can route output to configured destinations (voice, etc.)
      // -----------------------------------------------------------------------
      let neuronParser: ParserExecutor | null = null;
      const streamParserName = (config as any).streamParser;
      if (streamParserName && streamToUser) {
        try {
          const registry = getParserRegistry();
          const parserDef = await registry.getParser(streamParserName);
          if (parserDef) {
            const nativeReg = getNativeRegistry();
            const parserToolExecutor: ParserToolExecutor = async (toolName, params) => {
              if (nativeReg.has(toolName)) {
                const tool = nativeReg.get(toolName)!;
                return tool.handler(params, {} as any);
              }
              const mcp = getMcpClient(state);
              if (mcp) {
                // Pass abort signal so parser-driven tool calls also honor
                // mid-step interrupt.
                return mcp.callTool(
                  toolName,
                  params,
                  undefined,
                  abortSignal,
                );
              }
              throw new Error(`Tool "${toolName}" not available in neuron parser context`);
            };
            neuronParser = new ParserExecutor(parserDef.config, parserDef.parserConfig, parserToolExecutor);
            // Inject context from state
            const inputData = state.data?.input || state.input || {};
            neuronParser.setContext({
              channelId: inputData.channelId,
              platform: state.data?.platform || inputData._trigger?.source?.platform || inputData.type,
              messageId: inputData.messageId,
              replyToMessageId: state.data?.replyToMessageId || inputData.messageId,
              voiceChannel: inputData.voiceChannel || state.data?.voiceChannel || false,
              voiceChannelId: inputData.voiceChannelId || null,
              guildId: inputData.guildId || state.data?.input?.guildId || null,
              botWorkspaceId: inputData.botWorkspaceId || null,
              // RunPublisher for conversation output type
              runPublisher: getRunPublisher(state) || null,
              // GraphRegistry for subgraph output type
              _graphRegistry: getGraphRegistry(state) || null,
            });
            console.log(`[NeuronExecutor] Stream parser "${streamParserName}" loaded (outputs enabled)`);
          }
        } catch (parserErr: any) {
          console.warn('[NeuronExecutor] Failed to load stream parser:', parserErr.message);
        }
      }

      // Determine inactivity timeout — configurable via node config or state parameters.
      // Priority: config.inactivityTimeout > state.parameters.inactivityTimeout > default (120 s)
      const resolvedInactivityTimeout = resolveConfigValue(
        (config as any).inactivityTimeout,
        state
      );
      const STREAM_INACTIVITY_TIMEOUT =
        typeof resolvedInactivityTimeout === 'number' && resolvedInactivityTimeout > 0
          ? resolvedInactivityTimeout
          : DEFAULT_STREAM_INACTIVITY_TIMEOUT;

      // Consume the async iterator manually so we can race each .next() call against
      // the inactivity timer.  This detects a model that starts streaming but then
      // stalls mid-generation (a case the STREAM_START_TIMEOUT cannot cover).
      const asyncIter: AsyncIterator<any> = stream[Symbol.asyncIterator]
        ? stream[Symbol.asyncIterator]()
        : (stream as any)[Symbol.iterator]();

      let inactivityTimerId: ReturnType<typeof setTimeout> | null = null;

      // Returns a promise that rejects after STREAM_INACTIVITY_TIMEOUT ms.
      // A fresh promise is created for every chunk so the timer resets cleanly.
      const makeInactivityPromise = (): Promise<never> =>
        new Promise<never>((_, reject) => {
          inactivityTimerId = setTimeout(() => {
            console.error(
              `[NeuronExecutor] Stream stalled — no token received for ${STREAM_INACTIVITY_TIMEOUT / 1000}s`,
              {
                neuronId: config.neuronId,
                outputField: config.outputField,
                chunksReceivedBeforeStall: chunkCount,
                elapsedMs: Date.now() - streamStartTime
              }
            );
            reject(
              new Error(
                `LLM stream stalled — no output for ${STREAM_INACTIVITY_TIMEOUT / 1000} seconds`
              )
            );
          }, STREAM_INACTIVITY_TIMEOUT);
        });

      try {
        // Accumulate chunks with per-chunk inactivity guard
        while (true) {
          // Mid-stream abort check — if external interrupt fired while we
          // were waiting for the next chunk (or between chunks), break out
          // immediately. The underlying transport may also reject the
          // pending iterator.next() once it sees the signal, but checking
          // here ensures a clean exit even if the transport is slow to
          // notice.
          if (abortSignal?.aborted) {
            console.log('[NeuronExecutor] Abort signal detected during streaming, breaking loop');
            // Throw so the catch below closes the iterator and rethrows.
            const err: Error & { name: string } = new Error('Neuron stream aborted');
            err.name = 'AbortError';
            throw err;
          }

          // Race the next chunk against the inactivity timer
          const inactivityPromise = makeInactivityPromise();
          let iterResult: IteratorResult<any>;

          try {
            iterResult = await Promise.race([asyncIter.next(), inactivityPromise]);
          } finally {
            // Always cancel the timer before processing, whether we won or lost
            if (inactivityTimerId !== null) {
              clearTimeout(inactivityTimerId);
              inactivityTimerId = null;
            }
          }

          if (iterResult.done) {
            break;
          }

          const chunk = iterResult.value;
          chunkCount++;

          // Track the chunk that carries usage metadata (for metering emit).
          if (chunk?.usage_metadata || chunk?.response_metadata?.usage || chunk?.usageMetadata) {
            streamUsageChunk = chunk;
          }

          if (chunkCount === 1) {
            console.log(`[NeuronExecutor] First chunk received after ${Date.now() - streamStartTime}ms`);
          }

          if (chunk.content) {
            response += chunk.content;
            // Note: Whether chunks reach the user is decided by the streaming
            // execution path (run.ts) based on state._currentStepStreamToUser flag

            // Feed text to TTS pipeline (non-blocking, runs synthesis in parallel)
            if (audioPipeline) {
              audioPipeline.push(chunk.content);
            }

            // Feed text to stream parser for output routing (voice, etc.)
            // We feed raw text as a simple JSON line that the parser transform
            // can process. But for neuron output we bypass the parser's step
            // pipeline and use its outputs routing directly.
            if (neuronParser) {
              neuronParser.feedText(chunk.content);
            }
          }
        }
      } catch (streamErr) {
        // Ensure the iterator is closed on any error (inactivity timeout or otherwise)
        if (inactivityTimerId !== null) {
          clearTimeout(inactivityTimerId);
          inactivityTimerId = null;
        }
        if (asyncIter.return) {
          try { await asyncIter.return(); } catch (_) { /* ignore close errors */ }
        }
        // Cancel the TTS pipeline immediately on stream error/abort — avoids
        // waiting up to N×15s for in-flight Kokoro fetches to time out.
        if (audioPipeline) {
          audioPipeline.cancel();
        }
        throw streamErr;
      }

      console.log(
        `[NeuronExecutor] Stream complete: ${chunkCount} chunks, ${response.length} chars, ${Date.now() - streamStartTime}ms`
      );

      // Emit usage for the streaming call (best-effort — only if the provider
      // surfaced usage metadata on a chunk; some streams omit it).
      if (streamUsageChunk) void emitUsage(streamUsageChunk);

      // Flush stream parser outputs (send remaining text to voice, etc.)
      if (neuronParser) {
        try {
          await neuronParser.flushText();
          console.log('[NeuronExecutor] Stream parser outputs flushed');
        } catch (parserFlushErr: any) {
          console.warn('[NeuronExecutor] Stream parser flush failed:', parserFlushErr.message);
        }
      }

      // Flush TTS pipeline — waits for all pending synthesis to complete and publish
      if (audioPipeline) {
        try {
          await audioPipeline.flush();
          console.log(`[NeuronExecutor] TTS pipeline flushed: ${audioPipeline.audioChunkCount} audio chunks published`);
        } catch (ttsFlushErr) {
          console.warn('[NeuronExecutor] TTS pipeline flush failed:', ttsFlushErr instanceof Error ? ttsFlushErr.message : ttsFlushErr);
        }
      }
    }

    // Clear the flag after streaming completes
    state._currentStepStreamToUser = undefined;

    // Log response details (handle both string and object responses)
    if (config.structuredOutput) {
      console.log('[NeuronExecutor] Structured output response', {
        outputField: config.outputField,
        responseKeys: typeof response === 'object' ? Object.keys(response) : 'N/A',
        // Show full execution plan for planner debugging
        response: config.outputField.includes('executionPlan')
          ? JSON.stringify(response, null, 2)
          : undefined
      });
    } else if (DEBUG) {
      console.log('[NeuronExecutor] Neuron response received', {
        outputField: config.outputField,
        responseLength: response.length
      });
    }

    // Return output field
    return {
      [config.outputField]: response
    };
  } catch (error) {
    console.error('[NeuronExecutor] Neuron step failed', {
      neuronId: config.neuronId,
      outputField: config.outputField,
      error: error instanceof Error ? error.message : String(error)
    });
    throw new Error(
      `Neuron step failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// =============================================================================
// Neuron-attached tools — tool-use loop helpers
// =============================================================================

/**
 * Build the initial message list for the tool-use loop.
 *
 * Reuses the existing template-rendering logic — system prompt, multimodal
 * upgrade, messages-array mode, system prefix injection — but returns a
 * plain message array suitable for repeated calls in the loop instead of
 * mutating the executor's local `messages` variable.
 */
async function buildBaseMessagesForToolLoop(
  config: NeuronStepConfig,
  state: any,
): Promise<any[]> {
  const messagesFieldMatch = config.userPrompt.match(/^\{\{state\.([\w\.]+)\}\}$/);
  let messages: any[];

  if (messagesFieldMatch) {
    const fieldName = messagesFieldMatch[1];
    const messagesArray = getNestedProperty(state, fieldName);
    if (!Array.isArray(messagesArray)) {
      // Non-array: fall through to string rendering (same fix as main executor)
      console.log('[NeuronExecutor] buildBaseMessages: field not array, treating as string prompt', fieldName);
      const resolvedPrompt = messagesArray != null ? String(messagesArray) : renderTemplate(config.userPrompt, state);
      let systemPrompt: string | undefined = config.systemPrompt ? renderTemplate(config.systemPrompt, state) : undefined;
      if (state.systemPrefix) systemPrompt = systemPrompt ? `${state.systemPrefix}\n\n${systemPrompt}` : state.systemPrefix;
      messages = [];
      if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
      const mm = buildMultimodalMessage(config, resolvedPrompt, state);
      messages.push(mm ?? { role: 'user', content: resolvedPrompt });
      return normalizeMessages(messages);
    }
    messages = [...messagesArray];

    if (config.systemPrompt || state.systemPrefix) {
      let systemPrompt = config.systemPrompt
        ? renderTemplate(config.systemPrompt, state)
        : '';
      if (state.systemPrefix) {
        systemPrompt = systemPrompt
          ? `${state.systemPrefix}\n\n${systemPrompt}`
          : state.systemPrefix;
      }
      if (messages.length > 0 && messages[0].role === 'system') {
        messages[0] = { role: 'system', content: systemPrompt };
      } else {
        messages.unshift({ role: 'system', content: systemPrompt });
      }
    }
  } else {
    let systemPrompt: string | undefined = config.systemPrompt
      ? renderTemplate(config.systemPrompt, state)
      : undefined;
    if (state.systemPrefix) {
      systemPrompt = systemPrompt
        ? `${state.systemPrefix}\n\n${systemPrompt}`
        : state.systemPrefix;
    }
    const userPrompt = renderTemplate(config.userPrompt, state);
    messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });
  }

  return normalizeMessages(messages);
}

/**
 * Inputs for the native tool-use loop.
 */
interface NativeToolUseLoopArgs {
  config: NeuronStepConfig;
  state: any;
  /** The base LangChain model — bindTools will be called on it inside the loop */
  model: any;
  /** Initial conversation messages (system + user) */
  baseMessages: any[];
  /** Resolved tools (already passed through tool-resolver.resolveTools) */
  resolvedTools: ResolvedTool[];
  neuronId: string;
  userId: string;
  callRunId: string | undefined;
  abortSignal: AbortSignal | undefined;
  neuronRegistry: any;
}

/**
 * redToken usage metering — fire-and-forget emit of one usage event per LLM
 * call. Extracts the provider's token usage and (via the metering client)
 * appends a sample to `state.metadata.tokens` + XADDs to the `usage:events`
 * stream. Strictly optional and fail-safe: resolves to a no-op when the client
 * isn't wired (tests / init failure) and NEVER throws into or slows a run.
 *
 * `stepIdOverride` lets the tool-use loop give each iteration a distinct stepId
 * so their idempotency keys don't collide and dedupe each other.
 */
function emitNeuronUsage(params: {
  state: any;
  neuronRegistry: any;
  config: any;
  neuronId: string;
  userId: string | undefined;
  callRunId: string | undefined;
  providerResponse: any;
  modelHint?: string;
  stepIdOverride?: string;
}): void {
  // Run async work detached so the hot path never awaits metering.
  void (async () => {
    try {
      const bundle = getMeteringClient(params.state);
      // bundle is { neuron, tool, resource, publisher }; emit via the neuron surface.
      const neuron = bundle?.neuron;
      if (!neuron || !params.providerResponse) return;
      let modelStr = params.modelHint;
      if (!modelStr) {
        try {
          modelStr = (await params.neuronRegistry.getConfig(params.neuronId, params.userId))?.model;
        } catch { /* config lookup is best-effort */ }
      }
      const s = params.state;
      // Append the per-node-execution token (set by universalNode) so distinct
      // executions of the same node across graph edge-cycles don't dedupe-collide.
      const baseStepId = params.stepIdOverride || params.config?.outputField;
      const execToken = typeof s?._nodeExecToken === 'number' ? `:x${s._nodeExecToken}` : '';
      neuron.recordNeuronCall({
        state: s,
        runId: params.callRunId || 'unknown',
        accountId: params.userId || 'anonymous',
        model: modelStr || params.neuronId,
        providerResponse: params.providerResponse,
        nodeId: s?.nodeId || s?.data?.currentNodeId || s?.data?.nodeId,
        stepId: baseStepId ? `${baseStepId}${execToken}` : baseStepId,
        loopIteration: typeof s?.loopIteration === 'number' ? s.loopIteration : undefined,
        conversationId: s?.data?.conversationId || s?.conversationId,
        graphId: s?.graphId || s?.data?.graphId || s?.data?.options?.graphId,
      });
    } catch (e) {
      console.warn('[metering] neuron emit failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  })();
}

/**
 * Generate a unique tool-call id for RunPublisher events.
 */
function generateToolId(toolName: string, iteration: number): string {
  return `tool_neuron_${toolName}_${Date.now()}_${iteration}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Run the native tool-use loop.
 *
 * High level:
 *   1. Bind resolved tools to the model.
 *   2. Loop up to `maxToolIterations` times:
 *      a. Invoke the (bound) model with the current message list.
 *      b. If the response has no tool_calls, return its content as the final.
 *      c. Otherwise, dispatch each tool_call through the resolver's invoke()
 *         while emitting tool_start / tool_complete events with
 *         `triggeredBy: 'neuron'`.
 *      d. Append the assistant message (with tool_calls) and a `tool` role
 *         message per result, then loop.
 *   3. If the loop exhausts iterations, synthesize a wrap-up message.
 */
async function runNativeToolUseLoop(args: NativeToolUseLoopArgs): Promise<string> {
  const {
    config,
    state,
    model,
    baseMessages,
    resolvedTools,
    neuronId,
    userId,
    callRunId,
    abortSignal,
    neuronRegistry,
  } = args;

  const runPublisher: any = getRunPublisher(state);
  const maxIterations = typeof config.maxToolIterations === 'number' && config.maxToolIterations > 0
    ? config.maxToolIterations
    : 5;
  const neuronStepId = config.outputField;

  // Resolve per-run tool credentials once at loop start. These are templated
  // from state (e.g. a short-lived end-user bearer at
  // state.data.input.userToken) and injected into every model-driven tool
  // call's _meta.credentials so MCP servers (via the gateway) authenticate AS
  // THE USER, not as the graph owner. Headers that render empty are dropped.
  const toolCredentials: { type: string; headers: Record<string, string> } | undefined = (() => {
    const cfgCreds = config.toolCredentials;
    if (!cfgCreds || !cfgCreds.headers) return undefined;
    const headers: Record<string, string> = {};
    for (const [key, tmpl] of Object.entries(cfgCreds.headers)) {
      let rendered: string;
      try {
        rendered = typeof tmpl === 'string' ? renderTemplate(tmpl, state) : '';
      } catch {
        rendered = '';
      }
      // Drop unresolved/empty headers — an unresolved `{{...}}` leaks the raw
      // template, and a bare scheme (e.g. "Bearer ") carries no credential.
      const trimmed = (rendered || '').trim();
      if (!trimmed || trimmed.includes('{{') || /^Bearer\s*$/i.test(trimmed)) continue;
      headers[key] = rendered;
    }
    if (Object.keys(headers).length === 0) return undefined;
    return { type: cfgCreds.type || 'bearer', headers };
  })();
  if (config.toolCredentials) {
    // Never log the credential value — only whether it resolved + which headers.
    console.log('[NeuronExecutor] Per-run tool credentials:', {
      resolved: !!toolCredentials,
      headerNames: toolCredentials ? Object.keys(toolCredentials.headers) : [],
    });
  }

  // Bind the tools onto the model. LangChain's BaseChatModel.bindTools()
  // returns a new runnable with the tools wired up; we use it for every
  // invocation in the loop.
  let boundModel: any;
  try {
    if (typeof model.bindTools !== 'function') {
      throw new Error(`Model for neuron '${neuronId}' does not support bindTools()`);
    }
    boundModel = model.bindTools(toBindToolsPayload(resolvedTools));
  } catch (bindErr: any) {
    throw new Error(
      `Failed to bind tools to model for neuron '${neuronId}': ${bindErr instanceof Error ? bindErr.message : String(bindErr)}`
    );
  }

  // Working message list — grows as the loop appends assistant + tool messages.
  const messages: any[] = [...baseMessages];

  let lastToolResult: unknown = undefined;
  let lastToolName: string | undefined;
  let finalContent = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    // Cooperative abort check between iterations
    if (abortSignal?.aborted) {
      const err: Error & { name: string } = new Error('Neuron tool-use loop aborted');
      err.name = 'AbortError';
      throw err;
    }

    // Invoke the bound model. We use the non-streaming path here for
    // simplicity and correctness: tool_calls are usually only complete on the
    // final chunk anyway, and trying to stream + then re-prompt with
    // tool_calls means re-buffering the whole assistant turn. This is the
    // same approach used by langchain's standard agent loop.
    let response: any;
    try {
      response = await neuronRegistry.callNeuron(neuronId, userId, messages, {
        signal: abortSignal,
        runId: callRunId,
        stream: false,
        modelOverride: boundModel,
      });
    } catch (invokeErr: any) {
      throw new Error(
        `LLM invocation failed during tool-use loop (iteration ${iteration + 1}): ${invokeErr instanceof Error ? invokeErr.message : String(invokeErr)}`
      );
    }

    // Meter each tool-loop iteration as its own LLM call. The stepId override
    // (with the iteration index) keeps idempotency keys distinct so iterations
    // don't dedupe against each other.
    emitNeuronUsage({
      state, neuronRegistry, config, neuronId, userId, callRunId,
      providerResponse: response,
      stepIdOverride: `${neuronStepId}:tool${iteration}`,
    });

    const toolCalls: any[] = Array.isArray(response?.tool_calls) ? response.tool_calls : [];
    const responseContent: string = typeof response?.content === 'string'
      ? response.content
      : (Array.isArray(response?.content)
          ? response.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text || '').join('')
          : String(response?.content ?? ''));

    // No tool calls -> this is the final assistant message.
    if (toolCalls.length === 0) {
      finalContent = responseContent;
      // Stream the final content to the user if requested. We do this once
      // at the end (rather than incrementally) because the tool-use loop
      // works against non-streamed invocations — but the final text still
      // deserves a chunk event for UX.
      if (config.stream && runPublisher && finalContent) {
        try {
          await runPublisher.chunk(finalContent);
        } catch (chunkErr: any) {
          console.warn('[NeuronExecutor] Failed to publish final chunk after tool-use loop:', chunkErr.message);
        }
      }
      console.log(`[NeuronExecutor] Tool-use loop completed at iteration ${iteration + 1} with ${finalContent.length} chars`);
      return finalContent;
    }

    // Append the assistant message (including tool_calls) so the next
    // turn has the full context.
    messages.push(response);

    // Dispatch each tool call.
    for (const toolCall of toolCalls) {
      // Tool call shape: { id, name, args, type? } in LangChain core.
      const toolName: string = toolCall?.name ?? toolCall?.function?.name ?? 'unknown_tool';
      const rawArgs: any = toolCall?.args ?? toolCall?.function?.arguments ?? {};
      const parsedArgs: Record<string, unknown> = typeof rawArgs === 'string'
        ? safeParseJson(rawArgs)
        : (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
      const toolCallId: string | undefined = toolCall?.id;

      const resolved = resolvedTools.find((t) => t.name === toolName);
      const toolId = generateToolId(toolName, iteration);

      // Auto-inject environment context from node parameters so the LLM
      // does not need to supply environmentId / workingDir explicitly.
      // Only injects when: (1) the parameter is set on the node/graph,
      // (2) the tool schema declares that property, and (3) the LLM did
      // not already provide a value (LLM-supplied values always win).
      if (resolved) {
        const stateParams = (state as any)?.parameters;
        const stateData = (state as any)?.data;
        const schemaProps = (resolved.inputSchema as any)?.properties as Record<string, unknown> | undefined;
        // Auto-inject environmentId: check state.parameters first, then state.data
        const envId = stateParams?.environmentId || stateData?.environmentId;
        if (envId && schemaProps?.environmentId && !parsedArgs.environmentId) {
          parsedArgs.environmentId = envId;
        }
        const workDir = stateParams?.workingDir || stateData?.workingDir;
        if (workDir && schemaProps?.workingDir && !parsedArgs.workingDir) {
          parsedArgs.workingDir = workDir;
        }
      }

      // Schema-aware argument coercion. Some models emit a structured field as
      // a STRING (e.g. config: "{\"x\":1}" instead of config: {x:1}); parse it
      // back to the type the tool's schema requires so the downstream API/AJV
      // doesn't reject it. Conservative: only coerces when the param's declared
      // type excludes 'string' and the parse yields a matching type — a real
      // string param is never mangled. Any-typed params are left for the server
      // (which knows the real target schema) to handle. See coerce-args.ts.
      //
      // Defensive: coercion is a pure convenience on a hot path — if it ever
      // throws for some pathological schema/value, fall back to the raw args so
      // a coercion bug can NEVER break a tool dispatch.
      let dispatchArgs = parsedArgs;
      if (resolved) {
        try {
          dispatchArgs = coerceArgsToSchema(
            parsedArgs,
            resolved.inputSchema as Record<string, unknown>,
          );
        } catch (coerceErr: any) {
          console.warn(
            `[NeuronExecutor] arg coercion failed for '${toolName}' (using raw args):`,
            coerceErr?.message ?? coerceErr,
          );
          dispatchArgs = parsedArgs;
        }
      }

      // Cooperative abort check before dispatch
      if (abortSignal?.aborted) {
        const err: Error & { name: string } = new Error('Neuron tool-use loop aborted before tool dispatch');
        err.name = 'AbortError';
        throw err;
      }

      // Register an onCancel callback so an external interrupt can abort the
      // in-flight tool dispatch. The dispatcher itself reads
      // `ctx.abortSignal` (sourced from RunControlRegistry above), so this
      // is defense-in-depth.
      const ctxRunId = state?.runId || state?.data?.runId || null;
      const runCtx = ctxRunId ? runControlRegistry.get(ctxRunId) : undefined;
      let onCancelHandler: (() => void) | null = null;
      const localAbort = new AbortController();
      if (runCtx?.controller?.signal) {
        if (runCtx.controller.signal.aborted) {
          localAbort.abort();
        } else {
          onCancelHandler = () => {
            try { localAbort.abort(); } catch { /* ignore */ }
          };
          runCtx.controller.signal.addEventListener('abort', onCancelHandler, { once: true });
        }
      }

      // Emit tool_start
      if (runPublisher) {
        const subgraphTag = resolveSubgraphTag(state);
        await runPublisher.toolStart(toolId, toolName, resolved?.source ?? 'native', {
          input: dispatchArgs,
          triggeredBy: 'neuron',
          neuronStepId,
          ...(subgraphTag ? { subgraph: subgraphTag } : {}),
        });
      }

      let result: unknown;
      let toolFailed = false;
      try {
        if (!resolved) {
          throw new Error(`LLM emitted tool_call for unknown tool '${toolName}'`);
        }
        result = await resolved.invoke(dispatchArgs, {
          state,
          runId: ctxRunId,
          toolId,
          abortSignal: localAbort.signal ?? null,
          // Per-run credentials (templated from state) so MCP tool calls
          // authenticate as the END USER. The MCP resolver forwards this as
          // `_meta.credentials`, which the gateway reads
          // (`_meta.credentials.headers.Authorization`) to scope the request.
          credentials: toolCredentials,
        });
        lastToolResult = result;
        lastToolName = toolName;
      } catch (dispatchErr: any) {
        toolFailed = true;
        const errMsg = dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
        if (runPublisher) {
          await runPublisher.toolError(toolId, errMsg, { triggeredBy: 'neuron', neuronStepId });
        }
        // Honor errorHandling.onError on the neuron step
        const onError = config.errorHandling?.onError ?? 'throw';
        if (onError === 'throw') {
          if (onCancelHandler && runCtx?.controller?.signal) {
            try { runCtx.controller.signal.removeEventListener('abort', onCancelHandler); } catch { /* ignore */ }
          }
          throw new Error(`Tool '${toolName}' failed during neuron tool-use loop: ${errMsg}`);
        }
        // 'fallback' or 'skip' — append the error as the tool result so the
        // LLM can react. Both behave the same here because we always need
        // SOMETHING in the message thread for the assistant's tool_call.
        result = { error: errMsg, _toolError: true };
        lastToolResult = result;
      } finally {
        if (onCancelHandler && runCtx?.controller?.signal) {
          try { runCtx.controller.signal.removeEventListener('abort', onCancelHandler); } catch { /* ignore */ }
        }
      }

      if (!toolFailed && runPublisher) {
        await runPublisher.toolComplete(toolId, result, {
          neuronStep: neuronStepId,
          iteration,
        }, { triggeredBy: 'neuron', neuronStepId });
      }

      // Append a `tool` role message so the LLM sees the result on the
      // next iteration. Different providers expect slightly different
      // shapes; we send the most permissive form (LangChain core handles
      // the per-provider translation).
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        name: toolName,
        content: typeof result === 'string' ? result : safeStringify(result),
      });
    }
  }

  // Loop exhausted — synthesize a wrap-up message from the last tool result.
  const wrapUp = `I attempted multiple tool calls (max ${maxIterations}) but did not reach a final answer. ` +
    (lastToolName
      ? `Last tool: ${lastToolName}. Last result: ${safeStringify(lastToolResult).slice(0, 500)}`
      : 'No tools were dispatched.');
  console.warn('[NeuronExecutor] Tool-use loop exhausted iteration cap:', { maxIterations, lastToolName });
  if (config.stream && runPublisher) {
    try {
      await runPublisher.chunk(wrapUp);
    } catch { /* ignore */ }
  }
  return wrapUp;
}

/**
 * Parse a JSON string, returning an empty object on failure.
 */
function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(s);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Stringify a value, falling back to String(value) for circular refs.
 */
function safeStringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
