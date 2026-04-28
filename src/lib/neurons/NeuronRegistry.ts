/**
 * NeuronRegistry
 *
 * Manages dynamic loading and configuration of AI models (neurons).
 * Provides LRU-cached config loading, tier-based access control, and provider factory.
 *
 * Key Features:
 * - Per-user model instantiation (no shared state)
 * - LRU cache for configs (5min TTL)
 * - No model instance pooling (create fresh per call)
 * - Tier-based access validation
 * - Multiple provider support (Ollama, OpenAI, Anthropic, Google, custom)
 */
import { ChatOllama } from '@langchain/ollama';
import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, BaseMessage } from '@langchain/core/messages';
import { LRUCache } from 'lru-cache';
import { createHash, createDecipheriv } from 'crypto';
import { getDatabase } from '../memory/database';
import Neuron from '../models/Neuron';
import { createLogger } from '../utils/logger';
import { NeuronConfig } from '../types/neuron';
import { runControlRegistry, NeuronCall } from '../run/RunControlRegistry';
import type { RedConfig } from '../../index';

type PartialRedConfig = Pick<RedConfig, 'databaseUrl'> & Partial<Omit<RedConfig, 'databaseUrl'>>;

export { NeuronConfig, NeuronDocument } from '../types/neuron';

const log = createLogger('NeuronRegistry');

/**
 * Create a fetch wrapper with timeout for Ollama requests
 * Default timeout: 300 seconds (5 minutes)
 */
function createOllamaFetch(timeoutMs = 300000) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      return response;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
        }
        throw new Error(`Ollama fetch failed: ${error.message} (endpoint: ${input})`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  };
}

export class NeuronNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NeuronNotFoundError'; }
}
export class NeuronAccessDeniedError extends Error {
  constructor(message: string) { super(message); this.name = 'NeuronAccessDeniedError'; }
}
export class NeuronProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'NeuronProviderError'; }
}

export interface ModelOverrides {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

/**
 * Options accepted by `NeuronRegistry.callNeuron()`.
 *
 * @see callNeuron — top-level wrapper around `model.invoke()` / `model.stream()`
 *      that gives the run-control registry direct visibility into in-flight
 *      LLM calls so external interrupt can cancel them sub-second instead of
 *      waiting for the next chunk-loop boundary.
 */
export interface CallNeuronOptions {
  /** External AbortSignal — typically from `runControlRegistry.get(runId).controller.signal`. */
  signal?: AbortSignal;
  /**
   * Run identifier — when provided, the call is registered with the
   * RunControlRegistry so an external interrupt can cancel it directly.
   * Without this, only the explicit `signal` (if any) is honored.
   */
  runId?: string;
  /** When true, returns an async iterable of chunks instead of awaiting full response. */
  stream?: boolean;
  /** Per-call model parameter overrides (passed through to `getModel`). */
  overrides?: ModelOverrides;
  /**
   * Provider-specific invocation options (e.g. `{ format: schema }` for
   * Ollama structured output). Forwarded verbatim into `model.invoke()` /
   * `model.stream()` along with the AbortSignal. The signal in this object
   * (if any) is ignored — the wrapper merges its own signal.
   */
  invokeOptions?: Record<string, unknown>;
  /**
   * Override of the model instance to use. When set, the wrapper skips
   * `getModel()` and uses this directly. Useful for callers that need to
   * apply `withStructuredOutput()` or other transforms before invoking —
   * they can build their own model and still get registry integration.
   */
  modelOverride?: BaseChatModel | { invoke: Function; stream: Function };
}

/**
 * Wrap an async iterable so a `cleanup()` callback fires once the consumer
 * is done with the iterator (whether by exhaustion, throw, or `return`).
 *
 * Used by `NeuronRegistry.callNeuron(stream: true)` to remove the call from
 * the run-control registry after streaming finishes — if we just removed
 * pre-iteration, the registry would lose visibility before the call really
 * completed and the interrupt couldn't reach it.
 */
function wrapStreamWithCleanup(
  inner: AsyncIterable<unknown>,
  cleanup: () => void,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      const innerIter = inner[Symbol.asyncIterator]();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { cleanup(); } catch { /* ignore */ }
      };
      return {
        async next(...args: [] | [undefined]) {
          try {
            const r = await innerIter.next(...(args as []));
            if (r.done) finish();
            return r;
          } catch (err) {
            finish();
            throw err;
          }
        },
        async return(value?: unknown) {
          finish();
          if (innerIter.return) {
            try { return await innerIter.return(value as any); } catch { /* ignore */ }
          }
          return { value: value as any, done: true };
        },
        async throw(err?: unknown) {
          finish();
          if (innerIter.throw) {
            try { return await innerIter.throw(err); } catch (e) { throw e; }
          }
          throw err;
        },
      };
    },
  };
}

