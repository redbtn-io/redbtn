/**
 * Types for the scrape node
 */

export interface ScrapeNodeInput {
  url: string;
}

export interface ScrapeNodeOutput {
  url: string;
  title?: string;
  content: string;
  contentLength: number;
  scrapedAt: number;
}
