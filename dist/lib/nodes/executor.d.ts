/**
 * Executor Node - Processes current step in execution plan
 *
 * This node acts as the orchestrator, reading the current step from the plan
 * and setting nextGraph to route to the appropriate specialized node.
 *
 * It doesn't execute the step itself - it just determines where to route.
 * The actual execution happens in search/command/responder nodes.
 *
 * @param state The current graph state
 * @returns Updated state with routing information
 */
export declare const executorNode: (state: any) => Promise<{
    nextGraph: string;
    toolParam?: undefined;
    commandDomain?: undefined;
    commandDetails?: undefined;
} | {
    nextGraph: undefined;
    toolParam?: undefined;
    commandDomain?: undefined;
    commandDetails?: undefined;
} | {
    nextGraph: string;
    toolParam: string | undefined;
    commandDomain?: undefined;
    commandDetails?: undefined;
} | {
    nextGraph: string;
    commandDomain: "system" | "api" | "home" | undefined;
    commandDetails: string | undefined;
    toolParam?: undefined;
}>;
