/**
 * Google Custom Search API Integration
 * Handles searching Google and returning structured results
 */

import type { GoogleSearchResponse, SearchResult } from './types';

const GOOGLE_API_BASE = 'https://www.googleapis.com/customsearch/v1';

export async function searchGoogle(
  query: string,
  maxResults: number = 10
): Promise<SearchResult[]> {
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

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Google API error (${response.status}): ${errorText}`);
  }

  const data: GoogleSearchResponse = await response.json();

  if (!data.items || data.items.length === 0) {
    return [];
  }

  return data.items.map(item => ({
    title: item.title,
    url: item.link,
    snippet: item.snippet,
  }));
}
