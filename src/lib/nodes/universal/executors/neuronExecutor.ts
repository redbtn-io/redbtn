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
import { HumanMessage } from '@langchain/core/messages';

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

// Debug logging - set to true to enable verbose logs
const DEBUG = false;

// Timeout for stream to start (180 seconds - longer for local models with large context)
const STREAM_START_TIMEOUT = 180000;

// Default inactivity timeout once streaming has begun (120 seconds without any token = stall)
const DEFAULT_STREAM_INACTIVITY_TIMEOUT = 120000;

/**
 * Normalize messages to ensure valid LLM conversation format.
 *
 * Issues this fixes:
 * 1. Consecutive same-role messages (user, user) - merges them
 * 2. Multiple system messages - merges all into the first system message
 * 3. System messages not at the start - moves their content to the first system
 *
 * Many LLM APIs (including Ollama) hang or error with these malformed inputs.
 */
function normalizeMessages(messages: any[]): any[] {
  if (!messages || messages.length === 0) return messages;

  // First pass: collect all system message content
  let systemContent = '';
  const nonSystemMessages: any[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (systemContent) {
        systemContent += '\n\n' + msg.content;
        console.log('[NeuronExecutor] Merged additional system message into first');
      } else {
        systemContent = msg.content;
      }
    } else {
      nonSystemMessages.push({ ...msg });
    }
  }

  // Second pass: merge consecutive same-role messages
  const normalized: any[] = [];

  // Add consolidated system message first
  if (systemContent) {
    normalized.push({ role: 'system', content: systemContent });
  }

  // Add non-system messages, merging consecutive same roles
  for (const msg of nonSystemMessages) {
    const lastMsg = normalized[normalized.length - 1];
    // If same role as previous, merge content
    if (lastMsg && lastMsg.role === msg.role) {
      lastMsg.content = `${lastMsg.content}\n\n${msg.content}`;
      console.log(`[NeuronExecutor] Merged consecutive ${msg.role} messages`);
    } else {
      normalized.push({ ...msg });
    }
  }

  return normalized;
}

/**
 * Resolve a config value that might be a template string like "{{parameters.temperature}}"
 * Returns the resolved value (as number if it was a parameter reference) or the original value
 */
function resolveConfigValue(value: any, state: any): any {
  if (typeof value !== 'string') {
    return value;
  }

  // Check if it's a simple parameter template like "{{parameters.temperature}}"
  const paramMatch = value.match(/^\{\{parameters\.(\w+)\}\}$/);
  if (paramMatch && state.parameters) {
    const paramName = paramMatch[1];
    const resolved = state.parameters[paramName];
    if (resolved !== undefined) {
      if (DEBUG) console.log(`[NeuronExecutor] Resolved parameter ${paramName}:`, resolved);
      return resolved;
    }
  }

  // Check if it's a state reference like "{{state.data.someValue}}"
  const stateMatch = value.match(/^\{\{state\.(.+)\}\}$/);
  if (stateMatch) {
    const path = stateMatch[1];
    const resolved = getNestedProperty(state, path);
    if (resolved !== undefined) {
      if (DEBUG) console.log(`[NeuronExecutor] Resolved state path ${path}:`, resolved);
      return resolved;
    }
  }

  // Not a template or couldn't resolve - return as-is
  return value;
}

/**
 * Attachment reference shape (mirrors the Discord bot payload + trigger metadata)
 */
interface AttachmentRef {
  kind?: 'image' | 'video' | 'audio' | 'document' | 'file';
  mimeType?: string;
  url?: string;
  filename?: string;
  size?: number;
}

/**
 * Build a multimodal HumanMessage that may include audio and/or image content parts.
 *
 * Audio: pulled from state.data.input.audioData (base64 WAV from Discord raw audio mode)
 * Images: pulled from state.data.input.attachments or state.data._trigger.metadata.attachments
 *
 * Returns null when no multimodal content is found so the caller can fall back
 * to a plain string message.
 *
 * @langchain/google-genai v2.1.26 supports:
 *   { type: "media", mimeType: "audio/wav", data: base64 }  -> inlineData
 *   { type: "image_url", image_url: { url: "https://..." } } -> fileData / inlineData
 */
function buildMultimodalMessage(
  config: NeuronStepConfig,
  textContent: string,
  state: any
): HumanMessage | null {
  const wantsAudio = config.audioInput || config.multimodal;
  const wantsImages = config.imageInput || config.multimodal;

  if (!wantsAudio && !wantsImages) return null;

  const input = state.data?.input || {};
  const triggerAttachments: AttachmentRef[] =
    state.data?._trigger?.metadata?.attachments || input.attachments || [];

  const contentParts: any[] = [];
  let hasMultimodal = false;

  // --- Audio input ---
  if (wantsAudio && input.audioData) {
    const mimeType: string = input.audioMimeType || 'audio/wav';
    contentParts.push({
      type: 'media',
      mimeType,
      data: input.audioData, // base64 encoded
    });
    hasMultimodal = true;
    console.log(
      `[NeuronExecutor] Multimodal: added audio content part (${mimeType}, ${input.audioData.length} base64 chars)`
    );
  }

  // --- Image input from attachments ---
  if (wantsImages && triggerAttachments.length > 0) {
    for (const attachment of triggerAttachments) {
      const mime = attachment.mimeType || '';
      if (!mime.startsWith('image/') && attachment.kind !== 'image') continue;
      if (!attachment.url) continue;

      contentParts.push({
        type: 'image_url',
        image_url: { url: attachment.url },
      });
      hasMultimodal = true;
      console.log(
        `[NeuronExecutor] Multimodal: added image content part (${mime}, ${attachment.url.substring(0, 80)})`
      );
    }
  }

  if (!hasMultimodal) return null;

  // Append the rendered text prompt as the last part
  if (textContent) {
    contentParts.push({ type: 'text', text: textContent });
  }

  return new HumanMessage({ content: contentParts });
}

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
    // Get neuron registry from state
    const neuronRegistry = state.neuronRegistry;

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
        throw new Error(`Field ${fieldName} is not an array. Cannot use as messages.`);
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
      if (streamToUser && state.runPublisher) {
        try {
          const neuronConfig = await neuronRegistry.getConfig(neuronId, userId);
          if (neuronConfig.audioOptimized) {
            audioPipeline = new AudioStreamPipeline({
              publisher: state.runPublisher,
              ttsOptions: {
                voice: (state.data?.ttsVoice as string) || undefined,
                speed: (state.data?.ttsSpeed as number) || undefined,
              },
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
              if (state.mcpClient) {
                // Pass abort signal so parser-driven tool calls also honor
                // mid-step interrupt.
                return state.mcpClient.callTool(
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
              runPublisher: state.runPublisher || null,
              // GraphRegistry for subgraph output type
              _graphRegistry: state._graphRegistry || null,
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
        // Best-effort flush of any pending TTS audio on error
        if (audioPipeline) {
          try { await audioPipeline.flush(); } catch (_) { /* ignore */ }
        }
        throw streamErr;
      }

      console.log(
        `[NeuronExecutor] Stream complete: ${chunkCount} chunks, ${response.length} chars, ${Date.now() - streamStartTime}ms`
      );

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
