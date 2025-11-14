
import { InvokeOptions, Red } from '../..';
import { extractThinking, logThinking } from '../utils/thinking';
import { extractJSONWithDetails } from '../utils/json-extractor';
import { invokeWithRetry } from '../utils/retry';
import { getNodeSystemPrefix } from '../utils/node-helpers';

/**
 * JSON schema for routing decisions (structured output)
 * Multi-path confidence scoring: evaluate all three options simultaneously
 */
const routingDecisionSchema = {
  type: 'object',
  properties: {
    research: {
      type: 'object',
      properties: {
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0-1 that this query needs web research/search'
        },
        reasoning: {
          type: 'string',
          description: 'Why research would or would not help answer this query'
        },
        query: {
          type: 'string',
          description: 'Optimized search query if research is needed. Include date context for time-sensitive queries (e.g., "Chiefs game November 9 2025" not "tonight")'
        }
      },
      required: ['confidence', 'reasoning']
    },
    command: {
      type: 'object',
      properties: {
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0-1 that this query needs command execution across various domains'
        },
        reasoning: {
          type: 'string',
          description: 'Why a command would or would not be appropriate'
        },
        domain: {
          type: 'string',
          enum: ['system', 'api', 'home'],
          description: 'Command domain: system (file ops, shell commands), api (external services, webhooks), home (smart home, IoT devices)'
        },
        details: {
          type: 'string',
          description: 'Specific command details, parameters, or context needed'
        }
      },
      required: ['confidence', 'reasoning']
    },
    respond: {
      type: 'object',
      properties: {
        confidence: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: 'Confidence 0-1 that this can be answered directly using existing knowledge without external tools'
        },
        reasoning: {
          type: 'string',
          description: 'Why a direct response would or would not be sufficient'
        }
      },
      required: ['confidence', 'reasoning']
    }
  },
  required: ['research', 'command', 'respond'],
  additionalProperties: false
} as const;

interface RoutingDecision {
  research: {
    confidence: number;
    reasoning: string;
    query?: string;
  };
  command: {
    confidence: number;
    reasoning: string;
    domain?: 'system' | 'api' | 'home';
    details?: string;
  };
  respond: {
    confidence: number;
    reasoning: string;
  };
}

/**
 * The first node in redGraph, acting as an intelligent router.
 * Analyzes the user query with conversation context to determine the next action:
 * - web_search: Query needs current information from the internet
 * - scrape_url: User provided a specific URL to scrape
 * - system_command: User wants to execute a system command
 * - respond: Query can be answered directly without external tools
 * 
 * Uses structured outputs with Zod schema for reliable routing decisions.
 * 
 * @param state The current state of the graph.
 * @returns A partial state object indicating the next step.
 */

/**
 * Normalize and validate routing decision response
 * Handles various quirky LLM output formats and fills in missing fields
 */
function normalizeRoutingDecision(raw: any): RoutingDecision {
  // Step 1: Normalize keys to lowercase
  const normalizeKeys = (obj: any): any => {
    if (typeof obj !== 'object' || obj === null) return obj;
    const result: any = {};
    for (const key in obj) {
      const lowerKey = key.toLowerCase();
      result[lowerKey] = typeof obj[key] === 'object' && obj[key] !== null 
        ? normalizeKeys(obj[key]) 
        : obj[key];
    }
    return result;
  };
  
  const normalized = normalizeKeys(raw);
  
  // Step 2: Extract/validate each path
  const research = normalized.research || {};
  const command = normalized.command || {};
  const respond = normalized.respond || {};
  
  // Step 3: Build complete structure with defaults
  const result: RoutingDecision = {
    research: {
      confidence: typeof research.confidence === 'number' ? research.confidence : 0,
      reasoning: research.reasoning || 'No reasoning provided',
      query: research.query || ''
    },
    command: {
      confidence: typeof command.confidence === 'number' ? command.confidence : 0,
      reasoning: command.reasoning || 'No reasoning provided',
      domain: command.domain || '',
      details: command.details || ''
    },
    respond: {
      confidence: typeof respond.confidence === 'number' ? respond.confidence : 0,
      reasoning: respond.reasoning || 'No reasoning provided'
    }
  };
  
  // Step 4: Validate and fix confidence scores
  // If any confidence is missing/invalid, redistribute evenly
  const allValid = [result.research.confidence, result.command.confidence, result.respond.confidence]
    .every(c => typeof c === 'number' && c >= 0 && c <= 1);
  
  if (!allValid) {
    // Set default: respond wins if we can't determine
    result.research.confidence = 0.1;
    result.command.confidence = 0.1;
    result.respond.confidence = 0.8;
  }
  
  return result;
}

