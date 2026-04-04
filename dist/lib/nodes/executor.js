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
exports.executorNode = void 0;
/**
 * Executor Node - Processes current step in execution plan
 *
 * This node acts as the orchestrator, reading the current step from the plan
 * and setting nextGraph to route to the appropriate specialized node.
 *
 * It doesn't execute the step itself - it just determines where to route.
 * The actual execution happens in search/command/responder nodes.
 *
 * @param state The current graph state
 * @returns Updated state with routing information
 */
const executorNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    const redInstance = state.redInstance;
    const conversationId = (_a = state.options) === null || _a === void 0 ? void 0 : _a.conversationId;
    const generationId = (_b = state.options) === null || _b === void 0 ? void 0 : _b.generationId;
    const executionPlan = state.executionPlan;
    const currentStepIndex = state.currentStepIndex || 0;
    // Safety check
    if (!executionPlan || !executionPlan.steps || executionPlan.steps.length === 0) {
        yield redInstance.logger.log({
            level: 'error',
            category: 'executor',
            message: '<red>❌ No execution plan found, falling back to responder</red>',
            generationId,
            conversationId,
        });
        return {
            nextGraph: 'responder'
        };
    }
    // Check if we're past the end of the plan
    if (currentStepIndex >= executionPlan.steps.length) {
        yield redInstance.logger.log({
            level: 'warn',
            category: 'executor',
            message: `<yellow>⚠ Step index ${currentStepIndex} exceeds plan length ${executionPlan.steps.length}, ending</yellow>`,
            generationId,
            conversationId,
        });
        return {
            nextGraph: undefined // Will trigger END
        };
    }
    const currentStep = executionPlan.steps[currentStepIndex];
    yield redInstance.logger.log({
        level: 'info',
        category: 'executor',
        message: `<cyan>▶️  Executing step ${currentStepIndex + 1}/${executionPlan.steps.length}:</cyan> <bold>${currentStep.type.toUpperCase()}</bold> - ${currentStep.purpose}`,
        generationId,
        conversationId,
    });
    // Route to appropriate node based on step type
    switch (currentStep.type) {
        case 'search':
            // Store search query in toolParam for search node to use
            return {
                nextGraph: 'search',
                toolParam: currentStep.searchQuery
            };
        case 'command':
            // Store command details in state for command node
            return {
                nextGraph: 'command',
                commandDomain: currentStep.domain,
                commandDetails: currentStep.commandDetails
            };
        case 'respond':
            // Final step - generate response
            return {
                nextGraph: 'responder'
            };
        default:
            yield redInstance.logger.log({
                level: 'error',
                category: 'executor',
                message: `<red>❌ Unknown step type: ${currentStep.type}</red>`,
                generationId,
                conversationId,
            });
            // Fallback to responder
            return {
                nextGraph: 'responder'
            };
    }
});
exports.executorNode = executorNode;
