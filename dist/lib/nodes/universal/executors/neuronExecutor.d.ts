/**
 * Neuron Step Executor
 *
 * Executes LLM calls with template rendering for prompts.
 * Supports custom neurons or default LLM with configurable parameters.
 *
 * Parameter Override Flow:
 * 1. Node definition has `parameters` map with defaults (e.g., temperature: 0.1)
 * 2. Graph can override via `config.parameters: { temperature: 0.3 }`
 * 3. Resolved parameters are injected into state as `state.parameters`
 * 4. Step configs can use `"{{parameters.temperature}}"` to reference them
 * 5. This executor resolves those templates to actual values before using them
 */
import type { NeuronStepConfig } from '../types';
/**
 * Execute a neuron step (with error handling wrapper)
 *
 * @param config - Neuron step configuration
 * @param state - Current graph state
 * @returns Partial state with output field set to LLM response
 */
export declare function executeNeuron(config: NeuronStepConfig, state: any): Promise<Partial<any>>;
