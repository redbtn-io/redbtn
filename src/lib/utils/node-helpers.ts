/**
 * Helper utilities for cognition graph nodes
 */

/**
 * Get ordinal suffix for node number (1st, 2nd, 3rd, 4th, etc.)
 */
function getOrdinalSuffix(num: number): string {
  const j = num % 10;
  const k = num % 100;
  
  if (j === 1 && k !== 11) return 'st';
  if (j === 2 && k !== 12) return 'nd';
  if (j === 3 && k !== 13) return 'rd';
  return 'th';
}

/**
 * Generate standardized system message prefix for cognition graph nodes
 *
 * This string is prepended to the system prompt of EVERY neuron step, so it is
 * the first thing in the cached prefix of every Anthropic call the engine
 * makes. It is therefore deliberately DAY-precision: it used to carry the
 * clock down to the minute, which re-wrote the prompt-cache prefix every 60
 * seconds and guaranteed a full-price input charge on essentially every turn
 * (see `src/lib/neurons/prompt-cache.ts`). Nothing finer than a day may be
 * interpolated here — a graph that needs the wall clock calls the native `now`
 * tool, or reads it from the user turn.
 *
 * @param nodeNumber - The node number in the graph (increments with retries)
 * @param nodeName - Name of the node (e.g., "Router", "Search", "Responder")
 * @returns Standardized prefix string to prepend to system messages
 *
 * @example
 * getNodeSystemPrefix(1, "Router")
 * // Returns: "You are a Router node and the 1st node in a cognition graph for artificial intelligence named Red. Today is Saturday, November 9, 2025."
 */
export function getNodeSystemPrefix(nodeNumber: number, nodeName: string): string {
  const now = new Date();

  // Format: "Saturday, November 9, 2025" — day precision on purpose (above).
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const ordinal = `${nodeNumber}${getOrdinalSuffix(nodeNumber)}`;

  return `You are a ${nodeName} node and the ${ordinal} node in a cognition graph for artificial intelligence named Red. Today is ${dateStr}.`;
}

/**
 * Track node execution count across retries
 * Each node should maintain its own counter and increment on retries
 */
export class NodeCounter {
  private count: number;
  
  constructor(initialCount: number = 1) {
    this.count = initialCount;
  }
  
  get current(): number {
    return this.count;
  }
  
  increment(): number {
    return ++this.count;
  }
  
  reset(): void {
    this.count = 1;
  }
}
