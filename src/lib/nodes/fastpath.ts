import { Red } from '../..';

/**
 * Fast Path Command Executor
 * 
 * Executes pattern-matched commands directly without LLM intervention.
 * This is the ultra-fast path for unambiguous voice commands.
 * 
 * Flow:
 * 1. Receive command details from precheck (tool, server, parameters)
 * 2. Call the MCP tool directly
 * 3. Return result for tiny confirmer
 */

export const fastpathExecutorNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  
  const tool = state.fastpathTool;
  const server = state.fastpathServer;
  const parameters = state.fastpathParameters;
  
  if (!tool || !server) {
    await redInstance.logger.log({
      level: 'error',
      category: 'fastpath',
      message: '❌ No tool/server specified for fast path execution',
      conversationId,
      generationId
    });
    
    return {
      fastpathSuccess: false,
      fastpathError: 'Missing tool or server information'
    };
  }
  
  await redInstance.logger.log({
    level: 'info',
    category: 'fastpath',
    message: `⚡ Executing ${server}.${tool}`,
    conversationId,
    generationId,
    metadata: { tool, server, parameters }
  });
  
  try {
    // Call the MCP tool directly (registry will find the right server)
    const result = await redInstance.mcpRegistry.callTool(
      tool,
      parameters,
      { conversationId, generationId }
    );
    
    // Parse result
    const resultText = result.content[0]?.text || '';
    let resultData: any;
    
    try {
      resultData = JSON.parse(resultText);
    } catch {
      resultData = { success: true, message: resultText };
    }
    
    await redInstance.logger.log({
      level: 'info',
      category: 'fastpath',
      message: `✅ Command executed: ${resultData.message || 'Success'}`,
      conversationId,
      generationId,
      metadata: { result: resultData }
    });
    
    return {
      fastpathSuccess: true,
      fastpathResult: resultData,
      fastpathMessage: resultData.message || resultText
    };
    
  } catch (error) {
    await redInstance.logger.log({
      level: 'error',
      category: 'fastpath',
      message: `❌ Command execution failed: ${error}`,
      conversationId,
      generationId,
      metadata: { error: String(error) }
    });
    
    return {
      fastpathSuccess: false,
      fastpathError: String(error)
    };
  }
};

/**
 * Tiny Confirmer Node
 * 
 * Uses a tiny local model (or simple templates) to generate a brief
 * confirmation message for the user. Think "✓ Lights off" not a paragraph.
 * 
 * For now, we'll just use simple templates. Later we can add a tiny model.
 */

export const tinyConfirmerNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  
  const success = state.fastpathSuccess;
  const result = state.fastpathResult;
  const error = state.fastpathError;
  const parameters = state.fastpathParameters;
  
  let confirmationMessage: string;
  
  if (!success) {
    // Error case
    confirmationMessage = error
      ? `Sorry, I couldn't complete that: ${error}`
      : 'Sorry, something went wrong.';
      
    await redInstance.logger.log({
      level: 'warn',
      category: 'fastpath',
      message: `⚠️ Command failed: ${confirmationMessage}`,
      conversationId,
      generationId
    });
    
  } else {
    // Success case - use result message or build one
    if (result && result.message) {
      confirmationMessage = `✓ ${result.message}`;
    } else {
      // Fallback: build simple confirmation from parameters
      confirmationMessage = '✓ Done';
    }
    
    await redInstance.logger.log({
      level: 'info',
      category: 'fastpath',
      message: `✅ Confirmation: ${confirmationMessage}`,
      conversationId,
      generationId
    });
  }
  
  // Return as final message
  return {
    messages: [
      ...state.messages,
      {
        role: 'assistant',
        content: confirmationMessage
      }
    ],
    fastpathComplete: true
  };
};
