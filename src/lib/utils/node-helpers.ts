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
 * @param nodeNumber - The node number in the graph (increments with retries)
 * @param nodeName - Name of the node (e.g., "Router", "Search", "Responder")
 * @returns Standardized prefix string to prepend to system messages
 * 
 * @example
 * getNodeSystemPrefix(1, "Router")
 * // Returns: "You are the 1st node in a cognition graph for artificial intelligence named Red. The current date and time is Saturday, November 9, 2025, 3:45 PM."
 */
export function getNodeSystemPrefix(nodeNumber: number, nodeName: string): string {
  const now = new Date();
  
  // Format: "Saturday, November 9, 2025, 3:45 PM"
  const dateTimeStr = now.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  
  const ordinal = `${nodeNumber}${getOrdinalSuffix(nodeNumber)}`;

  return `You are a ${nodeName} node and the ${ordinal} node in a cognition graph for artificial intelligence named Red. The current date and time is ${dateTimeStr}.`;
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
