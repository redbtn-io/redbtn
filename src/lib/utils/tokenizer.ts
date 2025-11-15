/**
 * @file src/lib/tokenizer.ts
 * @description Token counting with fallback for environments where tiktoken doesn't work
 */

let tiktokenEncoder: any = null;
let tiktokenAvailable = false;
let initAttempted = false;

/**
 * Initialize tiktoken encoder lazily
 */
async function initTiktoken() {
  if (tiktokenEncoder !== null) {
    return tiktokenEncoder;
  }

  // Only attempt initialization once
  if (initAttempted) {
    return null;
  }

  initAttempted = true;

  try {
    // Try to load tiktoken
    const { encoding_for_model } = await import('tiktoken');
    tiktokenEncoder = encoding_for_model('gpt-4');
    tiktokenAvailable = true;
    console.log('[Tokenizer] tiktoken loaded successfully');
    return tiktokenEncoder;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.warn('[Tokenizer] tiktoken not available, using fallback token estimation (1 token ≈ 4 chars)');
    tiktokenAvailable = false;
    return null;
  }
}

/**
 * Count tokens using tiktoken or fallback estimation
 */
export async function countTokens(text: string): Promise<number> {
  try {
    const encoder = await initTiktoken();
    
    if (encoder && tiktokenAvailable) {
      return encoder.encode(text).length;
    }
  } catch (error) {
    console.warn('[Tokenizer] Error using tiktoken, falling back to estimation');
  }

  // Fallback: rough estimate (1 token ≈ 4 characters)
  return Math.ceil(text.length / 4);
}

/**
 * Free tiktoken encoder resources
 */
export function freeTiktoken() {
  if (tiktokenEncoder && tiktokenAvailable) {
    try {
      tiktokenEncoder.free();
    } catch (error) {
      // Ignore errors during cleanup
    }
  }
  tiktokenEncoder = null;
  tiktokenAvailable = false;
}

/**
 * Check if tiktoken is available
 */
export function isTiktokenAvailable(): boolean {
  return tiktokenAvailable;
}
