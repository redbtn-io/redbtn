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
/**
 * Find the best break point in the buffer, given a minimum chunk size.
 * Returns the index to split AT (exclusive), or -1 if no suitable break found.
 *
 * @param buffer - The accumulated text buffer
 * @param minChars - Minimum characters before considering a break
 * @returns Index to split at, or -1 if no break found
 */
export declare function findBreakPoint(buffer: string, minChars: number): number;
/**
 * Stateful TTS text chunker.
 *
 * Feed text chunks via `push()` as they stream in from the LLM.
 * The chunker buffers text and emits segments at natural break points
 * using a growing minimum buffer size for optimal TTS quality.
 *
 * Call `flush()` when the stream completes to emit any remaining text.
 */
export declare class TtsChunker {
    private buffer;
    private minChars;
    private chunkIndex;
    /**
     * Push new text into the chunker buffer.
     * Returns a TTS-ready segment if a natural break point was found,
     * or null if more text is needed.
     *
     * @param text - New text to add to the buffer
     * @returns A trimmed text segment ready for synthesis, or null
     */
    push(text: string): string | null;
    /**
     * Flush any remaining text in the buffer.
     * Call this when the LLM stream completes.
     *
     * @returns The remaining text segment, or null if buffer is empty
     */
    flush(): string | null;
    /**
     * Get the current chunk index (number of chunks emitted so far).
     */
    get index(): number;
    /**
     * Reset the chunker to its initial state.
     */
    reset(): void;
}
