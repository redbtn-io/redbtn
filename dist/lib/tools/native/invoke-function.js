"use strict";
/**
 * invoke_function — native tool for calling RedRun cloud functions
 *
 * Submits a job in async mode (?sync=false), then polls the execution
 * endpoint until it completes. Also streams function logs in real-time
 * by polling the execution logs endpoint and forwarding output chunks
 * via RunPublisher.toolProgress().
 */
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
const POLL_INTERVAL = 5000; // 5 seconds (was 10s — faster for streaming)
const LOG_POLL_INTERVAL = 2000; // 2 seconds for log streaming
const DEFAULT_MAX_WAIT = 900000; // 15 minutes
const SUBMIT_RETRIES = 3;
const SUBMIT_BACKOFF = [2000, 5000, 10000]; // 2s, 5s, 10s
const definition = {
    description: 'Invoke a RedRun cloud function asynchronously. Submits the job, polls for completion, and returns the result.',
    server: 'system',
    inputSchema: {
        type: 'object',
        properties: {
            url: {
                type: 'string',
                description: 'Base URL of the RedRun instance (e.g., https://run.redbtn.io)',
            },
            functionName: {
                type: 'string',
                description: 'Name of the function to invoke',
            },
            apiKey: {
                type: 'string',
                description: 'API key for authentication (x-api-key header)',
            },
            body: {
                type: 'object',
                description: 'Request body to send to the function',
            },
            timeout: {
                type: 'number',
                description: 'Maximum wait time in ms (default: 900000 = 15 min)',
            },
        },
        required: ['url', 'functionName', 'body'],
    },
    handler(args, context) {
        return __awaiter(this, void 0, void 0, function* () {
            var _a, _b;
            const baseUrl = args.url.replace(/\/$/, '');
            const functionName = args.functionName;
            const apiKey = args.apiKey;
            const rawBody = args.body;
            // Support both object body and pre-stringified JSON (from graph templates)
            const bodyStr = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody);
            const maxWait = Number(args.timeout) || DEFAULT_MAX_WAIT;
            const headers = { 'Content-Type': 'application/json' };
            if (apiKey)
                headers['x-api-key'] = apiKey;
            // Stream progress via RunPublisher.toolProgress(toolId, step, options)
            const pub = context.publisher;
            const toolId = context.toolId;
            // ── Step 1: Submit async job ──
            const submitUrl = `${baseUrl}/api/invoke/${functionName}?sync=false`;
            if ((pub === null || pub === void 0 ? void 0 : pub.toolProgress) && toolId) {
                yield pub.toolProgress(toolId, `Submitting ${functionName} job...`, { progress: 5 });
            }
            let submitData = null;
            for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
                try {
                    const submitRes = yield fetch(submitUrl, {
                        method: 'POST',
                        headers,
                        body: bodyStr,
                        signal: AbortSignal.timeout(30000),
                    });
                    if (submitRes.ok) {
                        submitData = (yield submitRes.json());
                        break;
                    }
                    const errText = yield submitRes.text();
                    if (submitRes.status >= 400 && submitRes.status < 500) {
                        // Client error — don't retry
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ error: `Submit failed (${submitRes.status})`, details: errText.substring(0, 500) }) }],
                            isError: true,
                        };
                    }
                    // Server error — retry with backoff
                    console.warn(`[invoke_function] Submit returned ${submitRes.status}, retrying (${attempt + 1}/${SUBMIT_RETRIES}): ${errText.substring(0, 100)}`);
                }
                catch (fetchErr) {
                    console.warn(`[invoke_function] Submit error (${attempt + 1}/${SUBMIT_RETRIES}): ${fetchErr.message}`);
                }
                if (attempt < SUBMIT_RETRIES) {
                    yield new Promise(r => setTimeout(r, SUBMIT_BACKOFF[attempt] || 10000));
                }
            }
            if (!submitData) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `Submit failed after ${SUBMIT_RETRIES} retries` }) }],
                    isError: true,
                };
            }
            const { executionId, pollUrl } = submitData;
            if (!executionId) {
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: 'No executionId in response', response: submitData }) }],
                    isError: true,
                };
            }
            console.log(`[invoke_function] Job submitted: ${executionId} for ${functionName}`);
            if ((pub === null || pub === void 0 ? void 0 : pub.toolProgress) && toolId) {
                yield pub.toolProgress(toolId, `Job submitted: ${executionId}`, { progress: 10, data: { executionId, functionName } });
            }
            // ── Step 2: Poll for completion + stream logs ──
            const pollEndpoint = `${baseUrl}${pollUrl || `/api/executions/${executionId}`}`;
            const logsEndpoint = `${baseUrl}/api/executions/${executionId}/logs`;
            const startTime = Date.now();
            let lastStatus = 'queued';
            let lastLogIndex = 0; // Track how many logs we've already forwarded
            // Start log streaming in parallel with status polling
            let logPollTimer = null;
            let done = false;
            const streamLogs = () => __awaiter(this, void 0, void 0, function* () {
                var _a;
                try {
                    const logRes = yield fetch(logsEndpoint, {
                        headers,
                        signal: AbortSignal.timeout(10000),
                    });
                    if (!logRes.ok)
                        return;
                    const logData = yield logRes.json();
                    const allLogs = logData.logs || [];
                    // Only process new logs since last check
                    const newLogs = allLogs.slice(lastLogIndex);
                    if (newLogs.length === 0)
                        return;
                    lastLogIndex = allLogs.length;
                    for (const log of newLogs) {
                        if ((pub === null || pub === void 0 ? void 0 : pub.toolProgress) && toolId) {
                            // Check if this is an output chunk from ssh-claude
                            const isOutputChunk = (_a = log.message) === null || _a === void 0 ? void 0 : _a.startsWith('[OUTPUT] ');
                            const message = isOutputChunk ? log.message.slice(9) : log.message;
                            yield pub.toolProgress(toolId, message, {
                                data: {
                                    executionId,
                                    functionName,
                                    logLevel: log.level,
                                    isOutputChunk,
                                    timestamp: log.timestamp,
                                },
                            });
                        }
                    }
                }
                catch (_b) {
                    // Swallow log poll errors — don't interrupt main polling
                }
            });
            // Poll logs every LOG_POLL_INTERVAL
            logPollTimer = setInterval(() => { if (!done)
                streamLogs(); }, LOG_POLL_INTERVAL);
            // Also do an initial log fetch after a short delay
            setTimeout(() => { if (!done)
                streamLogs(); }, 1000);
            try {
                while (Date.now() - startTime < maxWait) {
                    // Check abort signal
                    if ((_a = context.abortSignal) === null || _a === void 0 ? void 0 : _a.aborted) {
                        return {
                            content: [{ type: 'text', text: JSON.stringify({ error: 'Aborted', executionId }) }],
                            isError: true,
                        };
                    }
                    yield new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
                    try {
                        const pollRes = yield fetch(pollEndpoint, {
                            headers,
                            signal: AbortSignal.timeout(30000),
                        });
                        if (!pollRes.ok) {
                            const errBody = yield pollRes.text().catch(() => '');
                            console.warn(`[invoke_function] Poll returned ${pollRes.status}: ${errBody.substring(0, 200)}`);
                            continue;
                        }
                        const execution = yield pollRes.json();
                        const elapsed = Math.round((Date.now() - startTime) / 1000);
                        if (execution.status !== lastStatus) {
                            lastStatus = execution.status;
                            console.log(`[invoke_function] ${executionId} status: ${execution.status} (${elapsed}s)`);
                        }
                        if ((pub === null || pub === void 0 ? void 0 : pub.toolProgress) && toolId) {
                            yield pub.toolProgress(toolId, `${functionName}: ${execution.status} (${elapsed}s)`, { progress: Math.min(90, 10 + (elapsed / (maxWait / 1000)) * 80), data: { executionId, status: execution.status, elapsed } });
                        }
                        if (execution.status === 'success' || execution.status === 'completed') {
                            console.log(`[invoke_function] ${executionId} completed in ${elapsed}s`);
                            // Final log fetch to get any remaining output
                            yield streamLogs();
                            return {
                                content: [{
                                        type: 'text',
                                        text: JSON.stringify((_b = execution.result) !== null && _b !== void 0 ? _b : execution),
                                    }],
                            };
                        }
                        if (execution.status === 'failure' || execution.status === 'error' || execution.status === 'timeout') {
                            yield streamLogs(); // Get final logs
                            return {
                                content: [{
                                        type: 'text',
                                        text: JSON.stringify({
                                            error: execution.error || `Function ${execution.status}`,
                                            executionId,
                                            durationMs: execution.durationMs,
                                        }),
                                    }],
                                isError: true,
                            };
                        }
                        // Still running — continue polling
                    }
                    catch (pollErr) {
                        console.warn(`[invoke_function] Poll error:`, pollErr instanceof Error ? pollErr.message : pollErr);
                    }
                }
                return {
                    content: [{
                            type: 'text',
                            text: JSON.stringify({ error: `Timed out after ${maxWait}ms`, executionId }),
                        }],
                    isError: true,
                };
            }
            finally {
                done = true;
                if (logPollTimer)
                    clearInterval(logPollTimer);
            }
        });
    },
};
module.exports = definition;
exports.default = definition;