export class NeuronRegistry {
  private configCache: LRUCache<string, NeuronConfig>;
  private db: ReturnType<typeof getDatabase>;
  private config: PartialRedConfig;

  constructor(config: PartialRedConfig) {
    this.config = config;
    this.db = getDatabase(config.databaseUrl);
    this.configCache = new LRUCache<string, NeuronConfig>({
      max: 100,
      ttl: 5 * 60 * 1000,
    });
  }

  async initialize(): Promise<void> {
    await this.db.connect();
    log.info('Initialized successfully');
  }

  async getModel(neuronId: string, userId: string, overrides?: ModelOverrides): Promise<BaseChatModel> {
    const config = await this.getConfig(neuronId, userId);
    const effectiveConfig: NeuronConfig = overrides
      ? {
          ...config,
          temperature: overrides.temperature ?? config.temperature,
          maxTokens: overrides.maxTokens ?? config.maxTokens,
          topP: overrides.topP ?? config.topP,
        }
      : config;
    await this.validateAccess(config, userId);
    try {
      return this.createModel(effectiveConfig);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new NeuronProviderError(
        `Failed to create model for neuron '${neuronId}' (provider: ${config.provider}): ${errorMessage}`
      );
    }
  }

  /**
   * Top-level wrapper around `model.invoke()` / `model.stream()` that
   * registers the in-flight call with the RunControlRegistry so an external
   * interrupt can cancel it directly.
   *
   * # Why this exists
   *
   * `model.invoke()` and `model.stream()` accept `{ signal }` in their
   * options, and LangChain claims to forward this through to the underlying
   * transport. In practice that forwarding is incomplete and version-
   * dependent (Ollama-via-ollama-js wraps fetch, OpenAI uses its own client,
   * etc.) — so an in-flight LLM call may keep running for many seconds after
   * the signal aborts.
   *
   * `callNeuron` solves this by:
   *   1. Creating a per-call `NeuronCall` with its OWN AbortController.
   *   2. Bridging both the explicit `signal` and the run-level signal
   *      (looked up via RunControlRegistry) into the call's controller.
   *      Either source aborting cancels the call.
   *   3. Registering the NeuronCall on the run-context's `neuronCalls` Set
   *      so `runControlRegistry.cancel(runId)` can walk every in-flight
   *      call and cancel each directly (cooperative + force-close fallback).
   *   4. Passing the call's controller signal to `model.invoke()` /
   *      `model.stream()` so cooperative cancellation still works for any
   *      provider that does honor the signal correctly.
   *
   * # Returns
   *
   * - When `stream: true` — the AsyncIterable returned by `model.stream()`.
   *   Caller MUST iterate to completion (or break / throw) for proper cleanup;
   *   the wrapper installs cleanup in a `finally` outside the iterator
   *   contract, so partial iteration is fine but never iterating at all
   *   leaves the call registered for the duration of the run.
   * - When `stream: false` (default) — awaits the model.invoke() promise
   *   and returns its result.
   *
   * # Cleanup
   *
   * The NeuronCall is removed from the registry on completion (success,
   * error, or abort). Callers don't need to do anything special.
   */
  async callNeuron(
    neuronId: string,
    userId: string,
    messages: BaseMessage[] | Array<{ role: string; content: string | unknown }>,
    options: CallNeuronOptions = {},
  ): Promise<AIMessage | AsyncIterable<unknown>> {
    const model: any = options.modelOverride
      ? options.modelOverride
      : await this.getModel(neuronId, userId, options.overrides);

    if (!model) {
      throw new NeuronProviderError(`Failed to get model for neuron: ${neuronId}`);
    }

    const call = new NeuronCall(neuronId);

    // Bridge explicit caller-supplied signal into our call controller.
    // We can't merge AbortSignals natively pre-Node-20 in a portable way,
    // so we use addEventListener — both edges (explicit signal, registry
    // controller) trigger our call.cancel().
    if (options.signal) {
      if (options.signal.aborted) {
        call.cancel({ reason: 'pre-aborted' });
      } else {
        options.signal.addEventListener(
          'abort',
          () => call.cancel({ reason: 'external-signal-aborted' }),
          { once: true },
        );
      }
    }

    // Bridge the run-control registry signal so an external interrupt
    // (`runControlRegistry.cancel`) propagates here even if the caller
    // didn't pass an explicit `signal`. Also: register this call so the
    // registry's `cancel()` can walk our Set and force-close us.
    const runCtx = options.runId ? runControlRegistry.get(options.runId) : undefined;
    if (runCtx) {
      runCtx.neuronCalls.add(call);
      if (runCtx.controller.signal.aborted) {
        call.cancel({ reason: 'run-already-aborted' });
      } else {
        runCtx.controller.signal.addEventListener(
          'abort',
          () => call.cancel({ reason: 'run-aborted' }),
          { once: true },
        );
      }
    }

    const cleanup = () => {
      if (runCtx) {
        runCtx.neuronCalls.delete(call);
      }
    };

    // Build invoke options — caller-supplied opts merged with our signal.
    // Caller's options.invokeOptions.signal (if any) is overridden — this
    // wrapper owns the signal for the call.
    const invokeOpts: Record<string, unknown> = {
      ...(options.invokeOptions || {}),
      signal: call.controller.signal,
    };

    if (options.stream) {
      // Streaming path: model.stream() returns an async iterable. We can't
      // await it (it's lazy), so we wrap it to install cleanup once the
      // caller is done iterating.
      let inner: AsyncIterable<unknown>;
      try {
        inner = await model.stream(messages as any, invokeOpts);
      } catch (err) {
        cleanup();
        throw err;
      }
      return wrapStreamWithCleanup(inner, cleanup);
    }

    // Non-streaming path: await + cleanup.
    try {
      const result = await model.invoke(messages as any, invokeOpts);
      return result as AIMessage;
    } finally {
      cleanup();
    }
  }

