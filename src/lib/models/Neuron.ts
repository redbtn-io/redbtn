/**
 * Neuron MongoDB Model
 *
 * Stores neuron configurations for system defaults and user custom neurons.
 */
import * as mongoose from 'mongoose';
import { Model } from 'mongoose';
import { NeuronDocument } from '../types/neuron';

/**
 * Neuron schema
 */
const neuronSchema = new mongoose.Schema<NeuronDocument>({
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
const Neuron: Model<NeuronDocument> =
  mongoose.default.models.Neuron || mongoose.default.model<NeuronDocument>('Neuron', neuronSchema);

export default Neuron;
