/**
 * Background summarization utilities
 */
import type { MemoryManager } from '../../lib/memory/memory';
import type { ChatOllama } from '@langchain/ollama';
/**
 * Trigger summarization in background (non-blocking)
 */
export declare function summarizeInBackground(conversationId: string, memory: MemoryManager, chatModel: ChatOllama): void;
/**
 * Generate executive summary in background (non-blocking)
 * Called after 3rd+ AI response
 */
export declare function generateExecutiveSummaryInBackground(conversationId: string, memory: MemoryManager, chatModel: ChatOllama): void;
