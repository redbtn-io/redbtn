"use strict";
/**
 * URL Scraping Node
 *
 * Fetches and extracts text content from a webpage via MCP with detailed progress events:
 * 1. Validates the URL
 * 2. Calls scrape_url MCP tool (Jina AI Reader)
 * 3. Returns content for chat node
 *
 * Note: This node now uses the MCP (Model Context Protocol) web server
 * instead of direct scraping for better architecture and reusability.
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
exports.scrapeNode = scrapeNode;
const messages_1 = require("@langchain/core/messages");
const validator_1 = require("./validator");
const node_helpers_1 = require("../../utils/node-helpers");
/**
 * Main scrape node function
 */
function scrapeNode(state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const startTime = Date.now();
        const redInstance = state.redInstance;
        const conversationId = (_a = state.options) === null || _a === void 0 ? void 0 : _a.conversationId;
        const generationId = (_b = state.options) === null || _b === void 0 ? void 0 : _b.generationId;
        const messageId = state.messageId;
        const currentNodeNumber = state.nodeNumber || 2; // If not set, default to 2
        const nextNodeNumber = currentNodeNumber + 1; // Responder will be next
        // Get URL from toolParam or extract from query
        const urlToScrape = state.toolParam || ((_c = state.query) === null || _c === void 0 ? void 0 : _c.message) || '';
        // NOTE: Event publishing is now handled by the MCP registry wrapper
        // No need for node-level event publishing anymore
        let publisher = null;
        // Disabled: registry publishes events automatically
        // if (redInstance?.messageQueue && messageId && conversationId) {
        //   publisher = createIntegratedPublisher(
        //     redInstance.messageQueue,
        //     'scrape',
        //     'URL Scraper',
        //     messageId,
        //     conversationId
        //   );
        // }
        try {
            // ==========================================
            // STEP 1: Start & Log
            // ==========================================
            yield redInstance.logger.log({
                level: 'info',
                category: 'tool',
                message: `📄 Starting URL scrape via MCP`,
                conversationId,
                generationId,
                metadata: {
                    toolName: 'scrape_url',
                    url: urlToScrape,
                    protocol: 'MCP/JSON-RPC 2.0'
                },
            });
            if (publisher) {
                yield publisher.publishStart({
                    input: { url: urlToScrape },
                    expectedDuration: 5000, // ~5 seconds
                });
            }
            // ==========================================
            // STEP 2: Validate URL
            // ==========================================
            if (publisher) {
                yield publisher.publishProgress('Validating URL...', { progress: 10 });
            }
            let validatedUrl;
            try {
                validatedUrl = (0, validator_1.validateUrl)(urlToScrape);
            }
            catch (error) {
                if (error instanceof validator_1.ValidationError) {
                    yield redInstance.logger.log({
                        level: 'error',
                        category: 'tool',
                        message: `✗ Invalid URL: ${error.message}`,
                        conversationId,
                        generationId,
                        metadata: { error: error.message },
                    });
                    if (publisher) {
                        yield publisher.publishError(error.message);
                    }
                    return {
                        messages: [
                            new messages_1.SystemMessage(`[INTERNAL CONTEXT]\n` +
                                `URL validation failed: ${error.message}\n` +
                                `Inform the user the URL is invalid.`)
                        ],
                        nextGraph: 'chat',
                    };
                }
                throw error;
            }
            yield redInstance.logger.log({
                level: 'info',
                category: 'tool',
                message: `✓ URL validated: ${validatedUrl.hostname}`,
                conversationId,
                generationId,
                metadata: {
                    hostname: validatedUrl.hostname,
                    protocol: validatedUrl.protocol
                },
            });
            // ==========================================
            // STEP 3: Call MCP scrape_url Tool
            // ==========================================
            if (publisher) {
                yield publisher.publishProgress(`Scraping ${validatedUrl.hostname} via MCP...`, {
                    progress: 40,
                    data: { hostname: validatedUrl.hostname },
                });
            }
            const scrapeResult = yield redInstance.callMcpTool('scrape_url', {
                url: validatedUrl.toString()
            }, {
                conversationId,
                generationId,
                messageId
            });
            // Check for errors
            if (scrapeResult.isError) {
                throw new Error(((_d = scrapeResult.content[0]) === null || _d === void 0 ? void 0 : _d.text) || 'Scraping failed');
            }
            const scrapedContent = ((_e = scrapeResult.content[0]) === null || _e === void 0 ? void 0 : _e.text) || '';
            if (!scrapedContent || scrapedContent.includes('No content could be extracted')) {
                yield redInstance.logger.log({
                    level: 'warn',
                    category: 'tool',
                    message: `⚠️ No content extracted from URL`,
                    conversationId,
                    generationId,
                });
                if (publisher) {
                    yield publisher.publishComplete({
                        result: 'No content extracted',
                        metadata: { contentLength: 0 },
                    });
                }
                return {
                    messages: [
                        new messages_1.SystemMessage(`[INTERNAL CONTEXT]\n` +
                            `Could not extract content from ${validatedUrl.toString()}\n` +
                            `Inform the user.`)
                    ],
                    nextGraph: 'chat',
                };
            }
            const duration = Date.now() - startTime;
            yield redInstance.logger.log({
                level: 'success',
                category: 'tool',
                message: `✓ URL scrape completed via MCP in ${(duration / 1000).toFixed(1)}s`,
                conversationId,
                generationId,
                metadata: {
                    duration,
                    url: validatedUrl.toString(),
                    contentLength: scrapedContent.length,
                    protocol: 'MCP/JSON-RPC 2.0'
                },
            });
            if (publisher) {
                yield publisher.publishComplete({
                    result: `Extracted ${scrapedContent.length} characters from ${validatedUrl.hostname}`,
                    metadata: {
                        duration,
                        url: validatedUrl.toString(),
                        contentLength: scrapedContent.length,
                        protocol: 'MCP',
                    },
                });
            }
            // ==========================================
            // STEP 4: Build Context with Scraped Content
            // ==========================================
            const messages = [];
            // Add system message
            const systemMessage = `${(0, node_helpers_1.getNodeSystemPrefix)(currentNodeNumber, 'Scrape')}

CRITICAL RULES:
1. Use the webpage content provided to answer the user's query
2. Be direct, helpful, and conversational`;
            messages.push({ role: 'system', content: systemMessage });
            // Use pre-loaded context from router (no need to load again)
            if (state.contextMessages && state.contextMessages.length > 0) {
                // Filter out the current user message
                const userQuery = ((_f = state.query) === null || _f === void 0 ? void 0 : _f.message) || '';
                const filteredMessages = state.contextMessages.filter((msg) => !(msg.role === 'user' && msg.content === userQuery));
                messages.push(...filteredMessages);
            }
            // Add the user's query with scraped content in brackets
            const userQuery = ((_g = state.query) === null || _g === void 0 ? void 0 : _g.message) || '';
            const userQueryWithContent = `${userQuery}\n\n[Webpage Content: ${scrapedContent}]`;
            messages.push({
                role: 'user',
                content: userQueryWithContent
            });
            return {
                messages,
                nextGraph: 'responder',
                nodeNumber: nextNodeNumber
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const duration = Date.now() - startTime;
            yield redInstance.logger.log({
                level: 'error',
                category: 'tool',
                message: `✗ URL scrape failed: ${errorMessage}`,
                conversationId,
                generationId,
                metadata: {
                    error: errorMessage,
                    duration,
                    url: urlToScrape
                },
            });
            if (publisher) {
                yield publisher.publishError(errorMessage);
            }
            return {
                messages: [
                    {
                        role: 'system',
                        content: `You are Red, an AI assistant. URL scraping failed: ${errorMessage}. Inform the user and offer to help in another way.`
                    },
                    {
                        role: 'user',
                        content: ((_h = state.query) === null || _h === void 0 ? void 0 : _h.message) || ''
                    }
                ],
                nextGraph: 'responder',
                nodeNumber: nextNodeNumber
            };
        }
    });
}
