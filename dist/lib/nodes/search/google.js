"use strict";
/**
 * Google Custom Search API Integration
 * Handles searching Google and returning structured results
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
exports.searchGoogle = searchGoogle;
const GOOGLE_API_BASE = 'https://www.googleapis.com/customsearch/v1';
function searchGoogle(query_1) {
    return __awaiter(this, arguments, void 0, function* (query, maxResults = 10) {
        const apiKey = process.env.GOOGLE_API_KEY;
        const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CSE_ID;
        if (!apiKey) {
            throw new Error('GOOGLE_API_KEY environment variable is not set');
        }
        if (!searchEngineId) {
            throw new Error('GOOGLE_SEARCH_ENGINE_ID environment variable is not set');
        }
        const url = new URL(GOOGLE_API_BASE);
        url.searchParams.set('key', apiKey);
        url.searchParams.set('cx', searchEngineId);
        url.searchParams.set('q', query);
        url.searchParams.set('num', Math.min(maxResults, 10).toString());
        const response = yield fetch(url.toString(), {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
            },
        });
        if (!response.ok) {
            const errorText = yield response.text();
            throw new Error(`Google API error (${response.status}): ${errorText}`);
        }
        const data = yield response.json();
        if (!data.items || data.items.length === 0) {
            return [];
        }
        return data.items.map(item => ({
            title: item.title,
            url: item.link,
            snippet: item.snippet,
        }));
    });
}
