/**
 * Fast Path Command Executor (PLACEHOLDER)
 *
 * This node will execute pattern-matched commands directly without LLM intervention.
 * For now, it's a placeholder that logs the match and returns a simple response.
 *
 * TODO: Implement actual command execution when precheck patterns are added.
 *
 * Flow (future):
 * 1. Receive command details from precheck (tool, server, parameters)
 * 2. Call the MCP tool directly
 * 3. Return formatted response
 */
export declare const fastpathExecutorNode: (state: any) => Promise<{
    response: {
        role: string;
        content: string;
    };
    fastpathComplete: boolean;
}>;
