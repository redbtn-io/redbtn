/**
 * Web page scraper
 * Fetches and extracts clean text content from search result URLs
 */
import type { SearchResult } from './types';
/**
 * Scrape multiple search results in parallel
 * Returns updated results with content field populated
 */
export declare function scrapeSearchResults(results: SearchResult[], onProgress?: (current: number, total: number, url: string) => void): Promise<SearchResult[]>;
