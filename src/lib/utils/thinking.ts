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
export function extractThinking(content: string): {
  thinking: string | null;
  cleanedContent: string;
} {
  if (!content || typeof content !== 'string') {
    return { thinking: null, cleanedContent: content || '' };
  }
  
  // Match <think>...</think> tags (case insensitive, multiline)
  const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
  const matches = [...content.matchAll(thinkRegex)];
  
  if (matches.length === 0) {
    // No thinking tags - return content as-is
    return { thinking: null, cleanedContent: content };
  }
  
  // Extract all thinking sections
  const thinkingSections = matches.map(m => m[1].trim());
  const thinking = thinkingSections.join('\n\n---\n\n');
  
  // Remove thinking tags from content and clean up whitespace
  let cleanedContent = content.replace(thinkRegex, '');
  
  // Remove leading/trailing whitespace and collapse multiple newlines
  cleanedContent = cleanedContent
    .trim()
    .replace(/\n{3,}/g, '\n\n'); // Max 2 consecutive newlines
  
  return { thinking, cleanedContent };
}

/**
 * Logs thinking to console with nice formatting
 * Only logs if thinking content exists - safe to call with null
 * @param thinking The thinking/reasoning text to log (can be null)
 * @param context Optional context label (e.g., "Router", "Chat", "ToolPicker")
 */
export function logThinking(thinking: string | null, context: string = 'LLM'): void {
  // Don't log if no thinking content
  if (!thinking || thinking.trim().length === 0) {
    return;
  }
  
  const boxWidth = 80;
  const borderTop = '╔' + '═'.repeat(boxWidth - 2) + '╗';
  const borderBottom = '╚' + '═'.repeat(boxWidth - 2) + '╝';
  const header = `💭 ${context} Thinking`;
  
  console.log('\n' + borderTop);
  console.log('║ ' + header.padEnd(boxWidth - 3) + '║');
  console.log('╠' + '═'.repeat(boxWidth - 2) + '╣');
  
  // Split thinking into lines and wrap to fit in box
  const lines = thinking.split('\n');
  lines.forEach(line => {
    if (line.length === 0) {
      console.log('║' + ' '.repeat(boxWidth - 2) + '║');
      return;
    }
    
    // Word wrap long lines
    const words = line.split(' ');
    let currentLine = '';
    
    words.forEach(word => {
      if ((currentLine + ' ' + word).length > boxWidth - 6) {
        // Print current line and start new one
        console.log('║ ' + currentLine.padEnd(boxWidth - 3) + '║');
        currentLine = word;
      } else {
        currentLine = currentLine ? currentLine + ' ' + word : word;
      }
    });
    
    // Print remaining text
    if (currentLine) {
      console.log('║ ' + currentLine.padEnd(boxWidth - 3) + '║');
    }
  });
  
  console.log(borderBottom + '\n');
}

/**
 * Extracts and logs thinking from content in one call
 * Returns the cleaned content
 * @param content The full content from the LLM response
 * @param context Optional context label
 * @returns The cleaned content (without thinking tags)
 */
export function extractAndLogThinking(content: string, context: string = 'LLM'): string {
  const { thinking, cleanedContent } = extractThinking(content);
  
  if (thinking) {
    logThinking(thinking, context);
  }
  
  return cleanedContent;
}
