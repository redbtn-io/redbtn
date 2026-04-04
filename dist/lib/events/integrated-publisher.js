"use strict";
/**
 * Integrated Tool Event Publisher
 *
 * Bridges tools with MessageQueue.publishToolEvent()
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
exports.IntegratedToolPublisher = void 0;
exports.createIntegratedPublisher = createIntegratedPublisher;
class IntegratedToolPublisher {
    constructor(messageQueue, toolType, toolName, messageId, conversationId) {
        this.messageQueue = messageQueue;
        this.toolType = toolType;
        this.toolName = toolName;
        this.messageId = messageId;
        this.conversationId = conversationId;
        this.toolId = `${toolType}_${Date.now()}`;
        this.startTime = Date.now();
    }
    publishStart(options) {
        return __awaiter(this, void 0, void 0, function* () {
            const event = {
                type: 'tool_start',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                metadata: options || {},
            };
            yield this.messageQueue.publishToolEvent(this.messageId, event);
        });
    }
    publishProgress(message, options) {
        return __awaiter(this, void 0, void 0, function* () {
            const event = {
                type: 'tool_progress',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                step: message,
                progress: (options === null || options === void 0 ? void 0 : options.progress) || 0,
                data: options === null || options === void 0 ? void 0 : options.data,
            };
            yield this.messageQueue.publishToolEvent(this.messageId, event);
        });
    }
    publishComplete(result, metadata) {
        return __awaiter(this, void 0, void 0, function* () {
            const event = {
                type: 'tool_complete',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                result,
                metadata,
            };
            yield this.messageQueue.publishToolEvent(this.messageId, event);
        });
    }
    publishError(error, errorCode) {
        return __awaiter(this, void 0, void 0, function* () {
            const event = {
                type: 'tool_error',
                toolId: this.toolId,
                toolType: this.toolType,
                toolName: this.toolName,
                timestamp: Date.now(),
                error,
                errorCode,
            };
            yield this.messageQueue.publishToolEvent(this.messageId, event);
        });
    }
}
exports.IntegratedToolPublisher = IntegratedToolPublisher;
function createIntegratedPublisher(messageQueue, toolType, toolName, messageId, conversationId) {
    return new IntegratedToolPublisher(messageQueue, toolType, toolName, messageId, conversationId);
}
