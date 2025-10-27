/**
 * Background title generation utilities
 */

import type { Red } from '../../index';
import type { ChatOllama } from '@langchain/ollama';
import { extractThinking } from '../../lib/utils/thinking';
import { getDatabase } from '../../lib/memory/database';

/**
 * Generate a title for the conversation based on the first few messages
 * Runs after 2nd message (initial title) and 6th message (refined title)
 */
export async function generateTitleInBackground(
  conversationId: string,
  messageCount: number,
  red: Red,
  chatModel: ChatOllama
): Promise<void> {
  try {
    // Only generate title after 2nd or 6th message
    if (messageCount !== 2 && messageCount !== 6) {
      return;
    }

    // Check if title was manually set by user via Context MCP
    const metadataResult = await red.callMcpTool('get_conversation_metadata', {
      conversationId
    }, { conversationId });
    
    if (metadataResult.isError) {
      console.error('[Title] Failed to get metadata:', metadataResult.content);
      return;
    }
    
    const metadata = JSON.parse(metadataResult.content?.[0]?.text || '{}');
    if (metadata?.titleSetByUser) {
      return; // Don't override user-set titles after 6th message
    }

    // Get recent messages for context via Context MCP
    const messagesResult = await red.callMcpTool('get_messages', {
      conversationId,
      limit: 6,
      source: 'auto'
    }, { conversationId });
    
    if (messagesResult.isError) {
      console.error('[Title] Failed to get messages:', messagesResult.content);
      return;
    }
    
    const messages = JSON.parse(messagesResult.content?.[0]?.text || '[]');
    const conversationText = messages
      .slice(0, Math.min(6, messages.length)) // Use first 6 messages max
      .map((m: any) => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n');

    // Create prompt for title generation
    const titlePrompt = `Based on this conversation, generate a short, descriptive title (5 words max). Only respond with the title, nothing else:

${conversationText}`;

    // Generate title using LLM
    const response = await chatModel.invoke([{ role: 'user', content: titlePrompt }]);
    const rawContent = response.content as string;
    
    // Extract thinking (if present) and get cleaned content
    const { cleanedContent } = extractThinking(rawContent);
    let title = cleanedContent.trim().replace(/^["']|["']$/g, ''); // Remove quotes if any
    
    // Enforce 5 word limit
    const words = title.split(/\s+/);
    if (words.length > 5) {
      title = words.slice(0, 5).join(' ');
    }

    // Store title in Redis metadata (use memory manager for direct access)
    const metaKey = `conversation:${conversationId}:metadata`;
    await red.memory['redis'].hset(metaKey, 'title', title);
    
    // Also update title in MongoDB database
    const database = await getDatabase();
    await database.updateConversationTitle(conversationId, title);
    
    console.log(`[Red] Generated title for ${conversationId}: "${title}"`);
  } catch (err) {
    console.error('[Red] Title generation failed:', err);
  }
}

/**
 * Set a custom title for a conversation (set by user)
 * This prevents automatic title generation from overwriting it
 */
export async function setConversationTitle(
  conversationId: string,
  title: string,
  red: Red
): Promise<void> {
  const metaKey = `conversation:${conversationId}:metadata`;
  await red.memory['redis'].hset(metaKey, {
    'title': title,
    'titleSetByUser': 'true'
  });
  
  // Also update title in MongoDB database
  const database = await getDatabase();
  await database.updateConversationTitle(conversationId, title);
  
  console.log(`[Red] User set title for ${conversationId}: "${title}"`);
}

/**
 * Get the title for a conversation
 */
export async function getConversationTitle(
  conversationId: string,
  red: Red
): Promise<string | null> {
  const metadataResult = await red.callMcpTool('get_conversation_metadata', {
    conversationId
  }, { conversationId });
  
  if (metadataResult.isError) {
    return null;
  }
  
  const metadata = JSON.parse(metadataResult.content?.[0]?.text || '{}');
  return metadata?.title || null;
}