export const routerNode = async (state: any) => {
  const query = state.messages[state.messages.length - 1]?.content || state.query?.message || '';
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  const messageId = state.messageId; // Get from top-level state, not options
  const currentNodeNumber = state.nodeNumber || 1; // Router is always node 1
  const nextNodeNumber = currentNodeNumber + 1; // Next nodes will be node 2, 3, etc.
  
  // Publish routing status to frontend
  if (messageId) {
    await redInstance.messageQueue.publishStatus(messageId, {
      action: 'routing',
      description: 'Analyzing query'
    });
  }
  
  // Log router start
  await redInstance.logger.log({
    level: 'info',
    category: 'router',
    message: `<cyan>🧭 Analyzing query:</cyan> <dim>${query.substring(0, 80)}${query.length > 80 ? '...' : ''}</dim>`,
    generationId,
    conversationId,
  });
  
  const conversationMessages: any[] = state.contextMessages || [];
  const contextSummary = state.contextSummary || '';
  const contextPreface = contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : '';
  
  try {
    const currentDate = new Date().toLocaleDateString('en-US', { 
      weekday: 'long', 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    // Force JSON output from Ollama models
    const modelWithJsonFormat = redInstance.workerModel.withStructuredOutput({
      schema: routingDecisionSchema
    });
    const response = await invokeWithRetry(modelWithJsonFormat, [
      {
        role: 'system',
        content: `${getNodeSystemPrefix(currentNodeNumber, 'Router')}

Your job is to analyze the user's message and evaluate ALL THREE routing options simultaneously with confidence scores AND reasoning.

You must return for EACH of the three paths:
- confidence: A score from 0.0 to 1.0
- reasoning: A brief explanation (1-2 sentences) of WHY you gave that confidence score

1. RESEARCH (Web Search):
   - High confidence (0.8-1.0): Current events, breaking news, sports scores, weather, stock prices, "search for X", time-sensitive data
   - Medium confidence (0.5-0.7): Could benefit from recent info but not critical
   - Low confidence (0.0-0.4): Historical facts, general knowledge, doesn't need web data
   - MUST provide 'query' field with optimized search terms including dates for time-sensitive queries
   - Example: "Did Chiefs win tonight?" → query: "Chiefs game score November 9 2025"
   - reasoning example: "User is asking about today's sports game which requires real-time data I don't have"

2. COMMAND (System/API/Home):
   - High confidence (0.8-1.0): Clear command intent - system operations, API calls, smart home control
   - Medium confidence (0.5-0.7): Might need command execution or external integrations
   - Low confidence (0.0-0.4): No command/action context
   - If confidence > 0.5, must specify 'domain' (system/api/home) and 'details'
   - Domains:
     * system: File operations, shell commands, local system tasks
     * api: External services, webhooks, third-party integrations
     * home: Smart home devices, IoT control, home automation
   - reasoning example: "No system commands or actions are being requested"

3. RESPOND (Direct Answer):
   - High confidence (0.8-1.0): Can answer directly using existing knowledge - greetings, explanations, factual questions, conceptual discussions
   - Medium confidence (0.5-0.7): Could answer directly but might benefit from external data for accuracy or completeness
   - Low confidence (0.0-0.4): Definitely needs external tools or current data
   - reasoning example: "This is a conceptual question about established knowledge that doesn't require real-time data"

CRITICAL ROUTING RULES:
- If you DON'T have real-time/current data → research confidence MUST be HIGH (0.8+)
- If query asks about "today", "tonight", "current", "latest" → research confidence MUST be HIGH (0.8+)
- The path with HIGHEST confidence wins
- In a tie: research > command > respond (priority order)
- Be honest - all three scores should reflect actual confidence, they don't need to sum to 1.0
- ALWAYS provide reasoning for each path - explain your confidence score`
      },
      {
        role: 'user',
  content: `${contextPreface}User message: ${query}`
      }
    ], { context: 'router decision' });
    
    // With structured output, response is already parsed
    let routingDecision: RoutingDecision;
    
    // Check if response is already an object (structured output) or needs parsing
    if (typeof response === 'object' && response !== null) {
      // Check if it's the new multi-path format (handle both lowercase and uppercase keys)
      const hasLowercase = 'research' in response && 'command' in response && 'respond' in response;
      const hasUppercase = 'RESEARCH' in response && 'COMMAND' in response && 'RESPOND' in response;
      
      if (hasLowercase || hasUppercase) {
        // Log raw response for debugging
        await redInstance.logger.log({
          level: 'debug',
          category: 'router',
          message: `<cyan>📋 Raw routing response before normalization</cyan>`,
          generationId,
          conversationId,
          metadata: { 
            rawResponse: response,
            hasUppercase,
            hasLowercase
          },
        });
        
        // Normalize and validate the response
        routingDecision = normalizeRoutingDecision(response);
        
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>✓ Multi-path routing decision received</green>`,
          generationId,
          conversationId,
          metadata: { 
            decision: routingDecision,
            method: 'structured_output',
            keysNormalized: hasUppercase,
            scores: {
              research: routingDecision.research.confidence,
              command: routingDecision.command.confidence,
              chat: routingDecision.respond.confidence
            }
          },
        });
        
      } else {
        // Unknown object format, try to extract
        throw new Error(`Unknown response format - expected research/command/respond structure: ${JSON.stringify(response)}`);
      }
      
    } else {
      // Check if response has direct text content
      // Check top-level: response/text/content/message
      let directText = (response as any)?.response || 
                       (response as any)?.text || 
                       (response as any)?.content ||
                       (response as any)?.message;
      
      // Check nested in 'response' property
      if (!directText && (response as any)?.response && typeof (response as any).response === 'object') {
        const resp = (response as any).response;
        directText = resp.response || resp.text || resp.content || resp.message;
      }
      
      // Check nested in 'arguments' property
      if (!directText && (response as any)?.arguments) {
        const args = (response as any).arguments;
        directText = args.response || args.text || args.content || args.message;
      }
      
      // Check nested in 'data' property
      if (!directText && (response as any)?.data) {
        const data = (response as any).data;
        directText = data.response || data.text || data.content || data.message;
      }
      
      if (typeof directText === 'string' && directText.trim().length > 0) {
        // Response contains direct text - stream it and skip to responder
        await redInstance.logger.log({
          level: 'info',
          category: 'router',
          message: `<cyan>📋 Router received text response, passing through</cyan>`,
          generationId,
          conversationId,
          metadata: { 
            hasDirectText: true,
            textLength: directText.length
          },
        });
        
        // Store the direct response in state so responder can stream it
        return { 
          nextGraph: 'responder',
          directResponse: directText,
          contextMessages: conversationMessages,
          nodeNumber: nextNodeNumber
        };
      }
      
      // Fallback: response has content property that needs extraction
      const rawResponse = typeof response === 'string' ? response : (response as any)?.content || JSON.stringify(response);
      
      // Log the full raw response for debugging
      await redInstance.logger.log({
        level: 'info',
        category: 'router',
        message: `<cyan>📋 Raw LLM response received</cyan>`,
        generationId,
        conversationId,
        metadata: { 
          rawResponse,
          responseLength: rawResponse.length,
          responseType: typeof response
        },
      });
      
      // Try to extract JSON from the response
      const extractionResult = extractJSONWithDetails<RoutingDecision>(
        rawResponse,
        { research: undefined, command: undefined, respond: undefined } // Expected shape
      );
      
      if (extractionResult.success && extractionResult.data) {
        // Normalize and validate the extracted data
        routingDecision = normalizeRoutingDecision(extractionResult.data);
        
        // Log successful extraction with details
        await redInstance.logger.log({
          level: 'success',
          category: 'router',
          message: `<green>✓ Multi-path routing decision extracted</green> <dim>(strategy: ${extractionResult.strategy})</dim>`,
          generationId,
          conversationId,
          metadata: { 
            decision: routingDecision,
            extractionStrategy: extractionResult.strategy,
            scores: {
              research: routingDecision.research.confidence,
              command: routingDecision.command.confidence,
              chat: routingDecision.respond.confidence
            }
          },
        });
        
      } else {
        // Log failure with full details
        await redInstance.logger.log({
          level: 'error',
          category: 'router',
          message: `<red>✗ Failed to extract routing decision from response</red>`,
          generationId,
          conversationId,
          metadata: { 
            rawResponse,
            extractionError: extractionResult.error,
            attemptedStrategies: ['direct', 'braces', 'codeblock']
          },
        });
        
        throw new Error(`Failed to parse routing response: ${extractionResult.error}`);
      }
    }
    
    // Determine winner: Highest confidence wins, with tie-breaker: research > command > respond
    const scores = [
      { path: 'research', confidence: routingDecision.research.confidence, priority: 1 },
      { path: 'command', confidence: routingDecision.command.confidence, priority: 2 },
      { path: 'respond', confidence: routingDecision.respond.confidence, priority: 3 }
    ];
    
    // Sort by confidence (desc), then by priority (asc) for tie-breaking
    scores.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.priority - b.priority;
    });
    
    const winner = scores[0];
    const winnerPath = winner.path as 'research' | 'command' | 'respond';
    
    // Log all three scores with winner highlighted
    await redInstance.logger.log({
      level: 'info',
      category: 'router',
      message: `<cyan>Multi-Path Confidence Scores:</cyan>
  🔍 Research: <${winner.path === 'research' ? 'bold green' : 'dim'}>${(routingDecision.research.confidence * 100).toFixed(0)}%</> ${winner.path === 'research' ? '<green>← WINNER</green>' : ''}
     ${routingDecision.research.reasoning}
  ⚡ Command: <${winner.path === 'command' ? 'bold green' : 'dim'}>${(routingDecision.command.confidence * 100).toFixed(0)}%</> ${winner.path === 'command' ? '<green>← WINNER</green>' : ''}
     ${routingDecision.command.reasoning}
  💬 Respond: <${winner.path === 'respond' ? 'bold green' : 'dim'}>${(routingDecision.respond.confidence * 100).toFixed(0)}%</> ${winner.path === 'respond' ? '<green>← WINNER</green>' : ''}
     ${routingDecision.respond.reasoning}`,
      generationId,
      conversationId,
      metadata: {
        winner: winnerPath,
        winnerConfidence: winner.confidence,
        allScores: {
          research: routingDecision.research.confidence,
          command: routingDecision.command.confidence,
          chat: routingDecision.respond.confidence
        },
        tieBreaker: scores[0].confidence === scores[1].confidence
      }
    });
    
    // Log all reasoning as thinking
    if (generationId && conversationId) {
      await redInstance.logger.logThought({
        content: `Router Multi-Path Analysis:\n\nResearch (${(routingDecision.research.confidence * 100).toFixed(0)}%): ${routingDecision.research.reasoning}\n\nCommand (${(routingDecision.command.confidence * 100).toFixed(0)}%): ${routingDecision.command.reasoning}\n\nRespond (${(routingDecision.respond.confidence * 100).toFixed(0)}%): ${routingDecision.respond.reasoning}\n\nDecision: ${winnerPath.toUpperCase()}`,
        source: 'router',
        generationId,
        conversationId,
      });
    }
    
    // Route based on winner
    if (winnerPath === 'research') {
      const searchQuery = routingDecision.research.query || query;
      
      // Validate search query - if missing or too vague, fall back to respond
      if (!searchQuery || searchQuery.trim().length < 3) {
        await redInstance.logger.log({
          level: 'warn',
          category: 'router',
          message: `<yellow>⚠ Research won but query is missing/invalid, falling back to CHAT</yellow>`,
          generationId,
          conversationId,
          metadata: {
            providedQuery: searchQuery,
            fallbackReason: 'invalid_query'
          }
        });
        
        if (messageId) {
          await redInstance.messageQueue.publishStatus(messageId, {
            action: 'processing',
            description: 'Generating response',
            reasoning: `[Fallback] ${routingDecision.respond.reasoning}`,
            confidence: routingDecision.respond.confidence
          });
        }
        
        return { nextGraph: 'responder', contextMessages: conversationMessages, nodeNumber: nextNodeNumber };
      }
      
      if (messageId) {
        await redInstance.messageQueue.publishToolStatus(messageId, {
          status: '🔍 Searching the web...',
          action: 'web_search',
          reasoning: routingDecision.research.reasoning,
          confidence: routingDecision.research.confidence
        });
      }

      await redInstance.logger.log({
        level: 'success',
        category: 'router',
        message: `<green>→ Route:</green> <bold>RESEARCH</bold> <dim>${searchQuery}</dim>`,
        generationId,
        conversationId,
        metadata: { 
          decision: 'RESEARCH', 
          nextGraph: 'search',
          searchQuery,
          reasoning: routingDecision.research.reasoning,
          confidence: routingDecision.research.confidence
        },
      });
      
      return { 
        nextGraph: 'search',
        toolParam: searchQuery,
        contextMessages: conversationMessages,
        nodeNumber: nextNodeNumber
      };
    }
    
    if (winnerPath === 'command') {
      const commandDomain = routingDecision.command.domain;
      const commandDetails = routingDecision.command.details || '';
      
      if (!commandDomain || !commandDetails) {
        await redInstance.logger.log({
          level: 'warn',
          category: 'router',
          message: `<yellow>⚠ Command won but missing domain/details, falling back to CHAT</yellow>`,
          generationId,
          conversationId,
          metadata: {
            providedDomain: commandDomain,
            providedDetails: commandDetails
          }
        });
        
        if (messageId) {
          await redInstance.messageQueue.publishStatus(messageId, {
            action: 'processing',
            description: 'Generating response',
            reasoning: routingDecision.respond.reasoning,
            confidence: routingDecision.respond.confidence
          });
        }
        
        return { nextGraph: 'responder', contextMessages: conversationMessages, nodeNumber: nextNodeNumber };
      }
      
      // Route to command node with domain and details
      if (messageId) {
        await redInstance.messageQueue.publishToolStatus(messageId, {
          status: `⚡ Executing ${commandDomain} command...`,
          action: 'command',
          reasoning: routingDecision.command.reasoning,
          confidence: routingDecision.command.confidence
        });
      }
      
      await redInstance.logger.log({
        level: 'success',
        category: 'router',
        message: `<green>→ Route:</green> <bold>COMMAND</bold> <dim>[${commandDomain}] ${commandDetails}</dim>`,
        generationId,
        conversationId,
        metadata: { 
          decision: 'COMMAND',
          domain: commandDomain,
          details: commandDetails,
          nextGraph: 'command',
          reasoning: routingDecision.command.reasoning,
          confidence: routingDecision.command.confidence
        },
      });
      
      return { 
        nextGraph: 'command', 
        toolParam: JSON.stringify({ domain: commandDomain, details: commandDetails }),
        contextMessages: conversationMessages,
        nodeNumber: nextNodeNumber
      };
    }
    
    // Default: respond wins (or fallback)
    if (messageId) {
      await redInstance.messageQueue.publishStatus(messageId, {
        action: 'processing',
        description: 'Generating response',
        reasoning: routingDecision.respond.reasoning,
        confidence: routingDecision.respond.confidence
      });
    }
    
    await redInstance.logger.log({
      level: 'success',
      category: 'router',
      message: `<green>→ Route:</green> <bold>CHAT</bold>`,
      generationId,
      conversationId,
      metadata: { 
        decision: 'RESPOND', 
        nextGraph: 'responder',
        reasoning: routingDecision.respond.reasoning,
        confidence: routingDecision.respond.confidence
      },
    });
    
    return { nextGraph: 'responder', contextMessages: conversationMessages, nodeNumber: nextNodeNumber };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    await redInstance.logger.log({
      level: 'error',
      category: 'router',
      message: `<red>✗ Router error:</red> ${errorMessage} <dim>(defaulting to CHAT)</dim>`,
      generationId,
      conversationId,
      metadata: { error: errorMessage },
    });
    return { nextGraph: 'responder', contextMessages: conversationMessages, nodeNumber: nextNodeNumber };
  }
};