"use strict";
/**
 * MCP Tool Event Publisher
 *
 * Publishes tool events and logs from MCP servers to Redis
 * so they appear in the UI and logs API
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
exports.McpEventPublisher = void 0;
class McpEventPublisher {
    constructor(redis, toolType, toolName, meta) {
        this.redis = redis;
        this.toolType = toolType;
        this.toolName = toolName;
        this.messageId = meta === null || meta === void 0 ? void 0 : meta.messageId;
        this.conversationId = meta === null || meta === void 0 ? void 0 : meta.conversationId;
        this.generationId = meta === null || meta === void 0 ? void 0 : meta.generationId;
        this.toolId = `${toolType}_${Date.now()}`;
        this.startTime = Date.now();
    }
    /**
     * Publish tool start event
     */
    publishStart(options) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.messageId)
                return; // Skip if no messageId
            const event = {
                type: 'tool_start',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                metadata: options || {},
            };
            yield this.redis.publish(`tool:event:${this.messageId}`, JSON.stringify(event));
        });
    }
    /**
     * Publish tool progress event
     */
    publishProgress(message, options) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.messageId)
                return; // Skip if no messageId
            const event = {
                type: 'tool_progress',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                step: message,
                progress: (options === null || options === void 0 ? void 0 : options.progress) || 0,
                data: options === null || options === void 0 ? void 0 : options.data,
                streamingContent: options === null || options === void 0 ? void 0 : options.streamingContent,
            };
            yield this.redis.publish(`tool:event:${this.messageId}`, JSON.stringify(event));
        });
    }
    /**
     * Publish tool complete event
     */
    publishComplete(result, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.messageId)
                return; // Skip if no messageId
            const event = {
                type: 'tool_complete',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                result,
                metadata,
            };
            yield this.redis.publish(`tool:event:${this.messageId}`, JSON.stringify(event));
        });
    }
    /**
     * Publish tool error event
     */
    publishError(error) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.messageId)
                return; // Skip if no messageId
            // Convert error to string if it's an Error object or has an error property
            let errorMessage;
            let errorCode;
            if (typeof error === 'string') {
                errorMessage = error;
            }
            else if (error instanceof Error) {
                errorMessage = error.message;
                errorCode = error.name;
            }
            else if (typeof error === 'object' && 'error' in error) {
                errorMessage = error.error;
                errorCode = error.errorCode;
            }
            else {
                // Fallback for unknown object types
                errorMessage = JSON.stringify(error);
            }
            const event = {
                type: 'tool_error',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                error: errorMessage,
                errorCode,
            };
            yield this.redis.publish(`tool:event:${this.messageId}`, JSON.stringify(event));
        });
    }
    /**
     * Publish log entry
     */
    publishLog(level, message, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!this.conversationId)
                return; // Skip if no conversationId
            const logEntry = {
                level,
                category: 'mcp',
                message,
                conversationId: this.conversationId,
                generationId: this.generationId,
                timestamp: Date.now(),
                metadata: Object.assign(Object.assign({}, metadata), { toolName: this.toolName, toolType: this.toolType, protocol: 'MCP/JSON-RPC 2.0' }),
            };
            // Publish to log channel for persistent logger to pick up
            yield this.redis.publish('log:entry', JSON.stringify(logEntry));
        });
    }
    /**
     * Get elapsed time since tool start
     */
    getDuration() {
        return Date.now() - this.startTime;
    }
}
exports.McpEventPublisher = McpEventPublisher;