  async getConfig(neuronId: string, userId: string): Promise<NeuronConfig> {
    const cacheKey = `${userId}:${neuronId}`;
    let config = this.configCache.get(cacheKey);
    if (config) return config;
    const doc = await Neuron.findOne({
      neuronId,
      $or: [{ userId }, { userId: 'system' }],
    });
    if (!doc) throw new NeuronNotFoundError(`Neuron '${neuronId}' not found`);
    config = {
      id: doc.neuronId,
      name: doc.name,
      provider: doc.provider,
      endpoint: doc.endpoint,
      model: doc.model,
      apiKey: doc.apiKey ? this.decryptApiKey(doc.apiKey) : undefined,
      temperature: doc.temperature,
      maxTokens: doc.maxTokens,
      topP: doc.topP,
      role: doc.role,
      tier: doc.tier,
      userId: doc.userId,
      audioOptimized: (doc as any).audioOptimized ?? false,
    };
    this.configCache.set(cacheKey, config);
    return config;
  }

  createModel(config: NeuronConfig): BaseChatModel {
    switch (config.provider) {
      case 'ollama':
        return new ChatOllama({
          baseUrl: config.endpoint,
          model: config.model,
          temperature: config.temperature ?? 0.0,
          numPredict: config.maxTokens,
          topP: config.topP,
          keepAlive: -1,
          fetch: createOllamaFetch(300000),
        });
      case 'openai':
        return new ChatOpenAI({
          modelName: config.model,
          temperature: config.temperature ?? 0.0,
          maxTokens: config.maxTokens,
          topP: config.topP,
          apiKey: config.apiKey,
          configuration: { baseURL: config.endpoint },
        });
      case 'anthropic':
        return new ChatAnthropic({
          model: config.model,
          temperature: config.temperature ?? 0.0,
          maxTokens: config.maxTokens,
          topP: config.topP,
          apiKey: config.apiKey,
          clientOptions: { baseURL: config.endpoint },
        });
      case 'google':
        return new ChatGoogleGenerativeAI({
          model: config.model,
          temperature: config.temperature ?? 0.0,
          maxOutputTokens: config.maxTokens,
          topP: config.topP,
          apiKey: config.apiKey,
        });
      case 'custom':
        return new ChatOpenAI({
          modelName: config.model,
          temperature: config.temperature ?? 0.0,
          maxTokens: config.maxTokens,
          topP: config.topP,
          apiKey: config.apiKey || 'not-needed',
          configuration: { baseURL: config.endpoint },
        });
      default:
        throw new NeuronProviderError(`Unknown provider: ${(config as NeuronConfig).provider}`);
    }
  }

