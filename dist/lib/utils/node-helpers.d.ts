/**
 * Helper utilities for cognition graph nodes
 */
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
export declare function getNodeSystemPrefix(nodeNumber: number, nodeName: string): string;
/**
 * Track node execution count across retries
 * Each node should maintain its own counter and increment on retries
 */
export declare class NodeCounter {
    private count;
    constructor(initialCount?: number);
    get current(): number;
    increment(): number;
    reset(): void;
}
