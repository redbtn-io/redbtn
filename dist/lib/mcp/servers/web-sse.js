"use strict";
/**
 * Web MCP Server - SSE Transport
 * Combines web search and URL scraping capabilities
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
exports.WebServerSSE = void 0;
const server_sse_1 = require("../server-sse");
const parser_1 = require("../../nodes/scrape/parser");
class WebServerSSE extends server_sse_1.McpServerSSE {
    constructor(name, version, port = 3001, googleApiKey, googleSearchEngineId) {
        super(name, version, port, '/mcp');
        this.googleApiKey = googleApiKey || process.env.GOOGLE_API_KEY || '';
        this.googleSearchEngineId = googleSearchEngineId || process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID || '';
        if (!this.googleApiKey || !this.googleSearchEngineId) {
            console.warn('[Web Server] Google API credentials not configured - search will not work');
        }
    }
    /**
     * Setup tools
     */
    setup() {
        return __awaiter(this, void 0, void 0, function* () {
            // Define web_search tool
            this.defineTool({
                name: 'web_search',
                description: 'Search the web using Google Custom Search API. Returns relevant web results for queries about current events, news, or any information that needs to be looked up online.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'The search query'
                        },
                        count: {
                            type: 'number',
                            description: 'Number of results to return (1-10, default: 10)'
                        }
                    },
                    required: ['query']
                }
            });
            // Define scrape_url tool
            this.defineTool({
                name: 'scrape_url',
                description: 'Scrape and extract clean text content from a URL using custom content extraction. Returns the main content of the page without ads, navigation, or other clutter. Works with articles, documentation, blog posts, and most web pages.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        url: {
                            type: 'string',
                            description: 'The URL to scrape (must start with http:// or https://)'
                        }
                    },
                    required: ['url']
                }
            });
            this.capabilities = {
                tools: {
                    listChanged: false
                }
            };
        });
    }
    /**
     * Execute tool
     */
    executeTool(name, args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (name) {
                case 'web_search':
                    return yield this.executeWebSearch(args, meta);
                case 'scrape_url':
                    return yield this.executeScrapeUrl(args, meta);
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        });
    }
    /**
     * Execute web_search tool
     */
    executeWebSearch(args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a;
            const query = args.query;
            const count = args.count || 10;
            if (!this.googleApiKey || !this.googleSearchEngineId) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: 'Google API credentials not configured',
                                results: []
                            })
                        }],
                    isError: true
                };
            }
            try {
                const url = `https://www.googleapis.com/customsearch/v1?key=${this.googleApiKey}&cx=${this.googleSearchEngineId}&q=${encodeURIComponent(query)}&num=${Math.min(count, 10)}`;
                const response = yield fetch(url);
                if (!response.ok) {
                    throw new Error(`Google API error: ${response.status} ${response.statusText}`);
                }
                const data = yield response.json();
                const results = (data.items || []).map((item) => ({
                    title: item.title,
                    link: item.link,
                    snippet: item.snippet,
                    displayLink: item.displayLink
                }));
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                query,
                                searchEngine: 'Google Custom Search',
                                totalResults: ((_a = data.searchInformation) === null || _a === void 0 ? void 0 : _a.totalResults) || '0',
                                results
                            })
                        }]
                };
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: error instanceof Error ? error.message : String(error),
                                results: []
                            })
                        }],
                    isError: true
                };
            }
        });
    }
    /**
     * Execute scrape_url tool
     */
    executeScrapeUrl(args, meta) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = args.url;
            if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: 'Invalid URL: must start with http:// or https://',
                                url
                            })
                        }],
                    isError: true
                };
            }
            try {
                const result = yield (0, parser_1.fetchAndParse)(url);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                url,
                                title: result.title,
                                content: result.text,
                                contentLength: result.contentLength
                            })
                        }]
                };
            }
            catch (error) {
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                error: error instanceof Error ? error.message : String(error),
                                url
                            })
                        }],
                    isError: true
                };
            }
        });
    }
}
exports.WebServerSSE = WebServerSSE;
