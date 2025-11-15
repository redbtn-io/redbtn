/**
 * Types for the web search node
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  content?: string;
  scrapedAt?: number;
}

export interface GoogleSearchResponse {
  items?: Array<{
    title: string;
    link: string;
    snippet: string;
  }>;
  searchInformation?: {
    totalResults: string;
    searchTime: number;
  };
}

export interface SearchNodeInput {
  query: string;
  maxResults?: number;
}

export interface SearchNodeOutput {
  results: SearchResult[];
  summary: string;
  totalResults: number;
  searchTime: number;
}
