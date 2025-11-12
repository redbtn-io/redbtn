
import { Red } from '../..';
import type { PlanStep } from './planner';

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
export const executorNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const executionPlan = state.executionPlan;
  const currentStepIndex = state.currentStepIndex || 0;
  
  // Safety check
  if (!executionPlan || !executionPlan.steps || executionPlan.steps.length === 0) {
    await redInstance.logger.log({
      level: 'error',
      category: 'executor',
      message: '<red>❌ No execution plan found, falling back to responder</red>',
      generationId,
      conversationId,
    });
    
    return {
      nextGraph: 'responder'
    };
  }
  
  // Check if we're past the end of the plan
  if (currentStepIndex >= executionPlan.steps.length) {
    await redInstance.logger.log({
      level: 'warn',
      category: 'executor',
      message: `<yellow>⚠ Step index ${currentStepIndex} exceeds plan length ${executionPlan.steps.length}, ending</yellow>`,
      generationId,
      conversationId,
    });
    
    return {
      nextGraph: undefined  // Will trigger END
    };
  }
  
  const currentStep: PlanStep = executionPlan.steps[currentStepIndex];
  
  await redInstance.logger.log({
    level: 'info',
    category: 'executor',
    message: `<cyan>▶️  Executing step ${currentStepIndex + 1}/${executionPlan.steps.length}:</cyan> <bold>${currentStep.type.toUpperCase()}</bold> - ${currentStep.purpose}`,
    generationId,
    conversationId,
  });
  
  // Route to appropriate node based on step type
  switch (currentStep.type) {
    case 'search':
      // Store search query in toolParam for search node to use
      return {
        nextGraph: 'search',
        toolParam: currentStep.searchQuery
      };
    
    case 'command':
      // Store command details in state for command node
      return {
        nextGraph: 'command',
        commandDomain: currentStep.domain,
        commandDetails: currentStep.commandDetails
      };
    
    case 'respond':
      // Final step - generate response
      return {
        nextGraph: 'responder'
      };
    
    default:
      await redInstance.logger.log({
        level: 'error',
        category: 'executor',
        message: `<red>❌ Unknown step type: ${(currentStep as any).type}</red>`,
        generationId,
        conversationId,
      });
      
      // Fallback to responder
      return {
        nextGraph: 'responder'
      };
  }
};
