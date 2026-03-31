/**
 * Global State Client for AI Library
 *
 * Provides access to persistent global state that can be shared across
 * workflow executions. This enables workflows to read and write values
 * that persist beyond a single run.
 */

export class GlobalStateClient {
  private baseUrl: string;
  private userId?: string;
  private authToken?: string;
  private workflowId?: string;
  private internalKey?: string;
  private cache: Map<string, { value: any; timestamp: number }>;
  private cacheTTLMs: number;

  constructor(options: Record<string, any> = {}) {
    this.cache = new Map();
    this.cacheTTLMs = 5000;
    this.baseUrl = options.baseUrl || process.env.WEBAPP_URL || 'http://localhost:3000';
    this.userId = options.userId;
    this.authToken = options.authToken;
    this.workflowId = options.workflowId;
    this.internalKey = options.internalKey || process.env.INTERNAL_SERVICE_KEY;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) headers['Authorization'] = `Bearer ${this.authToken}`;
    if (this.userId) headers['X-User-Id'] = this.userId;
    if (this.internalKey) headers['X-Internal-Key'] = this.internalKey;
    return headers;
  }

  async getValue(namespace: string, key: string): Promise<any> {
    const cacheKey = `${namespace}.${key}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.cacheTTLMs) return cached.value;

    try {
      const response = await fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values/${key}`, { headers: this.getHeaders() });
      if (!response.ok) { if (response.status === 404) return undefined; throw new Error(`Failed: ${response.statusText}`); }
      const data = await response.json();
      this.cache.set(cacheKey, { value: data.value, timestamp: Date.now() });
      return data.value;
    } catch (error) {
      console.error(`[GlobalStateClient] Error getting ${namespace}.${key}:`, error);
      return undefined;
    }
  }

  async getNamespaceValues(namespace: string): Promise<Record<string, any>> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values`, { headers: this.getHeaders() });
      if (!response.ok) { if (response.status === 404) return {}; throw new Error(`Failed: ${response.statusText}`); }
      const data = await response.json();
      for (const [key, value] of Object.entries(data.values || {})) {
        this.cache.set(`${namespace}.${key}`, { value, timestamp: Date.now() });
      }
      return data.values || {};
    } catch (error) {
      console.error(`[GlobalStateClient] Error getting namespace ${namespace}:`, error);
      return {};
    }
  }

  async setValue(namespace: string, key: string, value: any, options?: { description?: string; ttlSeconds?: number }): Promise<boolean | undefined> {
    const modifiedBy = this.workflowId ? `workflow:${this.workflowId}` : 'system';
    const maxRetries = 3;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values`, {
          method: 'POST', headers: this.getHeaders(),
          body: JSON.stringify({ key, value, description: options?.description, ttlSeconds: options?.ttlSeconds, modifiedBy }),
        });
        if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error((error as any).message || `Failed: ${response.statusText}`); }
        this.cache.set(`${namespace}.${key}`, { value, timestamp: Date.now() });
        return true;
      } catch (error: any) {
        if (attempt < maxRetries - 1) {
          console.warn(`[GlobalStateClient] setValue retry ${attempt + 1}/${maxRetries} for ${namespace}.${key}: ${error.message}`);
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        } else {
          console.error(`[GlobalStateClient] Error setting ${namespace}.${key} after ${maxRetries} attempts:`, error);
          return false;
        }
      }
    }
  }

  async deleteValue(namespace: string, key: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/state/namespaces/${namespace}/values/${key}`, { method: 'DELETE', headers: this.getHeaders() });
      if (!response.ok && response.status !== 404) throw new Error(`Failed: ${response.statusText}`);
      this.cache.delete(`${namespace}.${key}`);
      return true;
    } catch (error) {
      console.error(`[GlobalStateClient] Error deleting ${namespace}.${key}:`, error);
      return false;
    }
  }

  clearCache(): void { this.cache.clear(); }

  async prefetch(namespace: string): Promise<void> { await this.getNamespaceValues(namespace); }

  async resolveTemplatePath(path: string): Promise<any> {
    const parts = path.split('.');
    if (parts.length < 2) return undefined;
    const [namespace, ...keyParts] = parts;
    const key = keyParts[0];
    const value = await this.getValue(namespace, key);
    if (keyParts.length > 1 && value !== undefined && typeof value === 'object') {
      return keyParts.slice(1).reduce((obj: any, k: string) => obj?.[k], value);
    }
    return value;
  }
}

let defaultClient: GlobalStateClient | null = null;

export function getGlobalStateClient(options?: Record<string, any>): GlobalStateClient {
  if (!defaultClient || options) defaultClient = new GlobalStateClient(options);
  return defaultClient;
}

export async function getGlobalValue(namespace: string, key: string): Promise<any> {
  return getGlobalStateClient().getValue(namespace, key);
}

export async function setGlobalValue(namespace: string, key: string, value: any, options?: { description?: string; ttlSeconds?: number }): Promise<boolean | undefined> {
  return getGlobalStateClient().setValue(namespace, key, value, options);
}
