/**
 * Universal Node Orchestrator
 *
 * Main entry point for universal nodes. Handles:
 * - Normalizing single-step and multi-step configurations
 * - Executing steps sequentially
 * - Accumulating state updates across steps
 * - Error handling with step context
 * - Parameter resolution (merging node defaults with graph overrides)
 *
 * Universal nodes can have 1-N steps that execute in order, with each step
 * able to read state fields set by previous steps.
 *
 * Parameters System:
 * - Nodes define exposed parameters with defaults in their config
 * - Graphs can override parameters via nodeConfig.parameters
 * - Resolved parameters are available as {{parameters.xxx}} in templates
 */
import type { NodeConfig } from './types';
/**
 * Universal node function — the single execution entry point for all graph nodes.
 *
 * Config is loaded from MongoDB by nodeId. Supports two modes:
 * This follows the same pattern as other configurable nodes (responder, context, etc.)
 *
 * Supports two configuration modes:
 * 1. Legacy: Full config with steps embedded (for backward compatibility)
 * 2. Registry: nodeId reference to load config from MongoDB (new approach)
 *
 * Parameters:
 * - Graph can pass parameters: { nodeId: "router", parameters: { temperature: 0.3 } }
 * - These are merged with node's default parameters
 * - Available in templates as {{parameters.temperature}}
 *
 * @param state - Graph state with nodeConfig injected by compiler
 * @returns Partial state with updates from all executed steps
 */
export declare const universalNode: (state: any) => Promise<Partial<any>>;
/**
 * Validate a universal node configuration
 *
 * Checks for common configuration errors before execution.
 * Useful for API validation when users create graphs.
 *
 * @param nodeConfig - Configuration to validate
 * @throws Error if configuration is invalid
 */
export declare function validateUniversalNodeConfig(nodeConfig: NodeConfig): void;
