/**
 * Command Execution Node
 *
 * Executes shell commands via MCP with detailed progress events:
 * 1. Validates command for security
 * 2. Calls execute_command MCP tool
 * 3. Returns result for chat node
 *
 * Note: This node now uses the MCP (Model Context Protocol) system server
 * instead of direct execution for better security and architecture.
 */
import type { Red } from '../../..';
interface CommandNodeState {
    query: {
        message: string;
    };
    redInstance: Red;
    options?: {
        conversationId?: string;
        generationId?: string;
    };
    messageId?: string;
    toolParam?: string;
    contextMessages?: any[];
    nodeNumber?: number;
}
/**
 * Main command node function
 */
export declare function commandNode(state: CommandNodeState): Promise<Partial<any>>;
export {};
