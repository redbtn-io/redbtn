/**
 * Graph MongoDB Model
 *
 * Phase 1: Dynamic Graph System
 * Stores graph configurations in MongoDB for per-user dynamic loading
 */
import { Document } from 'mongoose';
import { GraphConfig } from '../types/graph';
/**
 * Graph document interface (Mongoose document)
 */
export interface GraphDocument extends Document, Omit<GraphConfig, '_id'> {
    _id: any;
}
/**
 * Export the Graph model
 * Use models.Graph if already compiled (hot reload), otherwise compile new model
 */
export declare const Graph: import("mongoose").Model<any, {}, {}, {}, any, any, any>;
