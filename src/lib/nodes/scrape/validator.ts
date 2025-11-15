/**
 * URL validator
 * Ensures URLs are safe and valid before scraping
 */

const ALLOWED_PROTOCOLS = ['http:', 'https:'];
const BLOCKED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
];

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate and normalize a URL
 */
export function validateUrl(urlString: string): URL {
  // Remove whitespace
  urlString = urlString.trim();

  // Try to parse
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    throw new ValidationError(`Invalid URL format: ${urlString}`);
  }

  // Check protocol
  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new ValidationError(
      `Protocol ${url.protocol} not allowed. Only HTTP and HTTPS are supported.`
    );
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
