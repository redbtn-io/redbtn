"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fetchUrlTool = {
    description: 'Make an HTTP request to a URL. Supports all REST methods with custom headers, body, auth, and redirect control. Returns status, response headers, and body.',
    inputSchema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'The URL to fetch',
            },
            method: {
                type: 'string',
                enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
                description: 'HTTP method (default: GET)',
            },
            headers: {
                type: 'object',
                description: 'Request headers as key-value pairs',
                additionalProperties: { type: 'string' },
            },
            body: {
                type: 'string',
                description: 'Request body (JSON string for POST/PUT, or raw text)',
            },
            timeout: {
                type: 'number',
                description: 'Request timeout in milliseconds (default: 300000, max: 900000)',
            },
            followRedirects: {
                type: 'boolean',
                description: 'Follow HTTP redirects (default: true)',
            },
        },
        required: ['url'],
    },
    handler(args, context) {
        return __awaiter(this, void 0, void 0, function* () {
            const url = (args.url || '').trim();
            const method = (args.method || 'GET').toUpperCase();
            const headers = args.headers || {};
            const body = args.body;
            const timeout = Math.min(Number(args.timeout) || 300000, 900000);
            const followRedirects = args.followRedirects !== false;
            if (!url) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: 'No URL provided' }) }], isError: true };
            }
            const { publisher } = context;
            publisher === null || publisher === void 0 ? void 0 : publisher.emit('log', `fetch_url ${method} ${url}`);
            try {
                const fetchHeaders = Object.assign({}, headers);
                if (body && !fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
                    fetchHeaders['Content-Type'] = 'application/json';
                }
                const MAX_RETRIES = 2;
                const BACKOFF = [2000, 5000];
                let response = null;
                for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), timeout);
                    try {
                        response = yield fetch(url, {
                            method,
                            headers: fetchHeaders,
                            body: method !== 'GET' && method !== 'HEAD' ? (body || undefined) : undefined,
                            signal: controller.signal,
                            redirect: followRedirects ? 'follow' : 'manual',
                        });
                        clearTimeout(timer);
                        // Don't retry on success or client errors (4xx)
                        if (response.ok || (response.status >= 400 && response.status < 500))
                            break;
                        // Server error (5xx) — retry
                        if (attempt < MAX_RETRIES) {
                            publisher === null || publisher === void 0 ? void 0 : publisher.emit('log', `fetch_url ${method} ${url} → ${response.status}, retrying (${attempt + 1}/${MAX_RETRIES})`);
                            yield new Promise(r => setTimeout(r, BACKOFF[attempt] || 5000));
                        }
                    }
                    catch (retryErr) {
                        clearTimeout(timer);
                        if (retryErr.name === 'AbortError' || attempt >= MAX_RETRIES)
                            throw retryErr;
                        publisher === null || publisher === void 0 ? void 0 : publisher.emit('log', `fetch_url ${method} ${url} → error, retrying (${attempt + 1}/${MAX_RETRIES}): ${retryErr.message}`);
                        yield new Promise(r => setTimeout(r, BACKOFF[attempt] || 5000));
                    }
                }
                if (!response)
                    throw new Error('No response after retries');
                // Collect response headers
                const responseHeaders = {};
                response.headers.forEach((value, key) => {
                    responseHeaders[key] = value;
                });
                // HEAD and OPTIONS don't need body
                let responseBody = '';
                if (method !== 'HEAD') {
                    responseBody = yield response.text();
                }
                // Try to pretty-print JSON
                let output;
                try {
                    const json = JSON.parse(responseBody);
                    output = JSON.stringify(json, null, 2);
                }
                catch (_a) {
                    output = responseBody;
                }
                // Truncate large responses
                if (output.length > 500000) {
                    output = output.slice(0, 500000) + '...(truncated)';
                }
                publisher === null || publisher === void 0 ? void 0 : publisher.emit('log', `fetch_url ${method} ${url} → ${response.status}`);
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({
                                status: response.status,
                                statusText: response.statusText,
                                headers: responseHeaders,
                                body: output,
                            }),
                        }],
                };
            }
            catch (error) {
                const errorMessage = error.name === 'AbortError'
                    ? `Request timed out after ${timeout}ms`
                    : error.message || 'Unknown error';
                publisher === null || publisher === void 0 ? void 0 : publisher.emit('log', `fetch_url ${method} ${url} → ERROR: ${errorMessage}`);
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `HTTP request failed: ${errorMessage}` }) }],
                    isError: true,
                };
            }
        });
    },
};
exports.default = fetchUrlTool;
module.exports = fetchUrlTool;
