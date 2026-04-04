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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NeuronRegistry = exports.NeuronProviderError = exports.NeuronAccessDeniedError = exports.NeuronNotFoundError = void 0;
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
const ollama_1 = require("@langchain/ollama");
const openai_1 = require("@langchain/openai");
const anthropic_1 = require("@langchain/anthropic");
const google_genai_1 = require("@langchain/google-genai");
const lru_cache_1 = require("lru-cache");
const crypto_1 = require("crypto");
const database_1 = require("../memory/database");
const Neuron_1 = __importDefault(require("../models/Neuron"));
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)('NeuronRegistry');
/**
 * Create a fetch wrapper with timeout for Ollama requests
 * Default timeout: 300 seconds (5 minutes)
 */
function createOllamaFetch(timeoutMs = 300000) {
    return (input, init) => __awaiter(this, void 0, void 0, function* () {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = yield fetch(input, Object.assign(Object.assign({}, init), { signal: controller.signal }));
            return response;
        }
        catch (error) {
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    throw new Error(`Ollama request timed out after ${timeoutMs}ms`);
                }
                throw new Error(`Ollama fetch failed: ${error.message} (endpoint: ${input})`);
            }
            throw error;
        }
        finally {
            clearTimeout(timeoutId);
        }
    });
}
class NeuronNotFoundError extends Error {
    constructor(message) { super(message); this.name = 'NeuronNotFoundError'; }
}
exports.NeuronNotFoundError = NeuronNotFoundError;
class NeuronAccessDeniedError extends Error {
    constructor(message) { super(message); this.name = 'NeuronAccessDeniedError'; }
}
exports.NeuronAccessDeniedError = NeuronAccessDeniedError;
class NeuronProviderError extends Error {
    constructor(message) { super(message); this.name = 'NeuronProviderError'; }
}
exports.NeuronProviderError = NeuronProviderError;
class NeuronRegistry {
    constructor(config) {
        this.config = config;
        this.db = (0, database_1.getDatabase)(config.databaseUrl);
        this.configCache = new lru_cache_1.LRUCache({
            max: 100,
            ttl: 5 * 60 * 1000,
        });
    }
    initialize() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.db.connect();
            log.info('Initialized successfully');
        });
    }
    getModel(neuronId, userId, overrides) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b, _c;
            const config = yield this.getConfig(neuronId, userId);
            const effectiveConfig = overrides
                ? Object.assign(Object.assign({}, config), { temperature: (_a = overrides.temperature) !== null && _a !== void 0 ? _a : config.temperature, maxTokens: (_b = overrides.maxTokens) !== null && _b !== void 0 ? _b : config.maxTokens, topP: (_c = overrides.topP) !== null && _c !== void 0 ? _c : config.topP }) : config;
            yield this.validateAccess(config, userId);
            try {
                return this.createModel(effectiveConfig);
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                throw new NeuronProviderError(`Failed to create model for neuron '${neuronId}' (provider: ${config.provider}): ${errorMessage}`);
            }
        });
    }
    getConfig(neuronId, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const cacheKey = `${userId}:${neuronId}`;
            let config = this.configCache.get(cacheKey);
            if (config)
                return config;
            const doc = yield Neuron_1.default.findOne({
                neuronId,
                $or: [{ userId }, { userId: 'system' }],
            });
            if (!doc)
                throw new NeuronNotFoundError(`Neuron '${neuronId}' not found`);
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
                audioOptimized: (_a = doc.audioOptimized) !== null && _a !== void 0 ? _a : false,
            };
            this.configCache.set(cacheKey, config);
            return config;
        });
    }
    createModel(config) {
        var _a, _b, _c, _d, _e;
        switch (config.provider) {
            case 'ollama':
                return new ollama_1.ChatOllama({
                    baseUrl: config.endpoint,
                    model: config.model,
                    temperature: (_a = config.temperature) !== null && _a !== void 0 ? _a : 0.0,
                    numPredict: config.maxTokens,
                    topP: config.topP,
                    keepAlive: -1,
                    fetch: createOllamaFetch(300000),
                });
            case 'openai':
                return new openai_1.ChatOpenAI({
                    modelName: config.model,
                    temperature: (_b = config.temperature) !== null && _b !== void 0 ? _b : 0.0,
                    maxTokens: config.maxTokens,
                    topP: config.topP,
                    apiKey: config.apiKey,
                    configuration: { baseURL: config.endpoint },
                });
            case 'anthropic':
                return new anthropic_1.ChatAnthropic({
                    model: config.model,
                    temperature: (_c = config.temperature) !== null && _c !== void 0 ? _c : 0.0,
                    maxTokens: config.maxTokens,
                    topP: config.topP,
                    apiKey: config.apiKey,
                    clientOptions: { baseURL: config.endpoint },
                });
            case 'google':
                return new google_genai_1.ChatGoogleGenerativeAI({
                    model: config.model,
                    temperature: (_d = config.temperature) !== null && _d !== void 0 ? _d : 0.0,
                    maxOutputTokens: config.maxTokens,
                    topP: config.topP,
                    apiKey: config.apiKey,
                });
            case 'custom':
                return new openai_1.ChatOpenAI({
                    modelName: config.model,
                    temperature: (_e = config.temperature) !== null && _e !== void 0 ? _e : 0.0,
                    maxTokens: config.maxTokens,
                    topP: config.topP,
                    apiKey: config.apiKey || 'not-needed',
                    configuration: { baseURL: config.endpoint },
                });
            default:
                throw new NeuronProviderError(`Unknown provider: ${config.provider}`);
        }
    }
    validateAccess(config, userId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (config.userId === userId)
                return;
            if (config.userId === 'system') {
                const userTier = yield this.getUserTier(userId);
                if (userTier > config.tier) {
                    throw new NeuronAccessDeniedError(`Neuron '${config.id}' requires tier ${config.tier} or higher (user has tier ${userTier})`);
                }
                return;
            }
            throw new NeuronAccessDeniedError(`Neuron '${config.id}' is private`);
        });
    }
    getUserTier(_userId) {
        return __awaiter(this, void 0, void 0, function* () {
            return 4; // FREE tier - grants access to system neurons
        });
    }
    getUserNeurons(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            const userTier = yield this.getUserTier(userId);
            const docs = yield Neuron_1.default.find({
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
        });
    }
    clearCache(userId) {
        return __awaiter(this, void 0, void 0, function* () {
            if (userId) {
                const keysToDelete = [];
                for (const key of this.configCache.keys()) {
                    if (key.startsWith(`${userId}:`))
                        keysToDelete.push(key);
                }
                keysToDelete.forEach((key) => this.configCache.delete(key));
                log.info(`Cleared ${keysToDelete.length} cache entries for user ${userId}`);
            }
            else {
                this.configCache.clear();
                log.info('Cleared entire cache');
            }
        });
    }
    decryptApiKey(encrypted) {
        if (!encrypted)
            return '';
        if (!encrypted.includes(':'))
            return encrypted;
        const parts = encrypted.split(':');
        if (parts.length !== 3)
            return encrypted;
        const [ivBase64, authTagBase64, ciphertext] = parts;
        try {
            const keySource = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
            if (!keySource) {
                log.warn('No encryption key available, returning encrypted value');
                return encrypted;
            }
            const key = (0, crypto_1.createHash)('sha256').update(keySource).digest();
            const iv = Buffer.from(ivBase64, 'base64');
            const authTag = Buffer.from(authTagBase64, 'base64');
            const decipher = (0, crypto_1.createDecipheriv)('aes-256-gcm', key, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
        catch (_error) {
            log.warn('Failed to decrypt API key, returning as-is');
            return encrypted;
        }
    }
    subscribeToInvalidations(redisUrl) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const Redis = require('ioredis');
                const sub = new Redis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
                sub.on('error', (err) => {
                    console.error('[NeuronRegistry] Redis sub error:', err.message);
                });
                yield sub.subscribe('neuron:invalidate');
                sub.on('message', (_channel, message) => {
                    // Support plain neuronId or JSON { neuronId, userId }
                    let neuronId = message;
                    try {
                        const parsed = JSON.parse(message);
                        neuronId = parsed.neuronId || message;
                    }
                    catch (_a) { }
                    for (const key of this.configCache.keys()) {
                        if (key === neuronId || key.endsWith(':' + neuronId)) {
                            this.configCache.delete(key);
                        }
                    }
                    log.info(`Cache invalidated via pub/sub for neuron: ${neuronId}`);
                });
                log.info('Subscribed to neuron:invalidate channel');
            }
            catch (err) {
                console.error('[NeuronRegistry] Failed to subscribe to invalidations:', err);
            }
        });
    }
    shutdown() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.db.close();
            this.configCache.clear();
            log.info('Shutdown complete');
        });
    }
}
exports.NeuronRegistry = NeuronRegistry;
