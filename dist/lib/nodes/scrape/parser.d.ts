/**
 * HTML parser with smart content extraction
 * Custom algorithm for extracting main content from HTML without external dependencies
 */
export interface ParsedContent {
    title?: string;
    text: string;
    contentLength: number;
}
/**
 * Fetch and parse HTML from a URL
 */
export declare function fetchAndParse(url: string): Promise<ParsedContent>;
