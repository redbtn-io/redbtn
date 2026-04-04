"use strict";
/**
 * URL validator
 * Ensures URLs are safe and valid before scraping
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ValidationError = void 0;
exports.validateUrl = validateUrl;
const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const BLOCKED_HOSTS = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
];
class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}
exports.ValidationError = ValidationError;
/**
 * Validate and normalize a URL
 */
function validateUrl(urlString) {
    // Remove whitespace
    urlString = urlString.trim();
    // Try to parse
    let url;
    try {
        url = new URL(urlString);
    }
    catch (_a) {
        throw new ValidationError(`Invalid URL format: ${urlString}`);
    }
    // Check protocol
    if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
        throw new ValidationError(`Protocol ${url.protocol} not allowed. Only HTTP and HTTPS are supported.`);
    }
    // Check for blocked hosts (prevent localhost access)
    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
        throw new ValidationError(`Cannot scrape localhost or internal addresses`);
    }
    // Check for private IP ranges (basic check)
    if (hostname.startsWith('192.168.') || hostname.startsWith('10.') || hostname.startsWith('172.')) {
        throw new ValidationError(`Cannot scrape private IP addresses`);
    }
    return url;
}
