/**
 * Background title generation utilities
 */
import type { Red } from '../../index';
import type { ChatOllama } from '@langchain/ollama';
/**
 * Generate a title for the conversation based on the first few messages
 * Runs after 2nd message (initial title) and 6th message (refined title)
 */
export declare function generateTitleInBackground(conversationId: string, messageCount: number, red: Red, chatModel: ChatOllama): Promise<void>;
/**
 * Set a custom title for a conversation (set by user)
 * This prevents automatic title generation from overwriting it
 */
export declare function setConversationTitle(conversationId: string, title: string, red: Red): Promise<void>;
/**
 * Get the title for a conversation
 */
export declare function getConversationTitle(conversationId: string, red: Red): Promise<string | null>;
