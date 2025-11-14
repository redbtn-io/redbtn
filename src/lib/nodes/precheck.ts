import { Red } from '../..';

/**
 * Precheck Node - Fast pattern matching for unambiguous commands
 * 
 * This node bypasses LLM calls for simple, direct commands that can be
 * pattern-matched. Think "turn on the lights" vs "help me with something".
 * 
 * Patterns are loaded dynamically from MCP servers via resources.
 * Each server exposes patterns like:
 * {
 *   pattern: "^turn\\s+(on|off)\\s+(?:the\\s+)?(.+?)\\s+lights?$",
 *   tool: "control_light",
 *   parameterMapping: { action: 1, location: 2 },
 *   confidence: 0.95
 * }
 * 
 * Flow:
 * 1. Load patterns from all MCP servers at initialization
 * 2. Match user input against patterns (regex)
 * 3. If match with high confidence → fast path (execute command directly)
 * 4. If no match or low confidence → router (LLM-based decision)
 */

export interface CommandPattern {
  id: string;
  pattern: string;
  flags: string;
  tool: string;
  description: string;
  parameterMapping: Record<string, number>;  // param name → capture group index
  examples: string[];
  confidence: number;
  server: string;  // Which MCP server provides this pattern
}

export interface PatternMatch {
  pattern: CommandPattern;
  matches: RegExpMatchArray;
  parameters: Record<string, string>;
  confidence: number;
}

/**
 * Load command patterns from all MCP servers
 */
export async function loadPatterns(redInstance: Red): Promise<CommandPattern[]> {
  const allPatterns: CommandPattern[] = [];
  
  try {
    // Query each MCP server for pattern resources
    const registry = redInstance.mcpRegistry;
    const serverNames = registry.getAllServerNames();
    
    for (const serverName of serverNames) {
      const client = registry.getClient(serverName);
      if (!client) continue;
      
      try {
        // List resources from this server
        const resources = await client.listResources();
        
        // Look for pattern resources
        const patternResources = resources.resources.filter(
          (r: any) => r.uri.startsWith('pattern://')
        );
        
        // Load each pattern resource
        for (const resource of patternResources) {
          try {
            const content = await client.readResource({ uri: resource.uri });
            const textContent = content.contents[0]?.text;
            if (!textContent) continue;
            
            const patternData = JSON.parse(textContent);
            
            // Parse patterns (could be array or single object)
            const patterns = Array.isArray(patternData) ? patternData : [patternData];
            
            for (const pattern of patterns) {
              allPatterns.push({
                ...pattern,
                server: serverName
              });
            }
            
            await redInstance.logger.log({
              level: 'info',
              category: 'precheck',
              message: `📦 Loaded ${patterns.length} patterns from ${serverName}`,
              metadata: { server: serverName, resourceUri: resource.uri }
            });
          } catch (error) {
            await redInstance.logger.log({
              level: 'warn',
              category: 'precheck',
              message: `Failed to load pattern resource: ${resource.uri}`,
              metadata: { error: String(error) }
            });
          }
        }
      } catch (error) {
        await redInstance.logger.log({
          level: 'warn',
          category: 'precheck',
          message: `Failed to query patterns from ${serverName}`,
          metadata: { error: String(error) }
        });
      }
    }
    
    await redInstance.logger.log({
      level: 'info',
      category: 'precheck',
      message: `✅ Loaded ${allPatterns.length} total command patterns`,
      metadata: { patternCount: allPatterns.length }
    });
    
  } catch (error) {
    await redInstance.logger.log({
      level: 'error',
      category: 'precheck',
      message: `Failed to load patterns: ${error}`,
      metadata: { error: String(error) }
    });
  }
  
  return allPatterns;
}

/**
 * Match user input against loaded patterns
 */
export function matchPattern(input: string, patterns: CommandPattern[]): PatternMatch | null {
  // Normalize input
  const normalizedInput = input.trim();
  
  let bestMatch: PatternMatch | null = null;
  let highestConfidence = 0;
  
  for (const pattern of patterns) {
    try {
      const regex = new RegExp(pattern.pattern, pattern.flags || 'i');
      const matches = normalizedInput.match(regex);
      
      if (matches) {
        // Extract parameters based on mapping
        const parameters: Record<string, string> = {};
        
        for (const [paramName, groupIndex] of Object.entries(pattern.parameterMapping)) {
          if (matches[groupIndex]) {
            parameters[paramName] = matches[groupIndex].trim();
          }
        }
        
        // Use pattern's confidence score
        const confidence = pattern.confidence || 0.5;
        
        if (confidence > highestConfidence) {
          highestConfidence = confidence;
          bestMatch = {
            pattern,
            matches,
            parameters,
            confidence
          };
        }
      }
    } catch (error) {
      // Invalid regex, skip
      console.error(`Invalid pattern regex: ${pattern.pattern}`, error);
    }
  }
  
  return bestMatch;
}

/**
 * Precheck Node - Pattern matching before LLM routing
 */
export const precheckNode = async (state: any) => {
  const redInstance: Red = state.redInstance;
  const conversationId = state.options?.conversationId;
  const generationId = state.options?.generationId;
  
  // Get user query from last message
  const messages = state.messages || [];
  const lastMessage = messages[messages.length - 1];
  const userQuery = typeof lastMessage?.content === 'string' 
    ? lastMessage.content 
    : '';
  
  if (!userQuery) {
    // No query to check, go to router
    return {
      precheckDecision: 'router',
      precheckReason: 'No user query found'
    };
  }
  
  await redInstance.logger.log({
    level: 'info',
    category: 'precheck',
    message: `🔍 Precheck: "${userQuery}"`,
    conversationId,
    generationId,
    metadata: { query: userQuery }
  });
  
  // Load patterns (in production, cache these)
  const patterns = await loadPatterns(redInstance);
  
  if (patterns.length === 0) {
    await redInstance.logger.log({
      level: 'info',
      category: 'precheck',
      message: '📋 No patterns loaded, routing to LLM',
      conversationId,
      generationId
    });
    
    return {
      precheckDecision: 'router',
      precheckReason: 'No patterns available'
    };
  }
  
  // Try to match against patterns
  const match = matchPattern(userQuery, patterns);
  
  if (match && match.confidence >= 0.8) {
    // High confidence match - use fast path!
    await redInstance.logger.log({
      level: 'info',
      category: 'precheck',
      message: `⚡ FAST PATH: Matched pattern "${match.pattern.id}" (confidence: ${match.confidence})`,
      conversationId,
      generationId,
      metadata: {
        patternId: match.pattern.id,
        tool: match.pattern.tool,
        parameters: match.parameters,
        confidence: match.confidence,
        server: match.pattern.server
      }
    });
    
    return {
      precheckDecision: 'fastpath',
      precheckMatch: match,
      precheckReason: `Pattern matched: ${match.pattern.description}`,
      // Store command details for executor
      fastpathTool: match.pattern.tool,
      fastpathServer: match.pattern.server,
      fastpathParameters: match.parameters
    };
  }
  
  // No match or low confidence - route to LLM
  await redInstance.logger.log({
    level: 'info',
    category: 'precheck',
    message: match 
      ? `🤔 Low confidence match (${match.confidence}), routing to LLM`
      : '❌ No pattern match, routing to LLM',
    conversationId,
    generationId,
    metadata: match ? {
      patternId: match.pattern.id,
      confidence: match.confidence
    } : undefined
  });
  
  return {
    precheckDecision: 'router',
    precheckReason: match 
      ? `Low confidence (${match.confidence})`
      : 'No pattern match'
  };
};
