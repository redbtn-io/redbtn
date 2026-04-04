/**
 * JSON Extraction Utilities
 *
 * Robust JSON extraction from LLM responses that may contain
 * extra text before or after the JSON object.
 */
/**
 * Extract a valid JSON object from text that may contain extra content.
 * Tries multiple strategies to find and parse JSON.
 *
 * @param text The text potentially containing JSON
 * @param expectedShape Optional object with expected keys to validate against
 * @returns Parsed JSON object or null if no valid JSON found
 */
export declare function extractJSON<T = any>(text: string, expectedShape?: Partial<Record<keyof T, any>>): T | null;
/**
 * Extract and validate JSON with detailed result information
 * Useful for logging what was found and how
 */
export interface JSONExtractionResult<T = any> {
    success: boolean;
    data: T | null;
    rawText: string;
    extractedText?: string;
    strategy?: 'direct' | 'braces' | 'codeblock';
    error?: string;
}
export declare function extractJSONWithDetails<T = any>(text: string, expectedShape?: Partial<Record<keyof T, any>>): JSONExtractionResult<T>;
