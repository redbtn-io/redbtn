
import { Red } from '../..';
import { invokeWithRetry } from '../utils/retry';
import { getNodeSystemPrefix } from '../utils/node-helpers';

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
  
  // Load conversation context
  let conversationMessages: any[] = [];
  let contextSummary = '';
  
  if (conversationId) {
    try {
      // Get full conversation history
      const contextResult = await redInstance.callMcpTool(
        'get_context_history',
        {
          conversationId,
          maxTokens: 30000,
          includeSummary: true,
          summaryType: 'trailing',
          format: 'llm'
        },
        {
          conversationId,
          generationId,
          messageId
        }
      );

      if (!contextResult.isError && contextResult.content?.[0]?.text) {
        const contextData = JSON.parse(contextResult.content[0].text);
        const rawMessages = contextData.messages || [];
        
        // Deduplicate by content
        const seenContent = new Set<string>();
        conversationMessages = rawMessages.filter((m: any) => {
          const key = `${m.role}:${m.content}`;
          if (seenContent.has(key)) {
            return false;
          }
          seenContent.add(key);
          return true;
        });
      }
      
      // Get executive summary
      const summaryResult = await redInstance.callMcpTool(
        'get_summary',
        {
          conversationId,
          summaryType: 'executive'
        },
        {
          conversationId,
          generationId,
          messageId
        }
      );

      if (!summaryResult.isError && summaryResult.content?.[0]?.text) {
        const summaryData = JSON.parse(summaryResult.content[0].text);
        const summary = summaryData.summary;
        if (summary) {
          contextSummary = `\n\nConversation Context: ${summary}`;
        }
      }
    } catch (error) {
      console.warn('[Planner] Failed to load context from Context MCP:', error);
    }
  }
  
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
    
    const modelWithJsonFormat = redInstance.workerModel.withStructuredOutput({
      schema: planningDecisionSchema
    });
    
    const response = await invokeWithRetry(modelWithJsonFormat, [
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
        content: `${contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : ''}User query: ${query}`
      }
    ], { context: 'planner decision' });
    
    // Parse and validate the plan
    let executionPlan: ExecutionPlan;
    
    if (typeof response === 'object' && response !== null && 'steps' in response) {
      executionPlan = response as ExecutionPlan;
    } else {
      throw new Error(`Invalid planning response format: ${JSON.stringify(response)}`);
    }
    
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
