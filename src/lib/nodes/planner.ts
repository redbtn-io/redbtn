
import { Red } from '../..';
import { invokeWithRetry } from '../utils/retry';
import { getNodeSystemPrefix } from '../utils/node-helpers';
import { extractJSON } from '../utils/json-extractor';

/**
 * Execution plan step types
 */
export type StepType = 'search' | 'command' | 'respond';

/**
 * A single step in the execution plan
 */
export interface PlanStep {
  type: StepType;
  purpose: string;  // Why this step is needed
  
  // Search-specific fields
  searchQuery?: string;
  
  // Command-specific fields
  domain?: 'system' | 'api' | 'home';
  commandDetails?: string;
}

/**
 * Complete execution plan returned by planner
 */
export interface ExecutionPlan {
  reasoning: string;  // Overall strategy
  steps: PlanStep[];  // Ordered sequence of steps
}

function normalizeExecutionPlan(raw: any): ExecutionPlan | null {
  if (!raw) return null;

  let candidate: any = raw;

  // Unwrap known wrappers
  const unwrap = (value: any): any => {
    if (!value || typeof value !== 'object') return value;
    if ('plan' in value) return (value as any).plan;
    if ('executionPlan' in value) return (value as any).executionPlan;
    if ('data' in value) return (value as any).data;
    if ('response' in value) return (value as any).response;
    return value;
  };

  candidate = unwrap(candidate);

  // Handle arrays (take first element)
  if (Array.isArray(candidate)) {
    candidate = candidate[0];
  }

  // Handle string response (extract JSON)
  if (typeof candidate === 'string') {
    const parsed = extractJSON(candidate);
    if (!parsed) {
      return null;
    }
    candidate = parsed;
  }

  candidate = unwrap(candidate);

  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const rawSteps = (candidate as any).steps || (candidate as any).plan || (candidate as any).planSteps;
  if (!Array.isArray(rawSteps)) {
    return null;
  }

  const normalizeStepType = (value: string | undefined): StepType => {
    const normalized = (value || '').toLowerCase();
    if (normalized.includes('search')) return 'search';
    if (normalized.includes('command') || normalized.includes('action')) return 'command';
    return 'respond';
  };

  const steps: PlanStep[] = rawSteps
    .map((step: any, index: number) => {
      if (!step || typeof step !== 'object') {
        return null;
      }
      const type = normalizeStepType(step.type || step.action || step.step);
      const purpose = step.purpose || step.reason || step.description || `Step ${index + 1}`;
      const normalizedStep: PlanStep = {
        type,
        purpose,
      };
      if (type === 'search') {
        normalizedStep.searchQuery = step.searchQuery || step.query || step.prompt;
      }
      if (type === 'command') {
        normalizedStep.domain = step.domain;
        normalizedStep.commandDetails = step.commandDetails || step.details || step.command;
      }
      return normalizedStep;
    })
    .filter((step): step is PlanStep => step !== null);

  if (!steps.length) {
    return null;
  }

  const reasoning = (candidate as any).reasoning || (candidate as any).planReasoning || (candidate as any).strategy || 'No reasoning provided';

  return {
    reasoning,
    steps
  };
}

/**
 * JSON schema for planning decisions (structured output)
 */
