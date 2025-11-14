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

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { getNodeSystemPrefix } from '../../utils/node-helpers';

interface CommandNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // Command to execute
  contextMessages?: any[]; // Pre-loaded context from router
  nodeNumber?: number; // Current node position in graph
}

/**
 * Main command node function
 */
export async function commandNode(state: CommandNodeState): Promise<Partial<any>> {
  const startTime = Date.now();
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  const currentNodeNumber = state.nodeNumber || 2; // If not set, default to 2
  const nextNodeNumber = currentNodeNumber + 1; // Responder will be next
  
  // Get command from toolParam or query
  const command = state.toolParam || state.query?.message || '';

  // NOTE: Event publishing is now handled by the MCP registry wrapper
  // No need for node-level event publishing anymore
  let publisher: any = null;
  // Disabled: registry publishes events automatically
  // if (redInstance?.messageQueue && messageId && conversationId) {
  //   publisher = createIntegratedPublisher(
  //     redInstance.messageQueue,
  //     'command',
  //     'Command Execution',
  //     messageId,
  //     conversationId
  //   );
  // }

  try {
    // ==========================================
    // STEP 1: Start & Log
    // ==========================================
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `⚙️ Starting command execution via MCP`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'execute_command',
        command: command.substring(0, 100),
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishStart({
        input: { command },
        expectedDuration: 5000,
      });
    }

    // ==========================================
    // STEP 2: Call MCP execute_command Tool
    // ==========================================
    if (publisher) {
      await publisher.publishProgress(`Executing command via MCP...`, {
        progress: 30,
        data: { command: command.substring(0, 100) },
      });
    }

    const commandResult = await redInstance.callMcpTool('execute_command', {
      command: command
    }, {
      conversationId,
      generationId,
      messageId
    });

    // Check for errors
    if (commandResult.isError) {
      const errorText = commandResult.content[0]?.text || 'Command execution failed';
      
      await redInstance.logger.log({
        level: 'warn',
        category: 'tool',
        message: `🛡️ Command failed: ${errorText.substring(0, 200)}`,
        conversationId,
        generationId,
        metadata: { 
          command,
          error: errorText
        },
      });

      if (publisher) {
        await publisher.publishError(errorText);
      }

      return {
        messages: [
          new SystemMessage(
            `[INTERNAL CONTEXT]\n` +
            `Command execution failed: ${errorText}\n` +
            `Inform the user.`
          )
        ],
        nextGraph: 'chat',
      };
    }

    const resultText = commandResult.content[0]?.text || 'Command completed with no output';
    const duration = Date.now() - startTime;

    await redInstance.logger.log({
      level: 'success',
      category: 'tool',
      message: `✓ Command completed via MCP in ${(duration / 1000).toFixed(1)}s`,
      conversationId,
      generationId,
      metadata: { 
        command,
        duration,
        resultLength: resultText.length,
        protocol: 'MCP/JSON-RPC 2.0'
      },
    });

    if (publisher) {
      await publisher.publishComplete({
        result: resultText,
        metadata: {
          duration,
          resultLength: resultText.length,
          protocol: 'MCP',
        },
      });
    }

    // ==========================================
    // STEP 3: Build Context with Command Result
    // ==========================================
    const messages: any[] = [];
    
    // Add system message
    const systemMessage = `${getNodeSystemPrefix(currentNodeNumber, 'Command')}

CRITICAL RULES:
1. Use the command execution result to answer the user's query
2. Be direct, helpful, and conversational`;

    messages.push({ role: 'system', content: systemMessage });
    
    // Use pre-loaded context from router (no need to load again)
    if (state.contextMessages && state.contextMessages.length > 0) {
      // Filter out current user message
      const userQuery = state.query?.message || command;
      const filteredMessages = state.contextMessages.filter((msg: any) => 
        !(msg.role === 'user' && msg.content === userQuery)
      );
      
      messages.push(...filteredMessages);
    }
    
    // Add user query with command result in brackets
    const userQuery = state.query?.message || command;
    const userQueryWithResult = `${userQuery}\n\n[Command Result: ${resultText}]`;
    messages.push({
      role: 'user',
      content: userQueryWithResult
    });

    return {
      messages,
      nextGraph: 'responder',
      nodeNumber: nextNodeNumber
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const duration = Date.now() - startTime;
    
    await redInstance.logger.log({
      level: 'error',
      category: 'tool',
      message: `✗ Command execution failed: ${errorMessage}`,
      conversationId,
      generationId,
      metadata: { 
        error: errorMessage,
        duration,
        command 
      },
    });

    if (publisher) {
      await publisher.publishError(errorMessage);
    }

    return {
      messages: [
        {
          role: 'system',
          content: `You are Red, an AI assistant. Command execution failed: ${errorMessage}. Inform the user and offer alternative solutions.`
        },
        {
          role: 'user',
          content: state.query?.message || command
        }
      ],
      nextGraph: 'responder',
      nodeNumber: nextNodeNumber
    };
  }
}
