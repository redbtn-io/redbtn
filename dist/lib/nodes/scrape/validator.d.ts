/**
 * URL validator
 * Ensures URLs are safe and valid before scraping
 */
export declare class ValidationError extends Error {
    constructor(message: string);
}
/**
 * Validate and normalize a URL
 */
export declare function validateUrl(urlString: string): URL;
