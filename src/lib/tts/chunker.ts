/**
 * TTS Text Chunker
 *
 * Splits streaming text into TTS-ready segments at natural break points.
 * Uses a growing minimum buffer to balance time-to-first-audio (small first
 * chunk) against natural-sounding synthesis (larger subsequent chunks).
 *
 * Break points (priority order):
 * 1. Paragraph break (\n\n)
 * 2. Sentence end (. ! ? followed by space/end)
 * 3. Clause break (, ; : - followed by space)
 * 4. Line break (\n)
 * 5. Any space (last resort at 2.5x minimum)
 *
 * Ported from webapp's useTtsQueue.ts chunking algorithm.
 *
 * @module lib/tts/chunker
 */

// Chunking configuration
const INITIAL_MIN_CHARS = 30;
const GROWTH_FACTOR = 1.5;
const MAX_CHUNK_CHARS = 300;
const FORCE_SPLIT_MULTIPLIER = 2.5;

/**
 * Find the best break point in the buffer, given a minimum chunk size.
 * Returns the index to split AT (exclusive), or -1 if no suitable break found.
 *
 * @param buffer - The accumulated text buffer
 * @param minChars - Minimum characters before considering a break
 * @returns Index to split at, or -1 if no break found
 */
export function findBreakPoint(buffer: string, minChars: number): number {
  if (buffer.length < minChars) return -1;

  // Search for breaks only in the region [minChars..buffer.length]
  // to ensure each chunk is at least minChars long
  const searchRegion = buffer.slice(minChars);

  // 1. Paragraph break
  const paraIdx = searchRegion.indexOf('\n\n');
  if (paraIdx !== -1) return minChars + paraIdx + 2;

  // 2. Sentence end: . ! ? followed by space, newline, or end of buffer
  for (let i = 0; i < searchRegion.length; i++) {
    const ch = searchRegion[i];
    if (ch === '.' || ch === '!' || ch === '?') {
      const next = searchRegion[i + 1];
      // Make sure it's not a decimal (e.g., "3.5") or abbreviation
      if (next === undefined || next === ' ' || next === '\n' || next === '"' || next === "'") {
        // Check it's not a decimal: previous char shouldn't be a digit if current is .
        if (ch === '.' && i > 0 && /\d/.test(searchRegion[i - 1]) && next && /\d/.test(next)) {
          continue; // Skip decimals like "3.5"
        }
        return minChars + i + 1;
      }
    }
  }

  // 3. Clause break: , ; : - followed by space
  for (let i = 0; i < searchRegion.length; i++) {
    const ch = searchRegion[i];
    if ((ch === ',' || ch === ';' || ch === ':' || ch === '\u2014') && searchRegion[i + 1] === ' ') {
      return minChars + i + 2; // Include the space
    }
  }

  // 4. Line break
  const newlineIdx = searchRegion.indexOf('\n');
  if (newlineIdx !== -1) return minChars + newlineIdx + 1;

  // 5. Force split at any space if buffer is very long
  const forceThreshold = minChars * FORCE_SPLIT_MULTIPLIER;
  if (buffer.length >= forceThreshold) {
    // Find last space in the buffer (prefer later splits for longer chunks)
    const lastSpace = buffer.lastIndexOf(' ', buffer.length - 1);
    if (lastSpace >= minChars) return lastSpace + 1;
  }

  return -1;
}

/**
 * Stateful TTS text chunker.
 *
 * Feed text chunks via `push()` as they stream in from the LLM.
 * The chunker buffers text and emits segments at natural break points
 * using a growing minimum buffer size for optimal TTS quality.
 *
 * Call `flush()` when the stream completes to emit any remaining text.
 */
export class TtsChunker {
  private buffer = '';
  private minChars = INITIAL_MIN_CHARS;
  private chunkIndex = 0;

  /**
   * Push new text into the chunker buffer.
   * Returns a TTS-ready segment if a natural break point was found,
   * or null if more text is needed.
   *
   * @param text - New text to add to the buffer
   * @returns A trimmed text segment ready for synthesis, or null
   */
  push(text: string): string | null {
    this.buffer += text;

    const breakIdx = findBreakPoint(this.buffer, this.minChars);
    if (breakIdx > 0) {
      const chunk = this.buffer.slice(0, breakIdx).trim();
      this.buffer = this.buffer.slice(breakIdx);

      if (chunk) {
        this.chunkIndex++;
        // Grow minimum for next chunk
        this.minChars = Math.min(this.minChars * GROWTH_FACTOR, MAX_CHUNK_CHARS);
        return chunk;
      }
    }

    return null;
  }

  /**
   * Flush any remaining text in the buffer.
   * Call this when the LLM stream completes.
   *
   * @returns The remaining text segment, or null if buffer is empty
   */
  flush(): string | null {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining) {
      this.chunkIndex++;
      return remaining;
    }
    return null;
  }

  /**
   * Get the current chunk index (number of chunks emitted so far).
   */
  get index(): number {
    return this.chunkIndex;
  }

  /**
   * Reset the chunker to its initial state.
   */
  reset(): void {
    this.buffer = '';
    this.minChars = INITIAL_MIN_CHARS;
    this.chunkIndex = 0;
  }
}
