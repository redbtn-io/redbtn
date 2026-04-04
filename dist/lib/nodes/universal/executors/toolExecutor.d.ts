/**
 * Tool Step Executor
 *
 * Executes MCP tool calls with parameter rendering and retry logic.
 * Supports any registered MCP tool (web_search, scrape_url, run_command, etc.)
 */
import type { ToolStepConfig } from '../types';
/**
 * Execute a tool step (with error handling wrapper)
 *
 * @param config - Tool step configuration
 * @param state - Current graph state
 * @returns Partial state with output field set to tool result
 */
export declare function executeTool(config: ToolStepConfig, state: any): Promise<Partial<any>>;
