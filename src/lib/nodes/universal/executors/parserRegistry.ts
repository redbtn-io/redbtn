import type { NodeConfig } from '../types';

const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface ParserConfig {
    inputField: string;
    outputField: string;
    bufferMode: 'line' | 'chunk' | 'json';
    skipEmpty: boolean;
}

interface ParserData {
    config: NodeConfig;
    parserConfig: ParserConfig;
}

interface CacheEntry {
    data: ParserData;
    loadedAt: number;
}

class ParserRegistry {
    private _cache: Map<string, CacheEntry>;
    private _builtins: Map<string, ParserData>;

    constructor() {
        this._cache = new Map();
        this._builtins = new Map();
    }

    registerBuiltin(parserId: string, config: ParserData): void {
        this._builtins.set(parserId, config);
    }

    async getParser(parserId: string): Promise<ParserData | null> {
        // Check builtins first
        if (this._builtins.has(parserId)) {
            return this._builtins.get(parserId)!;
        }

        // Check cache
        const cached = this._cache.get(parserId);
        if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
            return cached.data;
        }

        // Load from MongoDB
        try {
            const mongoose = require('mongoose');
            if (mongoose.connection.readyState !== 1) return null;

            const db = mongoose.connection.db;
            if (!db) return null;

            const node = await db.collection('nodes').findOne({
                nodeId: parserId,
                isParser: true,
            });

            if (!node) return null;

            const data: ParserData = {
                config: { steps: node.steps || [] },
                parserConfig: node.parserConfig || {
                    inputField: 'chunk',
                    outputField: 'parsedContent',
                    bufferMode: 'line',
                    skipEmpty: true,
                },
            };

            this._cache.set(parserId, { data, loadedAt: Date.now() });
            return data;
        } catch (err: any) {
            console.warn(`[ParserRegistry] Failed to load parser "${parserId}":`, err.message);
            return null;
        }
    }

    invalidate(parserId?: string): void {
        if (parserId) {
            this._cache.delete(parserId);
        } else {
            this._cache.clear();
        }
    }
}

let _instance: ParserRegistry | null = null;

export function getParserRegistry(): ParserRegistry {
    if (!_instance) {
        _instance = new ParserRegistry();
    }
    return _instance;
}
