"use strict";
/**
 * Background summarization utilities
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
exports.summarizeInBackground = summarizeInBackground;
exports.generateExecutiveSummaryInBackground = generateExecutiveSummaryInBackground;
const thinking_1 = require("../../lib/utils/thinking");
const retry_1 = require("../../lib/utils/retry");
/**
 * Trigger summarization in background (non-blocking)
 */
function summarizeInBackground(conversationId, memory, chatModel) {
    memory.summarizeIfNeeded(conversationId, (prompt) => __awaiter(this, void 0, void 0, function* () {
        const response = yield (0, retry_1.invokeWithRetry)(chatModel, [{ role: 'user', content: prompt }], {
            context: 'background summarization',
        });
        const rawContent = response.content;
        // Extract thinking (if present) and return cleaned content
        const { cleanedContent } = (0, thinking_1.extractThinking)(rawContent);
        return cleanedContent;
    })).catch(err => console.error('[Red] Summarization failed:', err));
}
/**
 * Generate executive summary in background (non-blocking)
 * Called after 3rd+ AI response
 */
function generateExecutiveSummaryInBackground(conversationId, memory, chatModel) {
    memory.generateExecutiveSummary(conversationId, (prompt) => __awaiter(this, void 0, void 0, function* () {
        const response = yield (0, retry_1.invokeWithRetry)(chatModel, [{ role: 'user', content: prompt }], {
            context: 'executive summary generation',
        });
        const rawContent = response.content;
        // Extract thinking (if present) and return cleaned content
        const { cleanedContent } = (0, thinking_1.extractThinking)(rawContent);
        return cleanedContent;
    })).catch(err => console.error('[Red] Executive summary generation failed:', err));
}
