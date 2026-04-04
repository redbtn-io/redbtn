"use strict";
/**
 * Web page scraper
 * Fetches and extracts clean text content from search result URLs
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
exports.scrapeSearchResults = scrapeSearchResults;
const MAX_CONTENT_LENGTH = 4000; // Characters
const FETCH_TIMEOUT = 8000; // 8 seconds per page
/**
 * Scrape a single URL and extract text content
 */
function scrapeSingleUrl(url) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
            const response = yield fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; RedAI/1.0; +https://redbtn.io)',
                },
            });
            clearTimeout(timeoutId);
            if (!response.ok) {
                return null;
            }
            const html = yield response.text();
            // Remove script and style tags
            let text = html
                .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ') // Remove all HTML tags
                .replace(/\s+/g, ' ') // Normalize whitespace
                .trim();
            // Decode common HTML entities
            text = text
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/&#39;/g, "'");
            // Truncate if too long
            if (text.length > MAX_CONTENT_LENGTH) {
                text = text.substring(0, MAX_CONTENT_LENGTH) + '...';
            }
            return text || null;
        }
        catch (error) {
            // Timeout, network error, etc. - just skip this URL
            return null;
        }
    });
}
/**
 * Scrape multiple search results in parallel
 * Returns updated results with content field populated
 */
function scrapeSearchResults(results, onProgress) {
    return __awaiter(this, void 0, void 0, function* () {
        const scrapedResults = [];
        // Scrape up to 5 results in parallel to avoid overwhelming servers
        const batchSize = 5;
        for (let i = 0; i < results.length; i += batchSize) {
            const batch = results.slice(i, i + batchSize);
            const scrapedBatch = yield Promise.all(batch.map((result, batchIndex) => __awaiter(this, void 0, void 0, function* () {
                const globalIndex = i + batchIndex;
                if (onProgress) {
                    onProgress(globalIndex + 1, results.length, result.url);
                }
                const content = yield scrapeSingleUrl(result.url);
                return Object.assign(Object.assign({}, result), { content: content || undefined, scrapedAt: Date.now() });
            })));
            scrapedResults.push(...scrapedBatch);
        }
        return scrapedResults;
    });
}
