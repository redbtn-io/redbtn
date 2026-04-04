/**
 * Classifier Node - Fast local LLM for binary routing decision
 *
 * This is Tier 1 in the three-tier architecture:
 * - Tier 0: Precheck (pattern matching, ~50ms)
 * - Tier 1: Classifier (fast local LLM, ~500ms) ← YOU ARE HERE
 * - Tier 2: Direct/Planner (full LLM response, ~3-15s)
 *
 * The classifier makes a simple decision:
 * - DIRECT: Can answer with just my knowledge (definitions, explanations, code examples)
 * - PLAN: Need tools/actions (search, commands, multi-step reasoning)
 *
 * Uses a fast local model (qwen2.5:3b or llama3.2:3b) for speed + cost efficiency.
 */
export interface ClassifierDecision {
    decision: 'direct' | 'plan';
    confidence: number;
    reasoning: string;
}
export declare const classifierNode: (state: any) => Promise<{
    routerDecision: string;
    routerReason: string;
    routerConfidence?: undefined;
} | {
    routerDecision: string;
    routerReason: string;
    routerConfidence: number;
}>;
