/**
 * Utility functions for extracting and logging reasoning/thinking from LLM responses
 * Works with any model - thinking models (DeepSeek-R1) and non-thinking models (qwen, GPT)
 */
/**
 * Extracts thinking content from DeepSeek-R1 style <think>...</think> tags
 * Safe for all models - returns original content if no thinking tags found
 * @param content The full content from the LLM response
 * @returns Object with thinking (if any) and cleaned content
 */
export declare function extractThinking(content: string): {
    thinking: string | null;
    cleanedContent: string;
};
/**
 * Logs thinking to console with nice formatting
 * Only logs if thinking content exists - safe to call with null
 * @param thinking The thinking/reasoning text to log (can be null)
 * @param context Optional context label (e.g., "Router", "Chat", "ToolPicker")
 */
export declare function logThinking(thinking: string | null, context?: string): void;
/**
 * Extracts and logs thinking from content in one call
 * Returns the cleaned content
 * @param content The full content from the LLM response
 * @param context Optional context label
 * @returns The cleaned content (without thinking tags)
 */
export declare function extractAndLogThinking(content: string, context?: string): string;
