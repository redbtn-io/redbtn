/**
 * Response generation and streaming utilities
 */
import type { Red } from '../index';
import type { InvokeOptions } from '../index';
/**
 * Handles a direct, on-demand request from a user-facing application.
 * Automatically manages conversation history, memory, and summarization.
 * @param red The Red instance
 * @param query The user's input or request data (must have a 'message' property)
 * @param options Metadata about the source of the request and conversation settings
 * @returns For non-streaming: the full AIMessage object with content, tokens, metadata, and conversationId.
 *          For streaming: an async generator that yields metadata first (with conversationId), then string chunks, then finally the full AIMessage.
 */
export declare function respond(red: Red, query: {
    message: string;
}, options?: InvokeOptions): Promise<any | AsyncGenerator<string | any, void, unknown>>;
