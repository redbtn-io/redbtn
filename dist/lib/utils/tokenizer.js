"use strict";
/**
 * @file src/lib/tokenizer.ts
 * @description Token counting with fallback for environments where tiktoken doesn't work
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
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
exports.countTokens = countTokens;
exports.freeTiktoken = freeTiktoken;
exports.isTiktokenAvailable = isTiktokenAvailable;
let tiktokenEncoder = null;
let tiktokenAvailable = false;
let initAttempted = false;
/**
 * Initialize tiktoken encoder lazily
 */
function initTiktoken() {
    return __awaiter(this, void 0, void 0, function* () {
        if (tiktokenEncoder !== null) {
            return tiktokenEncoder;
        }
        // Only attempt initialization once
        if (initAttempted) {
            return null;
        }
        initAttempted = true;
        try {
            // Try to load tiktoken
            const { encoding_for_model } = yield Promise.resolve().then(() => __importStar(require('tiktoken')));
            tiktokenEncoder = encoding_for_model('gpt-4');
            tiktokenAvailable = true;
            console.log('[Tokenizer] tiktoken loaded successfully');
            return tiktokenEncoder;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            console.warn('[Tokenizer] tiktoken not available, using fallback token estimation (1 token ≈ 4 chars)');
            tiktokenAvailable = false;
            return null;
        }
    });
}
/**
 * Count tokens using tiktoken or fallback estimation
 */
function countTokens(text) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const encoder = yield initTiktoken();
            if (encoder && tiktokenAvailable) {
                return encoder.encode(text).length;
            }
        }
        catch (error) {
            console.warn('[Tokenizer] Error using tiktoken, falling back to estimation');
        }
        // Fallback: rough estimate (1 token ≈ 4 characters)
        return Math.ceil(text.length / 4);
    });
}
/**
 * Free tiktoken encoder resources
 */
function freeTiktoken() {
    if (tiktokenEncoder && tiktokenAvailable) {
        try {
            tiktokenEncoder.free();
        }
        catch (error) {
            // Ignore errors during cleanup
        }
    }
    tiktokenEncoder = null;
    tiktokenAvailable = false;
}
/**
 * Check if tiktoken is available
 */
function isTiktokenAvailable() {
    return tiktokenAvailable;
}
