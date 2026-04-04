"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Neuron MongoDB Model
 *
 * Stores neuron configurations for system defaults and user custom neurons.
 */
const mongoose = __importStar(require("mongoose"));
/**
 * Neuron schema
 */
const neuronSchema = new mongoose.Schema({
    neuronId: {
        type: String,
        required: true,
        unique: true,
        index: true,
    },
    userId: {
        type: String,
        required: true,
        index: true,
    },
    creatorId: {
        type: String,
        index: true,
    },
    status: {
        type: String,
        enum: ['active', 'abandoned', 'deleted'],
        default: 'active',
        index: true,
    },
    abandonedAt: {
        type: Date,
        default: null,
    },
    scheduledDeletionAt: {
        type: Date,
        default: null,
        index: true,
    },
    isDefault: {
        type: Boolean,
        default: false,
        index: true,
    },
    isSystem: {
        type: Boolean,
        default: false,
        index: true,
    },
    isImmutable: {
        type: Boolean,
        default: false,
    },
    parentNeuronId: {
        type: String,
        default: null,
        index: true,
    },
    name: {
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        trim: true,
    },
    provider: {
        type: String,
        required: true,
        enum: ['ollama', 'openai', 'anthropic', 'google', 'custom'],
    },
    endpoint: {
        type: String,
        required: true,
    },
    model: {
        type: String,
        required: true,
    },
    apiKey: {
        type: String, // Encrypted or null
    },
    temperature: {
        type: Number,
        default: 0.0,
    },
    maxTokens: {
        type: Number,
    },
    topP: {
        type: Number,
    },
    role: {
        type: String,
        required: true,
        enum: ['chat', 'worker', 'specialist'],
        index: true,
    },
    tier: {
        type: Number,
        required: true,
        index: true,
    },
    usageCount: {
        type: Number,
        default: 0,
    },
    lastUsedAt: {
        type: Date,
    },
}, {
    timestamps: true, // Automatically adds createdAt and updatedAt
});
// Compound indexes for efficient queries
neuronSchema.index({ userId: 1, isDefault: 1 });
neuronSchema.index({ userId: 1, role: 1 });
// Prevent model recompilation in Next.js hot reload
const Neuron = mongoose.default.models.Neuron || mongoose.default.model('Neuron', neuronSchema);
exports.default = Neuron;
