"use strict";
/**
 * Command Execution Node
 *
 * Executes shell commands via MCP with detailed progress events:
 * 1. Validates command for security
 * 2. Calls execute_command MCP tool
 * 3. Returns result for chat node
 *
 * Note: This node now uses the MCP (Model Context Protocol) system server
 * instead of direct execution for better security and architecture.
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
exports.commandNode = commandNode;
const messages_1 = require("@langchain/core/messages");
const node_helpers_1 = require("../../utils/node-helpers");
/**
 * Main command node function
 */
function commandNode(state) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _e, _f, _g, _h;
        const startTime = Date.now();
        const redInstance = state.redInstance;
        const conversationId = (_a = state.options) === null || _a === void 0 ? void 0 : _a.conversationId;
        const generationId = (_b = state.options) === null || _b === void 0 ? void 0 : _b.generationId;
        const messageId = state.messageId;
        const currentNodeNumber = state.nodeNumber || 2; // If not set, default to 2
        const nextNodeNumber = currentNodeNumber + 1; // Responder will be next
        // Get command from toolParam or query
        const command = state.toolParam || ((_c = state.query) === null || _c === void 0 ? void 0 : _c.message) || '';
        // NOTE: Event publishing is now handled by the MCP registry wrapper
        // No need for node-level event publishing anymore
        let publisher = null;
        // Disabled: registry publishes events automatically
        // if (redInstance?.messageQueue && messageId && conversationId) {
        //   publisher = createIntegratedPublisher(
        //     redInstance.messageQueue,
        //     'command',
        //     'Command Execution',
        //     messageId,
        //     conversationId
        //   );
        // }
        try {
            // ==========================================
            // STEP 1: Start & Log
            // ==========================================
            yield redInstance.logger.log({
                level: 'info',
                category: 'tool',
                message: `⚙️ Starting command execution via MCP`,
                conversationId,
                generationId,
                metadata: {
                    toolName: 'execute_command',
                    command: command.substring(0, 100),
                    protocol: 'MCP/JSON-RPC 2.0'
                },
            });
            if (publisher) {
                yield publisher.publishStart({
                    input: { command },
                    expectedDuration: 5000,
                });
            }
            // ==========================================
            // STEP 2: Call MCP execute_command Tool
            // ==========================================
            if (publisher) {
                yield publisher.publishProgress(`Executing command via MCP...`, {
                    progress: 30,
                    data: { command: command.substring(0, 100) },
                });
            }
            const commandResult = yield redInstance.callMcpTool('execute_command', {
                command: command
            }, {
                conversationId,
                generationId,
                messageId
            });
            // Check for errors
            if (commandResult.isError) {
                const errorText = ((_d = commandResult.content[0]) === null || _d === void 0 ? void 0 : _d.text) || 'Command execution failed';
                yield redInstance.logger.log({
                    level: 'warn',
                    category: 'tool',
                    message: `🛡️ Command failed: ${errorText.substring(0, 200)}`,
                    conversationId,
                    generationId,
                    metadata: {
                        command,
                        error: errorText
                    },
                });
                if (publisher) {
                    yield publisher.publishError(errorText);
                }
                return {
                    messages: [
                        new messages_1.SystemMessage(`[INTERNAL CONTEXT]\n` +
                            `Command execution failed: ${errorText}\n` +
                            `Inform the user.`)
                    ],
                    nextGraph: 'chat',
                };
            }
            const resultText = ((_e = commandResult.content[0]) === null || _e === void 0 ? void 0 : _e.text) || 'Command completed with no output';
            const duration = Date.now() - startTime;
            yield redInstance.logger.log({
                level: 'success',
                category: 'tool',
                message: `✓ Command completed via MCP in ${(duration / 1000).toFixed(1)}s`,
                conversationId,
                generationId,
                metadata: {
                    command,
                    duration,
                    resultLength: resultText.length,
                    protocol: 'MCP/JSON-RPC 2.0'
                },
            });
            if (publisher) {
                yield publisher.publishComplete({
                    result: resultText,
                    metadata: {
                        duration,
                        resultLength: resultText.length,
                        protocol: 'MCP',
                    },
                });
            }
            // ==========================================
            // STEP 3: Build Context with Command Result
            // ==========================================
            const messages = [];
            // Add system message
            const systemMessage = `${(0, node_helpers_1.getNodeSystemPrefix)(currentNodeNumber, 'Command')}

CRITICAL RULES:
1. Use the command execution result to answer the user's query
2. Be direct, helpful, and conversational`;
            messages.push({ role: 'system', content: systemMessage });
            // Use pre-loaded context from router (no need to load again)
            if (state.contextMessages && state.contextMessages.length > 0) {
                // Filter out current user message
                const userQuery = ((_f = state.query) === null || _f === void 0 ? void 0 : _f.message) || command;
                const filteredMessages = state.contextMessages.filter((msg) => !(msg.role === 'user' && msg.content === userQuery));
                messages.push(...filteredMessages);
            }
            // Add user query with command result in brackets
            const userQuery = ((_g = state.query) === null || _g === void 0 ? void 0 : _g.message) || command;
            const userQueryWithResult = `${userQuery}\n\n[Command Result: ${resultText}]`;
            messages.push({
                role: 'user',
                content: userQueryWithResult
            });
            return {
                messages,
                nextGraph: 'responder',
                nodeNumber: nextNodeNumber
            };
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            const duration = Date.now() - startTime;
            yield redInstance.logger.log({
                level: 'error',
                category: 'tool',
                message: `✗ Command execution failed: ${errorMessage}`,
                conversationId,
                generationId,
                metadata: {
                    error: errorMessage,
                    duration,
                    command
                },
            });
            if (publisher) {
                yield publisher.publishError(errorMessage);
            }
            return {
                messages: [
                    {
                        role: 'system',
                        content: `You are Red, an AI assistant. Command execution failed: ${errorMessage}. Inform the user and offer alternative solutions.`
                    },
                    {
                        role: 'user',
                        content: ((_h = state.query) === null || _h === void 0 ? void 0 : _h.message) || command
                    }
                ],
                nextGraph: 'responder',
                nodeNumber: nextNodeNumber
            };
        }
    });
}
