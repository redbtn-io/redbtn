import { ChatOpenAI } from '@langchain/openai';
import { Red } from '../..';
import { extractJSON } from '../utils/json-extractor';
import { getNodeSystemPrefix } from '../utils/node-helpers';

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
    message: `🤔 Classifier: Routing query...`,
    conversationId,
    generationId,
    metadata: { query: userQuery.substring(0, 100) }
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

DIRECT (can answer with knowledge alone):
- Greetings and casual conversation: "hi", "hello", "hey", "how are you", "yo"
- Knowledge questions you can answer: "what is X?", "explain Y", "how does Z work?"
- Definitions, concepts, explanations from your training
- Simple math and logic: "what's 5+5?", "which is larger?"
- Code examples and technical explanations
- General advice and recommendations
- Answering questions about yourself

PLAN (need external tools/data):
- Explicit search requests: "search for X", "look up Y", "find Z"
- Current/real-time information: "latest news", "today's weather", "current price"
- Time-sensitive queries: "who won tonight?", "what happened today?"
- External state: "check my calendar", "what's in my inbox"
- Commands/actions: "turn on lights", "send message", "run script"
- Multi-step workflows: "research X and summarize"
- Questions about things after your knowledge cutoff

IMPORTANT:
- Default to DIRECT unless you genuinely need tools/external data
- Only choose PLAN if you can't answer with your existing knowledge
- "I don't know" is acceptable for DIRECT - you don't need planning for uncertainty
- When uncertain about which to choose, ask yourself: "Do I need a tool to answer this?"

Respond with JSON:
{
  "decision": "direct" | "plan",
  "confidence": 0.0-1.0,
  "reasoning": "One sentence explaining your decision"
}`;

  try {
    // Use fast worker model for classification
    const model = redInstance.workerModel;
    
    // Get node number from state or default to 1 (classifier is typically first after precheck)
    const nodeNumber = state.nodeNumber || 1;
    
    const systemMessage = `${getNodeSystemPrefix(nodeNumber, 'Classifier')}

You are a query classifier. Your job is to route queries to either DIRECT response or PLANNING.
Respond only with valid JSON.`;
    
    const response = await model.invoke([
      { role: 'system', content: systemMessage },
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
    
    // Log low confidence but still use the decision (LLM knows best)
    if (decision.confidence < 0.6) {
      await redInstance.logger.log({
        level: 'warn',
        category: 'classifier',
        message: `⚠️ Low confidence (${decision.confidence}) but proceeding with: ${decision.decision.toUpperCase()}`,
        conversationId,
        generationId
      });
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
