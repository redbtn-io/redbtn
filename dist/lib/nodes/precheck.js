"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.precheckNode = void 0;
exports.loadPatterns = loadPatterns;
exports.matchPattern = matchPattern;
/**
 * Load command patterns from all MCP servers
 */
function loadPatterns(redInstance) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const allPatterns = [];
        try {
            // Query each MCP server for pattern resources
            const registry = redInstance.mcpRegistry;
            const serverNames = registry.getAllServerNames();
            for (const serverName of serverNames) {
                const client = registry.getClient(serverName);
                if (!client)
                    continue;
                try {
                    // List resources from this server
                    const resources = yield client.listResources();
                    // Look for pattern resources
                    const patternResources = resources.resources.filter((r) => r.uri.startsWith('pattern://'));
                    // Load each pattern resource
                    for (const resource of patternResources) {
                        try {
                            const content = yield client.readResource({ uri: resource.uri });
                            const textContent = (_a = content.contents[0]) === null || _a === void 0 ? void 0 : _a.text;
                            if (!textContent)
                                continue;
                            const patternData = JSON.parse(textContent);
                            // Parse patterns (could be array or single object)
                            const patterns = Array.isArray(patternData) ? patternData : [patternData];
                            for (const pattern of patterns) {
                                allPatterns.push(Object.assign(Object.assign({}, pattern), { server: serverName }));
                            }
                            yield redInstance.logger.log({
                                level: 'info',
                                category: 'precheck',
                                message: `📦 Loaded ${patterns.length} patterns from ${serverName}`,
                                metadata: { server: serverName, resourceUri: resource.uri }
                            });
                        }
                        catch (error) {
                            yield redInstance.logger.log({
                                level: 'warn',
                                category: 'precheck',
                                message: `Failed to load pattern resource: ${resource.uri}`,
                                metadata: { error: String(error) }
                            });
                        }
                    }
                }
                catch (error) {
                    yield redInstance.logger.log({
                        level: 'warn',
                        category: 'precheck',
                        message: `Failed to query patterns from ${serverName}`,
                        metadata: { error: String(error) }
                    });
                }
            }
            yield redInstance.logger.log({
                level: 'info',
                category: 'precheck',
                message: `✅ Loaded ${allPatterns.length} total command patterns`,
                metadata: { patternCount: allPatterns.length }
            });
        }
        catch (error) {
            yield redInstance.logger.log({
                level: 'error',
                category: 'precheck',
                message: `Failed to load patterns: ${error}`,
                metadata: { error: String(error) }
            });
        }
        return allPatterns;
    });
}
/**
 * Match user input against loaded patterns
 */
function matchPattern(input, patterns) {
    // Normalize input
    const normalizedInput = input.trim();
    let bestMatch = null;
    let highestConfidence = 0;
    for (const pattern of patterns) {
        try {
            const regex = new RegExp(pattern.pattern, pattern.flags || 'i');
            const matches = normalizedInput.match(regex);
            if (matches) {
                // Extract parameters based on mapping
                const parameters = {};
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
        }
        catch (error) {
            // Invalid regex, skip
            console.error(`Invalid pattern regex: ${pattern.pattern}`, error);
        }
    }
    return bestMatch;
}
/**
 * Precheck Node - Pattern matching before LLM routing
 */
const precheckNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const redInstance = state.redInstance;
    const conversationId = (_a = state.options) === null || _a === void 0 ? void 0 : _a.conversationId;
    const generationId = (_b = state.options) === null || _b === void 0 ? void 0 : _b.generationId;
    // Get user query from last message
    const messages = state.messages || [];
    const lastMessage = messages[messages.length - 1];
    const userQuery = typeof (lastMessage === null || lastMessage === void 0 ? void 0 : lastMessage.content) === 'string'
        ? lastMessage.content
        : '';
    if (!userQuery) {
        // No query to check, go to router
        return {
            precheckDecision: 'router',
            precheckReason: 'No user query found'
        };
    }
    yield redInstance.logger.log({
        level: 'info',
        category: 'precheck',
        message: `🔍 Precheck: Checking for pattern matches...`,
        conversationId,
        generationId,
        metadata: { query: userQuery.substring(0, 100) }
    });
    // Load patterns (in production, cache these)
    const patterns = yield loadPatterns(redInstance);
    if (patterns.length === 0) {
        yield redInstance.logger.log({
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
        yield redInstance.logger.log({
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
    yield redInstance.logger.log({
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
});
exports.precheckNode = precheckNode;
