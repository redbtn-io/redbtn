/**
 * Graph Compiler
 *
 * Compiles graph configurations into LangGraph StateGraph instances.
 * Uses JIT (Just-In-Time) compilation with validation.
 * All nodes run through universalNode — config is loaded from MongoDB by nodeId.
 */
import { GraphConfig, CompiledGraph } from '../types/graph';
/**
 * Compiles a graph configuration into a LangGraph CompiledStateGraph.
 * This is a JIT compilation process that happens at runtime when a graph is loaded.
 *
 * @param config Graph configuration from MongoDB
 * @returns Compiled graph ready for invocation
 * @throws GraphCompilationError if graph is invalid
 */
export declare function compileGraphFromConfig(config: GraphConfig): CompiledGraph;
/**
 * Custom error for graph compilation failures
 */
export declare class GraphCompilationError extends Error {
    readonly graphId?: string | undefined;
    constructor(message: string, graphId?: string | undefined);
}
