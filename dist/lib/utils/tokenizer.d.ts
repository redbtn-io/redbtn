/**
 * @file src/lib/tokenizer.ts
 * @description Token counting with fallback for environments where tiktoken doesn't work
 */
/**
 * Count tokens using tiktoken or fallback estimation
 */
export declare function countTokens(text: string): Promise<number>;
/**
 * Free tiktoken encoder resources
 */
export declare function freeTiktoken(): void;
/**
 * Check if tiktoken is available
 */
export declare function isTiktokenAvailable(): boolean;
