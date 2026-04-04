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
Object.defineProperty(exports, "__esModule", { value: true });
exports.getParserRegistry = getParserRegistry;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
class ParserRegistry {
    constructor() {
        this._cache = new Map();
        this._builtins = new Map();
    }
    registerBuiltin(parserId, config) {
        this._builtins.set(parserId, config);
    }
    getParser(parserId) {
        return __awaiter(this, void 0, void 0, function* () {
            // Check builtins first
            if (this._builtins.has(parserId)) {
                return this._builtins.get(parserId);
            }
            // Check cache
            const cached = this._cache.get(parserId);
            if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
                return cached.data;
            }
            // Load from MongoDB
            try {
                const mongoose = require('mongoose');
                if (mongoose.connection.readyState !== 1)
                    return null;
                const db = mongoose.connection.db;
                if (!db)
                    return null;
                const node = yield db.collection('nodes').findOne({
                    nodeId: parserId,
                    isParser: true,
                });
                if (!node)
                    return null;
                const data = {
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
            }
            catch (err) {
                console.warn(`[ParserRegistry] Failed to load parser "${parserId}":`, err.message);
                return null;
            }
        });
    }
    invalidate(parserId) {
        if (parserId) {
            this._cache.delete(parserId);
        }
        else {
            this._cache.clear();
        }
    }
}
let _instance = null;
function getParserRegistry() {
    if (!_instance) {
        _instance = new ParserRegistry();
    }
    return _instance;
}
