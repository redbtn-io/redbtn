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

      // Build messages
      messages = [];
      if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
      }
      messages.push({ role: 'user', content: userPrompt });
    }

    // Normalize messages before sending to LLM
    messages = normalizeMessages(messages);

    // Check if this step should stream to user
    const streamToUser = config.stream === true;

    // Set flag in state so LangGraph/respond.ts can access it
    // This allows respond.ts to filter which streaming events reach the client
    state._currentStepStreamToUser = streamToUser;

    // Structured output doesn't support streaming - use invoke instead
    let response: any;

    if (config.structuredOutput) {
      // Invoke for structured output
      let rawResponse: any;

      if (useNativeFormat) {
        // For Ollama, pass the format option at invocation time
        rawResponse = await model.invoke(messages, {
          format: config.structuredOutput.schema
        });
      } else {
        // For other providers using withStructuredOutput
        rawResponse = await model.invoke(messages);
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

      // Add timeout to stream start to avoid indefinite hangs
      const streamPromise = model.stream(normalizedMessages);
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
            // Note: Whether chunks reach the user is decided by respond.ts
            // based on state._currentStepStreamToUser flag

            // Feed text to TTS pipeline (non-blocking, runs synthesis in parallel)
            if (audioPipeline) {
              audioPipeline.push(chunk.content);
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
