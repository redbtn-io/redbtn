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
export function extractJSON<T = any>(
  text: string, 
  expectedShape?: Partial<Record<keyof T, any>>
): T | null {
  if (!text || typeof text !== 'string') {
    return null;
  }

  // Strategy 1: Try direct parse (fastest path)
  try {
    const parsed = JSON.parse(text.trim());
    if (isValidJSON(parsed, expectedShape)) {
      return parsed as T;
    }
  } catch {
    // Continue to other strategies
  }

  // Strategy 2: Find JSON between curly braces
  const jsonMatches = extractJSONObjects(text);
  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match);
      if (isValidJSON(parsed, expectedShape)) {
        return parsed as T;
      }
    } catch {
      continue;
    }
  }

  // Strategy 3: Find JSON in code blocks
  const codeBlockMatches = extractFromCodeBlocks(text);
  for (const match of codeBlockMatches) {
    try {
      const parsed = JSON.parse(match);
      if (isValidJSON(parsed, expectedShape)) {
        return parsed as T;
      }
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Extract potential JSON objects by finding balanced curly braces
 */
function extractJSONObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let startIndex = -1;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (char === '{') {
      if (depth === 0) {
        startIndex = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && startIndex !== -1) {
        const jsonCandidate = text.substring(startIndex, i + 1);
        results.push(jsonCandidate);
        startIndex = -1;
      }
    }
  }

  return results;
}

/**
 * Extract JSON from markdown code blocks
 */
function extractFromCodeBlocks(text: string): string[] {
  const results: string[] = [];
  
  // Match ```json ... ``` or ``` ... ```
  const codeBlockRegex = /```(?:json)?\s*\n?([\s\S]*?)```/g;
  let match;
  
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const content = match[1].trim();
    if (content.startsWith('{') && content.includes('}')) {
      results.push(content);
    }
  }

  return results;
}

/**
 * Validate that parsed JSON has expected structure
 */
function isValidJSON<T>(
  parsed: any, 
  expectedShape?: Partial<Record<keyof T, any>>
): boolean {
  // Must be an object
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }

  // If no expected shape, any object is valid
  if (!expectedShape) {
    return true;
  }

  // Check that all expected keys exist
  for (const key of Object.keys(expectedShape)) {
    if (!(key in parsed)) {
      return false;
    }
  }

  return true;
}

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

export function extractJSONWithDetails<T = any>(
  text: string,
  expectedShape?: Partial<Record<keyof T, any>>
): JSONExtractionResult<T> {
  const result: JSONExtractionResult<T> = {
    success: false,
    data: null,
    rawText: text
  };

  if (!text || typeof text !== 'string') {
    result.error = 'Invalid input: text is empty or not a string';
    return result;
  }

  // Strategy 1: Direct parse
  try {
    const parsed = JSON.parse(text.trim());
    if (isValidJSON(parsed, expectedShape)) {
      result.success = true;
      result.data = parsed as T;
      result.extractedText = text.trim();
      result.strategy = 'direct';
      return result;
    }
  } catch (e) {
    // Continue to next strategy
  }

  // Strategy 2: Extract from braces
  const jsonMatches = extractJSONObjects(text);
  for (const match of jsonMatches) {
    try {
      const parsed = JSON.parse(match);
      if (isValidJSON(parsed, expectedShape)) {
        result.success = true;
        result.data = parsed as T;
        result.extractedText = match;
        result.strategy = 'braces';
        return result;
      }
    } catch {
      continue;
    }
  }

  // Strategy 3: Extract from code blocks
  const codeBlockMatches = extractFromCodeBlocks(text);
  for (const match of codeBlockMatches) {
    try {
      const parsed = JSON.parse(match);
      if (isValidJSON(parsed, expectedShape)) {
        result.success = true;
        result.data = parsed as T;
        result.extractedText = match;
        result.strategy = 'codeblock';
        return result;
      }
    } catch {
      continue;
    }
  }

  result.error = 'No valid JSON object found in text';
  return result;
}
