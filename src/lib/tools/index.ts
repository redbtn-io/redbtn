/**
 * @file src/lib/tools/index.ts
 * @description Central registry for all AI tools available to the Red agent
 */

import { webSearchTool } from './search_web';
import { sendCommandTool } from './send_command';
import { scrapeUrlTool } from './scrape_url';

/**
 * Array of all available tools that can be bound to the LLM.
 * These are action tools that should only be used when necessary.
 */
export const allTools = [
  webSearchTool,
  sendCommandTool,
  scrapeUrlTool,
];

/**
 * Export individual tools for selective usage
 */
export { webSearchTool, sendCommandTool, scrapeUrlTool };
