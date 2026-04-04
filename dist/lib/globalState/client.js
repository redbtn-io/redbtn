"use strict";
/**
 * Global State Client for AI Library
 *
 * Provides access to persistent global state that can be shared across
 * workflow executions. This enables workflows to read and write values
 * that persist beyond a single run.
 */
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
exports.GlobalStateClient = void 0;
exports.getGlobalStateClient = getGlobalStateClient;
exports.getGlobalValue = getGlobalValue;
exports.setGlobalValue = setGlobalValue;
class GlobalStateClient {
    constructor(options = {}) {
        this.cache = new Map();
        this.cacheTTLMs = 5000;
        this.baseUrl = options.baseUrl || process.env.WEBAPP_URL || 'http://localhost:3000';
        this.userId = options.userId;
        this.authToken = options.authToken;
        this.workflowId = options.workflowId;
        this.internalKey = options.internalKey || process.env.INTERNAL_SERVICE_KEY;
    }
    getHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.authToken)
            headers['Authorization'] = `Bearer ${this.authToken}`;
        if (this.userId)
            headers['X-User-Id'] = this.userId;
        if (this.internalKey)
            headers['X-Internal-Key'] = this.internalKey;
        return headers;
    }
    getValue(namespace, key) {
        return __awaiter(this, void 0, void 0, function* () {
            const cacheKey = `${namespace}.${key}`;
            const cached = this.cache.get(cacheKey);
            if (cached && Date.now() - cached.timestamp < this.cacheTTLMs)
                return cached.value;
            try {
                const response = yield fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values/${key}`, { headers: this.getHeaders() });
                if (!response.ok) {
                    if (response.status === 404)
                        return undefined;
                    throw new Error(`Failed: ${response.statusText}`);
                }
                const data = yield response.json();
                this.cache.set(cacheKey, { value: data.value, timestamp: Date.now() });
                return data.value;
            }
            catch (error) {
                console.error(`[GlobalStateClient] Error getting ${namespace}.${key}:`, error);
                return undefined;
            }
        });
    }
    getNamespaceValues(namespace) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values`, { headers: this.getHeaders() });
                if (!response.ok) {
                    if (response.status === 404)
                        return {};
                    throw new Error(`Failed: ${response.statusText}`);
                }
                const data = yield response.json();
                for (const [key, value] of Object.entries(data.values || {})) {
                    this.cache.set(`${namespace}.${key}`, { value, timestamp: Date.now() });
                }
                return data.values || {};
            }
            catch (error) {
                console.error(`[GlobalStateClient] Error getting namespace ${namespace}:`, error);
                return {};
            }
        });
    }
    setValue(namespace, key, value, options) {
        return __awaiter(this, void 0, void 0, function* () {
            const modifiedBy = this.workflowId ? `workflow:${this.workflowId}` : 'system';
            const maxRetries = 3;
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const response = yield fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values`, {
                        method: 'POST', headers: this.getHeaders(),
                        body: JSON.stringify({ key, value, description: options === null || options === void 0 ? void 0 : options.description, ttlSeconds: options === null || options === void 0 ? void 0 : options.ttlSeconds, modifiedBy }),
                    });
                    if (!response.ok) {
                        const error = yield response.json().catch(() => ({}));
                        throw new Error(error.message || `Failed: ${response.statusText}`);
                    }
                    this.cache.set(`${namespace}.${key}`, { value, timestamp: Date.now() });
                    return true;
                }
                catch (error) {
                    if (attempt < maxRetries - 1) {
                        console.warn(`[GlobalStateClient] setValue retry ${attempt + 1}/${maxRetries} for ${namespace}.${key}: ${error.message}`);
                        yield new Promise(r => setTimeout(r, 500 * (attempt + 1)));
                    }
                    else {
                        console.error(`[GlobalStateClient] Error setting ${namespace}.${key} after ${maxRetries} attempts:`, error);
                        return false;
                    }
                }
            }
        });
    }
    deleteValue(namespace, key) {
        return __awaiter(this, void 0, void 0, function* () {
            try {
                const response = yield fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values/${key}`, { method: 'DELETE', headers: this.getHeaders() });
                if (!response.ok && response.status !== 404)
                    throw new Error(`Failed: ${response.statusText}`);
                this.cache.delete(`${namespace}.${key}`);
                return true;
            }
            catch (error) {
                console.error(`[GlobalStateClient] Error deleting ${namespace}.${key}:`, error);
                return false;
            }
        });
    }
    clearCache() { this.cache.clear(); }
    prefetch(namespace) {
        return __awaiter(this, void 0, void 0, function* () { yield this.getNamespaceValues(namespace); });
    }
    resolveTemplatePath(path) {
        return __awaiter(this, void 0, void 0, function* () {
            const parts = path.split('.');
            if (parts.length < 2)
                return undefined;
            const [namespace, ...keyParts] = parts;
            const key = keyParts[0];
            const value = yield this.getValue(namespace, key);
            if (keyParts.length > 1 && value !== undefined && typeof value === 'object') {
                return keyParts.slice(1).reduce((obj, k) => obj === null || obj === void 0 ? void 0 : obj[k], value);
            }
            return value;
        });
    }
}
exports.GlobalStateClient = GlobalStateClient;
let defaultClient = null;
function getGlobalStateClient(options) {
    if (!defaultClient || options)
        defaultClient = new GlobalStateClient(options);
    return defaultClient;
}
function getGlobalValue(namespace, key) {
    return __awaiter(this, void 0, void 0, function* () {
        return getGlobalStateClient().getValue(namespace, key);
    });
}
function setGlobalValue(namespace, key, value, options) {
    return __awaiter(this, void 0, void 0, function* () {
        return getGlobalStateClient().setValue(namespace, key, value, options);
    });
}
