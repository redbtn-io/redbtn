/**
 * Execution plan step types
 */
export type StepType = 'search' | 'command' | 'respond';
/**
 * A single step in the execution plan
 */
export interface PlanStep {
    type: StepType;
    purpose: string;
    searchQuery?: string;
    domain?: 'system' | 'api' | 'home';
    commandDetails?: string;
}
/**
 * Complete execution plan returned by planner
 */
export interface ExecutionPlan {
    reasoning: string;
    steps: PlanStep[];
}
/**
 * Planner Node - Analyzes query and creates execution plan
 *
 * Replaces the router's single-step decision with multi-step planning.
 * Can return plans like:
 * - [respond] - Simple direct answer
 * - [search, respond] - Need current data first
 * - [command, respond] - Execute command then respond
 * - [search, command, respond] - Complex multi-tool workflow
 *
 * @param state The current graph state
 * @returns Updated state with execution plan
 */
export declare const plannerNode: (state: any) => Promise<{
    executionPlan: ExecutionPlan;
    currentStepIndex: number;
    nodeNumber: any;
    requestReplan: boolean;
    replanReason: undefined;
    replannedCount: any;
} | {
    executionPlan: {
        reasoning: string;
        steps: {
            type: "respond";
            purpose: string;
        }[];
    };
    currentStepIndex: number;
    nodeNumber: any;
    requestReplan: boolean;
    replanReason: undefined;
    replannedCount?: undefined;
}>;
