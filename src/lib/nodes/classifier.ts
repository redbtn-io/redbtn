import { ChatOpenAI } from '@langchain/openai';
import { Red } from '../..';
import { extractJSON } from '../utils/json-extractor';

/**
 * Classifier Node - Fast local LLM for binary routing decision
 * 
 * This is Tier 1 in the three-tier architecture:
 * - Tier 0: Precheck (pattern matching, ~50ms)
 * - Tier 1: Classifier (fast local LLM, ~500ms) ← YOU ARE HERE
 * - Tier 2: Direct/Planner (full LLM response, ~3-15s)
 * 
 * The classifier makes a simple decision:
 * - DIRECT: Can answer with just my knowledge (definitions, explanations, code examples)
 * - PLAN: Need tools/actions (search, commands, multi-step reasoning)
 * 
 * Uses a fast local model (qwen2.5:3b or llama3.2:3b) for speed + cost efficiency.
 */

export interface ClassifierDecision {
  decision: 'direct' | 'plan';
  confidence: number;
  reasoning: string;
}

export const classifierNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  
  // Get user query
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];
  const userQuery = typeof lastMessage?.content === 'string' 
    ? lastMessage.content 
    : '';
  
  if (!userQuery) {
    // No query, default to planning
    return {
      routerDecision: 'plan',
      routerReason: 'No query provided'
    };
  }
  
  await redInstance.logger.log({
    level: 'info',
    category: 'classifier',
    message: `🤔 Classifying query: "${userQuery}"`,
    conversationId,
    generationId
  });
  
  // Build conversation context (last few messages for reference understanding)
  let contextSummary = '';
  if (messages.length > 2) {
    const recentMessages = messages.slice(-4, -1);  // Last 3 messages before current
    contextSummary = recentMessages.map((msg: any) => {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      const content = typeof msg.content === 'string' ? msg.content : '';
      return `${role}: ${content.substring(0, 100)}${content.length > 100 ? '...' : ''}`;
    }).join('\n');
  }
  
  const classificationPrompt = `You are a routing classifier. Your job is to decide if a query can be answered DIRECTLY with your knowledge, or if it requires external TOOLS/PLANNING.

${contextSummary ? `Recent Context:\n${contextSummary}\n\n` : ''}User Query: ${userQuery}

Classification Rules:
- DIRECT: Pure knowledge questions, explanations, definitions, code examples, reasoning, calculations
  Examples: "What is recursion?", "Explain async/await", "Write a bubble sort", "What's 25% of 80?"
  
- PLAN: Queries needing tools or multi-step actions
  Examples: "Search for X", "Who won the game Monday?", "Run tests", "Check the weather"
  
IMPORTANT:
- If uncertain, choose PLAN (conservative approach)
- "Search for X" always needs PLAN
- Time-sensitive info ("latest", "current", "today") needs PLAN
- References to external state need PLAN

Respond with JSON:
{
  "decision": "direct" | "plan",
  "confidence": 0.0-1.0,
  "reasoning": "One sentence explaining your decision"
}`;

  try {
    // Use fast worker model for classification
    const model = redInstance.workerModel;
    
    const response = await model.invoke([
      { role: 'system', content: 'You are a query classifier. Respond only with valid JSON.' },
      { role: 'user', content: classificationPrompt }
    ]);
    
    const responseText = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
    
    // Extract JSON from response
    const jsonMatch = extractJSON(responseText);
    
    if (!jsonMatch) {
      throw new Error('No valid JSON in classifier response');
    }
    
    const decision: ClassifierDecision = jsonMatch;
    
    await redInstance.logger.log({
      level: 'info',
      category: 'classifier',
      message: `📊 Decision: ${decision.decision.toUpperCase()} (confidence: ${decision.confidence})`,
      conversationId,
      generationId,
      metadata: {
        decision: decision.decision,
        confidence: decision.confidence,
        reasoning: decision.reasoning
      }
    });
    
    // If confidence is too low, default to planning
    if (decision.confidence < 0.5) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'classifier',
        message: `⚠️ Low confidence (${decision.confidence}), defaulting to PLAN`,
        conversationId,
        generationId
      });
      
      return {
        routerDecision: 'plan',
        routerReason: `Low confidence: ${decision.reasoning}`,
        routerConfidence: decision.confidence
      };
    }
    
    return {
      routerDecision: decision.decision === 'direct' ? 'direct' : 'plan',
      routerReason: decision.reasoning,
      routerConfidence: decision.confidence
    };
    
  } catch (error) {
    await redInstance.logger.log({
      level: 'error',
      category: 'classifier',
      message: `❌ Classification failed: ${error}`,
      conversationId,
      generationId,
      metadata: { error: String(error) }
    });
    
    // On error, default to planning (safer)
    return {
      routerDecision: 'plan',
      routerReason: `Classification error: ${error}`,
      routerConfidence: 0
    };
  }
};
