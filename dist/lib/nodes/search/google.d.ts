/**
 * Google Custom Search API Integration
 * Handles searching Google and returning structured results
 */
import type { SearchResult } from './types';
export declare function searchGoogle(query: string, maxResults?: number): Promise<SearchResult[]>;
