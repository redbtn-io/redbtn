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
exports.contextNode = void 0;
const contextNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const redInstance = state.redInstance;
    const options = state.options || {};
    const conversationId = options.conversationId;
    const generationId = options.generationId;
    const messageId = state.messageId;
    const currentNodeNumber = state.nodeNumber || 1;
    const nextNodeNumber = currentNodeNumber + 1;
    // If context already loaded (or no conversation), skip work but advance node number
    if (state.contextLoaded || !conversationId) {
        return {
            contextLoaded: true,
            nodeNumber: nextNodeNumber
        };
    }
    let contextMessages = [];
    let contextSummary = '';
    yield redInstance.logger.log({
        level: 'info',
        category: 'context',
        message: `<cyan>🧱 Loading conversation context</cyan>`,
        conversationId,
        generationId,
    });
    try {
        const contextResult = yield redInstance.callMcpTool('get_context_history', {
            conversationId,
            maxTokens: 30000,
            includeSummary: true,
            summaryType: 'trailing',
            format: 'llm'
        }, {
            conversationId,
            generationId,
            messageId
        });
        if (!contextResult.isError && ((_b = (_a = contextResult.content) === null || _a === void 0 ? void 0 : _a[0]) === null || _b === void 0 ? void 0 : _b.text)) {
            const contextData = JSON.parse(contextResult.content[0].text);
            const rawMessages = contextData.messages || [];
            const seenContent = new Set();
            contextMessages = rawMessages.filter((msg) => {
                const key = `${msg.role}:${msg.content}`;
                if (seenContent.has(key)) {
                    return false;
                }
                seenContent.add(key);
                return true;
            });
            const removed = rawMessages.length - contextMessages.length;
            if (removed > 0) {
                yield redInstance.logger.log({
                    level: 'debug',
                    category: 'context',
                    message: `<yellow>⚠ Removed ${removed} duplicate context messages</yellow>`,
                    conversationId,
                    generationId,
                });
            }
        }
    }
    catch (error) {
        console.warn('[ContextNode] Failed to load context history:', error);
    }
    try {
        const summaryResult = yield redInstance.callMcpTool('get_summary', {
            conversationId,
            summaryType: 'executive'
        }, {
            conversationId,
            generationId,
            messageId
        });
        if (!summaryResult.isError && ((_d = (_c = summaryResult.content) === null || _c === void 0 ? void 0 : _c[0]) === null || _d === void 0 ? void 0 : _d.text)) {
            const summaryData = JSON.parse(summaryResult.content[0].text);
            if (summaryData.summary) {
                contextSummary = summaryData.summary;
            }
        }
    }
    catch (error) {
        console.warn('[ContextNode] Failed to load executive summary:', error);
    }
    return {
        contextMessages,
        contextSummary,
        contextLoaded: true,
        nodeNumber: nextNodeNumber
    };
});
exports.contextNode = contextNode;
