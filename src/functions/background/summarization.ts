/**
 * Background summarization utilities
 */

import type { MemoryManager } from '../../lib/memory/memory';
import type { ChatOllama } from '@langchain/ollama';
import { extractThinking } from '../../lib/utils/thinking';

/**
 * Trigger summarization in background (non-blocking)
 */
export function summarizeInBackground(
  conversationId: string,
  memory: MemoryManager,
  localModel: ChatOllama
): void {
  memory.summarizeIfNeeded(conversationId, async (prompt) => {
    const response = await localModel.invoke([{ role: 'user', content: prompt }]);
    const rawContent = response.content as string;
    
    // Extract thinking (if present) and return cleaned content
    const { cleanedContent } = extractThinking(rawContent);
    return cleanedContent;
  }).catch(err => console.error('[Red] Summarization failed:', err));
}

/**
 * Generate executive summary in background (non-blocking)
 * Called after 3rd+ AI response
 */
export function generateExecutiveSummaryInBackground(
  conversationId: string,
  memory: MemoryManager,
  localModel: ChatOllama
): void {
  memory.generateExecutiveSummary(conversationId, async (prompt) => {
    const response = await localModel.invoke([{ role: 'user', content: prompt }]);
    const rawContent = response.content as string;
    
    // Extract thinking (if present) and return cleaned content
    const { cleanedContent } = extractThinking(rawContent);
    return cleanedContent;
  }).catch(err => console.error('[Red] Executive summary generation failed:', err));
}
