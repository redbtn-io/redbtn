/**
 * Command Execution Node
 * 
 * Executes shell commands with detailed progress events:
 * 1. Validates command for security
 * 2. Executes in bash shell
 * 3. Streams output in real-time
 * 4. Returns result for chat node
 */

import { SystemMessage } from '@langchain/core/messages';
import type { Red } from '../../..';
import { createIntegratedPublisher } from '../../events/integrated-publisher';
import { validateCommand, SecurityError } from './security';
import { executeCommand } from './executor';

interface CommandNodeState {
  query: { message: string };
  redInstance: Red;
  options?: {
    conversationId?: string;
    generationId?: string;
  };
  messageId?: string;
  toolParam?: string; // Command to execute
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
  
  // Get command from toolParam or query
  const command = state.toolParam || state.query?.message || '';
  const timeout = 30000; // 30 seconds

  // Create event publisher for real-time updates
  let publisher: any = null;
  if (redInstance?.messageQueue && messageId && conversationId) {
    publisher = createIntegratedPublisher(
      redInstance.messageQueue,
      'code_execution', // Using code_execution type for commands
      'Command Execution',
      messageId,
      conversationId
    );
  }

  try {
    // ==========================================
    // STEP 1: Start & Log
    // ==========================================
    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `⚙️ Starting command execution`,
      conversationId,
      generationId,
      metadata: { 
        toolName: 'send_command',
        command: command.substring(0, 100) 
      },
    });

    if (publisher) {
      await publisher.publishStart({
        input: { command, timeout },
        expectedDuration: 5000, // Most commands finish quickly
      });
    }

    // ==========================================
    // STEP 2: Security Validation
    // ==========================================
    if (publisher) {
      await publisher.publishProgress('Validating command security...', { progress: 10 });
    }

    try {
      validateCommand(command);
    } catch (error) {
      if (error instanceof SecurityError) {
        await redInstance.logger.log({
          level: 'warn',
          category: 'tool',
          message: `🛡️ Command blocked: ${error.message}`,
          conversationId,
          generationId,
          metadata: { 
            command,
            reason: error.message 
          },
        });

        if (publisher) {
          await publisher.publishError({
            error: `Security validation failed: ${error.message}`,
          });
        }

        return {
          messages: [
            new SystemMessage(
              `[INTERNAL CONTEXT]\n` +
              `Command blocked for security: ${error.message}\n` +
              `Inform the user this command cannot be executed for safety reasons.`
            )
          ],
          nextGraph: 'chat',
        };
      }
      throw error;
    }

    await redInstance.logger.log({
      level: 'info',
      category: 'tool',
      message: `✓ Security validation passed`,
      conversationId,
      generationId,
    });

    // ==========================================
    // STEP 3: Execute Command
    // ==========================================
    if (publisher) {
      await publisher.publishProgress(`Executing: ${command.substring(0, 60)}${command.length > 60 ? '...' : ''}`, {
        progress: 30,
        data: { command: command.substring(0, 100) },
      });
    }

    const result = await executeCommand(
      command,
      timeout,
      (output) => {
        // Stream output in real-time
        if (publisher && output) {
          publisher.publishProgress('Receiving output...', {
            progress: 60,
            streamingContent: output.substring(0, 500), // First 500 chars
          });
        }
      }
    );

    const duration = Date.now() - startTime;

    // ==========================================
    // STEP 4: Process Results
    // ==========================================
    if (result.timedOut) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'tool',
        message: `⏱️ Command timeout after ${timeout}ms`,
        conversationId,
        generationId,
        metadata: { 
          command,
          timeout,
          duration 
        },
      });

      if (publisher) {
        await publisher.publishError({
          error: `Command timeout after ${timeout}ms`,
        });
      }

      return {
        messages: [
          new SystemMessage(
            `[INTERNAL CONTEXT]\n` +
            `Command timed out after ${timeout}ms\n` +
            `Partial output: ${result.stdout}\n` +
            `Inform the user the command took too long.`
          )
        ],
        nextGraph: 'chat',
      };
    }

    if (result.exitCode !== 0) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'tool',
        message: `⚠️ Command failed with exit code ${result.exitCode}`,
        conversationId,
        generationId,
        metadata: { 
          command,
          exitCode: result.exitCode,
          stderr: result.stderr.substring(0, 200),
          duration 
        },
      });
    } else {
      await redInstance.logger.log({
        level: 'success',
        category: 'tool',
        message: `✓ Command completed successfully in ${(duration / 1000).toFixed(1)}s`,
        conversationId,
        generationId,
        metadata: { 
          command,
          duration,
          outputLength: result.stdout.length 
        },
      });
    }

    if (publisher) {
      await publisher.publishComplete({
        result: result.stdout || result.stderr || 'Command completed with no output',
        metadata: {
          duration,
          exitCode: result.exitCode,
          stdoutLength: result.stdout.length,
          stderrLength: result.stderr.length,
          outputTruncated: result.outputTruncated,
        },
      });
    }

    // ==========================================
    // STEP 5: Return Result for Chat
    // ==========================================
    const contextParts = [
      `[INTERNAL CONTEXT - User cannot see this]`,
      `Command executed: ${command}`,
      `Exit code: ${result.exitCode}`,
      result.stdout ? `\nOutput:\n${result.stdout}` : '',
      result.stderr ? `\nErrors:\n${result.stderr}` : '',
      result.outputTruncated ? '\n[Output was truncated due to length]' : '',
      `\nUse this information to respond to the user.`,
    ].filter(Boolean);

    return {
      messages: [new SystemMessage(contextParts.join('\n'))],
      nextGraph: 'chat',
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
      await publisher.publishError({
        error: errorMessage,
      });
    }

    return {
      messages: [
        new SystemMessage(
          `[INTERNAL CONTEXT]\n` +
          `Command execution failed: ${errorMessage}\n` +
          `Inform the user and offer alternative solutions.`
        )
      ],
      nextGraph: 'chat',
    };
  }
}