  private async validateAccess(config: NeuronConfig, userId: string): Promise<void> {
    if (config.userId === userId) return;
    if (config.userId === 'system') {
      const userTier = await this.getUserTier(userId);
      if (userTier > config.tier) {
        throw new NeuronAccessDeniedError(
          `Neuron '${config.id}' requires tier ${config.tier} or higher (user has tier ${userTier})`
        );
      }
      return;
    }
    throw new NeuronAccessDeniedError(`Neuron '${config.id}' is private`);
  }

  private async getUserTier(_userId: string): Promise<number> {
    return 4; // FREE tier - grants access to system neurons
  }

  async getUserNeurons(userId: string): Promise<NeuronConfig[]> {
    const userTier = await this.getUserTier(userId);
    const docs = await Neuron.find({
      $or: [
        { userId },
        { userId: 'system', tier: { $gte: userTier } },
      ],
    }).sort({ tier: 1, neuronId: 1 });
    return docs.map((doc) => ({
      id: doc.neuronId,
      name: doc.name,
      provider: doc.provider,
      endpoint: doc.endpoint,
      model: doc.model,
      apiKey: undefined,
      temperature: doc.temperature,
      maxTokens: doc.maxTokens,
      topP: doc.topP,
      role: doc.role,
      tier: doc.tier,
      userId: doc.userId,
    }));
  }

  async clearCache(userId?: string): Promise<void> {
    if (userId) {
      const keysToDelete: string[] = [];
      for (const key of this.configCache.keys()) {
        if (key.startsWith(`${userId}:`)) keysToDelete.push(key);
      }
      keysToDelete.forEach((key) => this.configCache.delete(key));
      log.info(`Cleared ${keysToDelete.length} cache entries for user ${userId}`);
    } else {
      this.configCache.clear();
      log.info('Cleared entire cache');
    }
  }

  private decryptApiKey(encrypted: string): string {
    if (!encrypted) return '';
    if (!encrypted.includes(':')) return encrypted;
    const parts = encrypted.split(':');
    if (parts.length !== 3) return encrypted;
    const [ivBase64, authTagBase64, ciphertext] = parts;
    try {
      const keySource = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
      if (!keySource) {
        log.warn('No encryption key available, returning encrypted value');
        return encrypted;
      }
      const key = createHash('sha256').update(keySource).digest();
      const iv = Buffer.from(ivBase64, 'base64');
      const authTag = Buffer.from(authTagBase64, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch (_error) {
      log.warn('Failed to decrypt API key, returning as-is');
      return encrypted;
    }
  }

  async subscribeToInvalidations(redisUrl: string): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Redis = require('ioredis');
      const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
      sub.on('error', (err: Error) => {
        console.error('[NeuronRegistry] Redis sub error:', err.message);
      });
      await sub.subscribe('neuron:invalidate');
      sub.on('message', (_channel: string, message: string) => {
        // Support plain neuronId or JSON { neuronId, userId }
        let neuronId = message;
        try { const parsed = JSON.parse(message); neuronId = parsed.neuronId || message; } catch {}
        for (const key of this.configCache.keys()) {
          if (key === neuronId || key.endsWith(':' + neuronId)) {
            this.configCache.delete(key);
          }
        }
        log.info(`Cache invalidated via pub/sub for neuron: ${neuronId}`);
      });
      log.info('Subscribed to neuron:invalidate channel');
    } catch (err) {
      console.error('[NeuronRegistry] Failed to subscribe to invalidations:', err);
    }
  }

  async shutdown(): Promise<void> {
    await this.db.close();
    this.configCache.clear();
    log.info('Shutdown complete');
  }
}
