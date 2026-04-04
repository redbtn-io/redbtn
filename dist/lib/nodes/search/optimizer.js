"use strict";
/**
 * Search query optimizer
 * Uses LLM to optimize user queries into effective search terms
 */
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
exports.optimizeSearchQuery = optimizeSearchQuery;
exports.summarizeSearchResults = summarizeSearchResults;
const thinking_1 = require("../../utils/thinking");
const retry_1 = require("../../utils/retry");
const node_helpers_1 = require("../../utils/node-helpers");
/**
 * Optimize a natural language query into effective search terms
 */
function optimizeSearchQuery(originalQuery_1, redInstance_1, conversationId_1, generationId_1) {
    return __awaiter(this, arguments, void 0, function* (originalQuery, redInstance, conversationId, generationId, nodeNumber = 2) {
        const currentDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const response = yield (0, retry_1.invokeWithRetry)(redInstance.chatModel, [
            {
                role: 'system',
                content: `${(0, node_helpers_1.getNodeSystemPrefix)(nodeNumber, 'Search Query Optimizer')}

Extract the key search terms from the user's prompt. Focus on:
- Core concepts and keywords
- Specific entities (names, places, products)
- Time-relevant terms (if asking about "latest" or "recent")
- Technical terms exactly as written

Return ONLY the optimized search query, nothing else.`
            },
            {
                role: 'user',
                content: originalQuery
            }
        ], { context: 'search query optimization' });
        const { thinking, cleanedContent } = (0, thinking_1.extractThinking)(response.content.toString());
        // Log optimization thinking if present
        if (thinking && generationId && conversationId) {
            yield redInstance.logger.logThought({
                content: thinking,
                source: 'search-query-optimization',
                generationId,
                conversationId,
            });
        }
        return {
            optimizedQuery: cleanedContent.trim(),
            thinking: thinking || undefined,
        };
    });
}
/**
 * Summarize search results into concise, relevant information
 */
function summarizeSearchResults(originalQuery_1, searchResults_1, redInstance_1, conversationId_1, generationId_1) {
    return __awaiter(this, arguments, void 0, function* (originalQuery, searchResults, redInstance, conversationId, generationId, nodeNumber = 2) {
        const currentDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        const response = yield (0, retry_1.invokeWithRetry)(redInstance.chatModel, [
            {
                role: 'system',
                content: `${(0, node_helpers_1.getNodeSystemPrefix)(nodeNumber, 'Search Result Summarizer')}

You are an information extraction expert. Extract key facts and data to answer the user's query accurately and concisely. IMPORTANT: Do NOT repeat or rephrase the query - only provide the facts and information.`
            },
            {
                role: 'user',
                content: `User Query: ${originalQuery}\n\nSearch Results:\n${searchResults}\n\nExtract and summarize the key information that answers this query. Start directly with the facts - do NOT repeat the query:`
            }
        ], { context: 'search result summarization' });
        const { thinking, cleanedContent } = (0, thinking_1.extractThinking)(response.content.toString());
        // Log extraction thinking if present
        if (thinking && generationId && conversationId) {
            yield redInstance.logger.logThought({
                content: thinking,
                source: 'search-result-extraction',
                generationId,
                conversationId,
            });
        }
        return {
            summary: cleanedContent.trim(),
            thinking: thinking || undefined,
        };
    });
}
