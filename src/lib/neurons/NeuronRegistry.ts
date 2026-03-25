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
import { LRUCache } from 'lru-cache';
import { createHash, createDecipheriv } from 'crypto';
import { getDatabase } from '../memory/database';
import Neuron from '../models/Neuron';
import { createLogger } from '../utils/logger';
import { NeuronConfig } from '../types/neuron';
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
