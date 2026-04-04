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
import type { Red } from '../../..';
interface ScrapeNodeState {
    query: {
        message: string;
    };
    redInstance: Red;
    options?: {
        conversationId?: string;
        generationId?: string;
    };
    messageId?: string;
    toolParam?: string;
    contextMessages?: any[];
    nodeNumber?: number;
}
/**
 * Main scrape node function
 */
export declare function scrapeNode(state: ScrapeNodeState): Promise<Partial<any>>;
export {};
