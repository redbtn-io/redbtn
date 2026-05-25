/**
 * Graph MongoDB Model
 *
 * Phase 1: Dynamic Graph System
 * Stores graph configurations in MongoDB for per-user dynamic loading
 */
import { Schema, model, models, Document } from 'mongoose';
import { GraphConfig } from '../types/graph';

/**
 * Graph document interface (Mongoose document)
 */
export interface GraphDocument extends Document, Omit<GraphConfig, '_id'> {
  _id: any;
}

/**
 * Graph node schema (embedded subdocument)
 */
const graphNodeSchema = new Schema({
  id: { type: String, required: true },
  type: { type: String, required: false },
  neuronId: { type: String, default: null },
  config: { type: Schema.Types.Mixed, default: {} },
}, { _id: false });

/**
 * Graph edge schema (embedded subdocument)
 */
const graphEdgeSchema = new Schema({
  from: { type: String, required: true },
  to: { type: String },
  condition: { type: String },
  targets: { type: Map, of: String },
  fallback: { type: String },
}, { _id: false });

/**
 * Graph global config schema (embedded subdocument)
 */
const graphConfigSchema = new Schema({
  maxReplans: { type: Number, default: 3 },
  maxSearchIterations: { type: Number, default: 5 },
  timeout: { type: Number, default: 300 },
  enableFastpath: { type: Boolean, default: true },
  defaultNeuronRole: {
    type: String,
    enum: ['chat', 'worker', 'specialist'],
    default: 'chat',
  },
}, { _id: false });

/**
 * Node layout position schema (for Studio visual editor)
 */
const nodePositionSchema = new Schema({
  x: { type: Number, required: true },
  y: { type: Number, required: true },
}, { _id: false });

/**
 * Share permission schema (for collaborative editing)
 */
const sharePermissionSchema = new Schema({
  userId: { type: String, required: true },
  permission: { type: String, enum: ['view', 'edit'], default: 'view' },
  sharedAt: { type: Date, default: Date.now },
}, { _id: false });

/**
 * Main graph schema
 */
const graphSchema = new Schema({
  graphId: { type: String, required: true },
  userId: { type: String, required: true, index: true, default: 'system' },
  inputSchema: { type: Schema.Types.Mixed, default: null },
  defaultInput: { type: Schema.Types.Mixed, default: null },
  outputConfig: {
    streaming: { type: Boolean, default: true },
    persistResult: { type: Boolean, default: true },
    webhookUrl: { type: String, default: null },
    notifyEmail: { type: String, default: null },
  },
  isDefault: { type: Boolean, default: false, index: true },
  isSystem: { type: Boolean, default: false, index: true },
  isImmutable: { type: Boolean, default: false },
  parentGraphId: { type: String, default: null, index: true },
  name: { type: String, required: true },
  description: { type: String },
  tier: {
    type: Number,
    required: true,
    default: 4, // FREE tier
    validate: {
      validator: (v: number) => v >= 0 && v <= 4,
      message: 'Tier must be between 0 (ADMIN) and 4 (FREE)',
    },
  },
  version: { type: String, default: '1.0.0' },
  nodes: {
    type: [graphNodeSchema],
    required: true,
    validate: {
      validator: (v: any[]) => v && v.length > 0,
      message: 'Graph must have at least one node',
    },
  },
  edges: {
    type: [graphEdgeSchema],
    required: true,
    validate: {
      validator: (v: any[]) => v && v.length > 0,
      message: 'Graph must have at least one edge',
    },
  },
  neuronAssignments: { type: Map, of: String, default: {} },
  config: { type: graphConfigSchema, default: {} },
  // Capabilities offered to peer agents in a conversation (e.g. provides.stt
  // means this graph is electable as the conversation's STT engine).
  provides: {
    type: new Schema(
      { stt: { type: Boolean }, tts: { type: Boolean } },
      { _id: false }
    ),
    default: undefined,
  },
  layout: { type: Map, of: nodePositionSchema, default: {} },
  thumbnail: { type: String, default: null },
  isPublic: { type: Boolean, default: false, index: true },
  forkedFrom: { type: String, default: null, index: true },
  tags: { type: [String], default: [], index: true },
  sharedWith: { type: [sharePermissionSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  usageCount: { type: Number, default: 0 },
}, {
  timestamps: true,
  collection: 'graphs',
});

// Indexes for efficient querying
graphSchema.index({ graphId: 1 }, { unique: true });
graphSchema.index({ userId: 1, isDefault: 1 });
graphSchema.index({ userId: 1, tier: 1 });
graphSchema.index({ tier: 1 });

/**
 * Pre-save validation: Ensure node IDs are unique within the graph
 */
graphSchema.pre('save', async function () {
  const nodeIds = (this as any).nodes.map((n: any) => n.id);
  const uniqueIds = new Set(nodeIds);
  if (nodeIds.length !== uniqueIds.size) {
    const duplicates = nodeIds.filter((id: string, index: number) => nodeIds.indexOf(id) !== index);
    throw new Error(`Duplicate node IDs found in graph: ${duplicates.join(', ')}`);
  }
});

/**
 * Pre-save validation: Ensure edges reference valid nodes
 */
graphSchema.pre('save', async function () {
  const nodeIds = new Set((this as any).nodes.map((n: any) => n.id));
  nodeIds.add('__start__');
  nodeIds.add('__end__');
  for (const edge of (this as any).edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`Edge references unknown source node: ${edge.from}`);
    }
    if (edge.to && !nodeIds.has(edge.to)) {
      throw new Error(`Edge references unknown target node: ${edge.to}`);
    }
    if (edge.targets && typeof edge.targets === 'object') {
      for (const [key, target] of Object.entries(edge.targets)) {
        if (key.startsWith('$') || key.startsWith('_')) continue;
        if (typeof target === 'string' && !nodeIds.has(target)) {
          throw new Error(`Edge references unknown target node in condition '${key}': ${target}`);
        }
      }
    }
    if (edge.fallback && !nodeIds.has(edge.fallback)) {
      throw new Error(`Edge references unknown fallback node: ${edge.fallback}`);
    }
  }
});

/**
 * Pre-save validation: Update timestamp
 */
graphSchema.pre('save', async function () {
  (this as any).updatedAt = new Date();
});

/**
 * Export the Graph model
 * Use models.Graph if already compiled (hot reload), otherwise compile new model
 */
export const Graph = models.Graph || model('Graph', graphSchema);