const planningDecisionSchema = {
  type: 'object',
  properties: {
    reasoning: {
      type: 'string',
      description: 'Overall strategy: why this sequence of steps will resolve the user query'
    },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['search', 'command', 'respond'],
            description: 'Type of step to execute'
          },
          purpose: {
            type: 'string',
            description: 'Why this specific step is needed in the sequence'
          },
          searchQuery: {
            type: 'string',
            description: 'For search steps: optimized search query with date context for time-sensitive queries'
          },
          domain: {
            type: 'string',
            enum: ['system', 'api', 'home'],
            description: 'For command steps: which domain the command belongs to'
          },
          commandDetails: {
            type: 'string',
            description: 'For command steps: specific command details, parameters, or context'
          }
        },
        required: ['type', 'purpose']
      },
      minItems: 1,
      description: 'Ordered sequence of steps. Must end with respond step.'
    }
  },
  required: ['reasoning', 'steps'],
  additionalProperties: false
} as const;

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
export const plannerNode = async (state: any) => {
  const query = state.messages[state.messages.length - 1]?.content || state.query?.message || '';
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId;
  const currentNodeNumber = state.nodeNumber || 1; // Planner is node 1
  const nextNodeNumber = currentNodeNumber + 1;
  
  // Check if this is a replanning request
  const isReplanning = state.requestReplan === true;
  const replanReason = state.replanReason || '';
  const replannedCount = state.replannedCount || 0;
  
  if (isReplanning) {
    await redInstance.logger.log({
      level: 'info',
      category: 'planner',
      message: `<yellow>🔄 Re-planning (attempt ${replannedCount + 1}/3):</yellow> ${replanReason}`,
      generationId,
      conversationId,
    });
  }
  
  // Publish planning status to frontend
  if (messageId) {
    await redInstance.messageQueue.publishStatus(messageId, {
      action: 'planning',
      description: isReplanning ? 'Re-planning approach' : 'Planning execution steps'
    });
  }
  
  // Log planner start
  await redInstance.logger.log({
    level: 'info',
    category: 'planner',
    message: `<cyan>🗺️  Planning execution:</cyan> <dim>${query.substring(0, 80)}${query.length > 80 ? '...' : ''}</dim>`,
    generationId,
    conversationId,
  });
  
  const contextSummary = state.contextSummary || '';
  const contextPreface = contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : '';
  
  try {
    const currentDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    // Build replanning context if applicable
    let replanContext = '';
    if (isReplanning) {
      replanContext = `

REPLANNING CONTEXT:
This is replanning attempt ${replannedCount + 1}/3.
Reason for replanning: ${replanReason}
Previous execution results are in the conversation history.
Create a NEW plan that addresses the issue.`;
    }
    
    // Use structured output to force valid planning JSON
    const modelWithJson = redInstance.workerModel.withStructuredOutput({
      schema: planningDecisionSchema
    });
    
    const response = await invokeWithRetry(modelWithJson, [
      {
        role: 'system',
        content: `${getNodeSystemPrefix(currentNodeNumber, 'Planner')}

Your job is to analyze the user's query and create an EXECUTION PLAN - an ordered sequence of steps to resolve it.

Available step types:
1. SEARCH - Web research for current/real-time information
2. COMMAND - Execute system commands, API calls, or smart home control
3. RESPOND - Generate final answer to user (MUST be the last step)

PLANNING RULES:
✅ Simple queries → [{ type: 'respond', purpose: '...' }]
✅ Need current data → [{ type: 'search', ... }, { type: 'respond', ... }]
✅ Need to execute action → [{ type: 'command', ... }, { type: 'respond', ... }]
✅ Complex tasks → [{ type: 'search', ... }, { type: 'command', ... }, { type: 'respond', ... }]
✅ MUST end with 'respond' step
✅ Include 'purpose' for each step explaining why it's needed

WHEN TO USE SEARCH:
- Current events, breaking news, sports scores, weather
- Time-sensitive queries ("today", "tonight", "latest", "current")
- Stock prices, cryptocurrency, real-time data
- User explicitly asks to "search" or "look up"
- You don't have the information in your training data

WHEN TO USE COMMAND:
- System: File operations, shell commands, local tasks
- API: External services, webhooks, third-party integrations
- Home: Smart home devices, IoT control, automation

WHEN TO USE RESPOND ONLY:
- Greetings, casual conversation
- Explanations of concepts you know
- Historical facts, established knowledge
- Math, logic problems
- Questions about yourself

SEARCH STEP REQUIREMENTS:
- Must include 'searchQuery' field with optimized search terms
- Include date context for time-sensitive queries
- Example: "Chiefs tonight?" → searchQuery: "Kansas City Chiefs game score November 11 2025"

COMMAND STEP REQUIREMENTS:
- Must include 'domain' field: 'system', 'api', or 'home'
- Must include 'commandDetails' with specific context

Current date: ${currentDate}${replanContext}

CRITICAL: Every plan MUST end with a 'respond' step. This is not optional.`
      },
      {
        role: 'user',
  content: `${contextPreface}User query: ${query}`
      }
    ], { context: 'planner decision' });
    
    // Parse and validate the plan
    let executionPlan: ExecutionPlan;
    
    const normalizedPlan = normalizeExecutionPlan(response);
    if (!normalizedPlan) {
      throw new Error(`Invalid planning response format: ${JSON.stringify(response)}`);
    }
    executionPlan = normalizedPlan;
    
    // Validate plan has steps
    if (!executionPlan.steps || executionPlan.steps.length === 0) {
      throw new Error('Plan must contain at least one step');
    }
    
    // Validate plan ends with respond
    const lastStep = executionPlan.steps[executionPlan.steps.length - 1];
    if (lastStep.type !== 'respond') {
      // Auto-fix: add respond step if missing
      executionPlan.steps.push({
        type: 'respond',
        purpose: 'Provide final answer to user'
      });
      
      await redInstance.logger.log({
        level: 'warn',
        category: 'planner',
        message: '<yellow>⚠ Plan missing respond step, auto-added</yellow>',
        generationId,
        conversationId,
      });
    }
    
    // Log the execution plan
    const stepsList = executionPlan.steps
      .map((step, i) => {
        let details = '';
        if (step.type === 'search' && step.searchQuery) {
          details = ` → "${step.searchQuery}"`;
        } else if (step.type === 'command' && step.domain) {
          details = ` → ${step.domain}`;
        }
        return `  ${i + 1}. ${step.type.toUpperCase()}${details} - ${step.purpose}`;
      })
      .join('\n');
    
    await redInstance.logger.log({
      level: 'info',
      category: 'planner',
      message: `<green>📋 Execution Plan (${executionPlan.steps.length} steps):</green>\n<dim>${stepsList}</dim>\n<cyan>Strategy:</cyan> <dim>${executionPlan.reasoning}</dim>`,
      generationId,
      conversationId,
    });
    
    // Store plan in database for debugging
    await redInstance.logger.log({
      level: 'debug',
      category: 'planner',
      message: 'Full execution plan',
      generationId,
      conversationId,
      metadata: {
        plan: executionPlan,
        replannedCount
      }
    });
    
    return {
      executionPlan,
      currentStepIndex: 0,  // Start at first step
      nodeNumber: nextNodeNumber,
      requestReplan: false,  // Clear replan flag
      replanReason: undefined,
      replannedCount: isReplanning ? replannedCount + 1 : replannedCount
    };
    
  } catch (error) {
    await redInstance.logger.log({
      level: 'error',
      category: 'planner',
      message: `<red>❌ Planning failed:</red> ${error instanceof Error ? error.message : String(error)}`,
      generationId,
      conversationId,
    });
    
    // Fallback: create simple respond-only plan
    return {
      executionPlan: {
        reasoning: 'Fallback plan due to planning error',
        steps: [{
          type: 'respond' as const,
          purpose: 'Provide direct answer'
        }]
      },
      currentStepIndex: 0,
      nodeNumber: nextNodeNumber,
      requestReplan: false,
      replanReason: undefined
    };
  }
};
