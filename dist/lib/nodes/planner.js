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
exports.plannerNode = void 0;
const retry_1 = require("../utils/retry");
const node_helpers_1 = require("../utils/node-helpers");
const json_extractor_1 = require("../utils/json-extractor");
function normalizeExecutionPlan(raw) {
    if (!raw)
        return null;
    let candidate = raw;
    // Unwrap known wrappers
    const unwrap = (value) => {
        if (!value || typeof value !== 'object')
            return value;
        if ('plan' in value)
            return value.plan;
        if ('executionPlan' in value)
            return value.executionPlan;
        if ('data' in value)
            return value.data;
        if ('response' in value)
            return value.response;
        return value;
    };
    candidate = unwrap(candidate);
    // Handle arrays (take first element)
    if (Array.isArray(candidate)) {
        candidate = candidate[0];
    }
    // Handle string response (extract JSON)
    if (typeof candidate === 'string') {
        const parsed = (0, json_extractor_1.extractJSON)(candidate);
        if (!parsed) {
            return null;
        }
        candidate = parsed;
    }
    candidate = unwrap(candidate);
    if (!candidate || typeof candidate !== 'object') {
        return null;
    }
    const rawSteps = candidate.steps || candidate.plan || candidate.planSteps;
    if (!Array.isArray(rawSteps)) {
        return null;
    }
    const normalizeStepType = (value) => {
        const normalized = (value || '').toLowerCase();
        if (normalized.includes('search'))
            return 'search';
        if (normalized.includes('command') || normalized.includes('action'))
            return 'command';
        return 'respond';
    };
    const steps = rawSteps
        .map((step, index) => {
        if (!step || typeof step !== 'object') {
            return null;
        }
        const type = normalizeStepType(step.type || step.action || step.step);
        const purpose = step.purpose || step.reason || step.description || `Step ${index + 1}`;
        const normalizedStep = {
            type,
            purpose,
        };
        if (type === 'search') {
            normalizedStep.searchQuery = step.searchQuery || step.query || step.prompt;
        }
        if (type === 'command') {
            normalizedStep.domain = step.domain;
            normalizedStep.commandDetails = step.commandDetails || step.details || step.command;
        }
        return normalizedStep;
    })
        .filter((step) => step !== null);
    if (!steps.length) {
        return null;
    }
    const reasoning = candidate.reasoning || candidate.planReasoning || candidate.strategy || 'No reasoning provided';
    return {
        reasoning,
        steps
    };
}
/**
 * JSON schema for planning decisions (structured output)
 */
const planningDecisionSchema = {
    type: 'object',
    properties: {
        reasoning: {
            type: 'string',
            description: 'Overall strategy: why this sequence of steps will resolve the user query'
        },
        steps: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        enum: ['search', 'command', 'respond'],
                        description: 'Type of step to execute'
                    },
                    purpose: {
                        type: 'string',
                        description: 'Why this specific step is needed in the sequence'
                    },
                    searchQuery: {
                        type: 'string',
                        description: 'For search steps: optimized search query with date context for time-sensitive queries'
                    },
                    domain: {
                        type: 'string',
                        enum: ['system', 'api', 'home'],
                        description: 'For command steps: which domain the command belongs to'
                    },
                    commandDetails: {
                        type: 'string',
                        description: 'For command steps: specific command details, parameters, or context'
                    }
                },
                required: ['type', 'purpose']
            },
            minItems: 1,
            description: 'Ordered sequence of steps. Must end with respond step.'
        }
    },
    required: ['reasoning', 'steps'],
    additionalProperties: false
};
/**
 * Planner Node - Analyzes query and creates execution plan
 *
 * Replaces the router's single-step decision with multi-step planning.
 * Can return plans like:
 * - [respond] - Simple direct answer
 * - [search, respond] - Need current data first
 * - [command, respond] - Execute command then respond
 * - [search, command, respond] - Complex multi-tool workflow
 *
 * @param state The current graph state
 * @returns Updated state with execution plan
 */
const plannerNode = (state) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d;
    const query = ((_a = state.messages[state.messages.length - 1]) === null || _a === void 0 ? void 0 : _a.content) || ((_b = state.query) === null || _b === void 0 ? void 0 : _b.message) || '';
    const redInstance = state.redInstance;
    const conversationId = (_c = state.options) === null || _c === void 0 ? void 0 : _c.conversationId;
    const generationId = (_d = state.options) === null || _d === void 0 ? void 0 : _d.generationId;
    const messageId = state.messageId;
    const currentNodeNumber = state.nodeNumber || 1; // Planner is node 1
    const nextNodeNumber = currentNodeNumber + 1;
    // Check if this is a replanning request
    const isReplanning = state.requestReplan === true;
    const replanReason = state.replanReason || '';
    const replannedCount = state.replannedCount || 0;
    if (isReplanning) {
        yield redInstance.logger.log({
            level: 'info',
            category: 'planner',
            message: `<yellow>🔄 Re-planning (attempt ${replannedCount + 1}/3):</yellow> ${replanReason}`,
            generationId,
            conversationId,
        });
    }
    // Publish planning status to frontend
    if (messageId) {
        yield redInstance.messageQueue.publishStatus(messageId, {
            action: 'planning',
            description: isReplanning ? 'Re-planning approach' : 'Planning execution steps'
        });
    }
    // Log planner start
    yield redInstance.logger.log({
        level: 'info',
        category: 'planner',
        message: `<cyan>🗺️  Planning execution:</cyan> <dim>${query.substring(0, 80)}${query.length > 80 ? '...' : ''}</dim>`,
        generationId,
        conversationId,
    });
    const contextSummary = state.contextSummary || '';
    const contextPreface = contextSummary ? `Conversation Context:\n${contextSummary}\n\n` : '';
    try {
        const currentDate = new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        // Build replanning context if applicable
        let replanContext = '';
        if (isReplanning) {
            replanContext = `

REPLANNING CONTEXT:
This is replanning attempt ${replannedCount + 1}/3.
Reason for replanning: ${replanReason}
Previous execution results are in the conversation history.
Create a NEW plan that addresses the issue.`;
        }
        // Use structured output to force valid planning JSON
        const modelWithJson = redInstance.workerModel.withStructuredOutput({
            schema: planningDecisionSchema
        });
        const response = yield (0, retry_1.invokeWithRetry)(modelWithJson, [
            {
                role: 'system',
                content: `${(0, node_helpers_1.getNodeSystemPrefix)(currentNodeNumber, 'Planner')}

Your job is to analyze the user's query and create an EXECUTION PLAN - an ordered sequence of steps to resolve it.

Available step types:
1. SEARCH - Web research for current/real-time information
2. COMMAND - Execute system commands, API calls, or smart home control
3. RESPOND - Generate final answer to user (MUST be the last step)

PLANNING RULES:
✅ Simple queries → [{ type: 'respond', purpose: '...' }]
✅ Need current data → [{ type: 'search', ... }, { type: 'respond', ... }]
✅ Need to execute action → [{ type: 'command', ... }, { type: 'respond', ... }]
✅ Complex tasks → [{ type: 'search', ... }, { type: 'command', ... }, { type: 'respond', ... }]
✅ MUST end with 'respond' step
✅ Include 'purpose' for each step explaining why it's needed

WHEN TO USE SEARCH:
- Current events, breaking news, sports scores, weather
- Time-sensitive queries ("today", "tonight", "latest", "current")
- Stock prices, cryptocurrency, real-time data
- User explicitly asks to "search" or "look up"
- You don't have the information in your training data

WHEN TO USE COMMAND:
- System: File operations, shell commands, local tasks
- API: External services, webhooks, third-party integrations
- Home: Smart home devices, IoT control, automation

WHEN TO USE RESPOND ONLY:
- Greetings, casual conversation
- Explanations of concepts you know
- Historical facts, established knowledge
- Math, logic problems
- Questions about yourself

SEARCH STEP REQUIREMENTS:
- Must include 'searchQuery' field with optimized search terms
- Include date context for time-sensitive queries
- Example: "Chiefs tonight?" → searchQuery: "Kansas City Chiefs game score November 11 2025"

COMMAND STEP REQUIREMENTS:
- Must include 'domain' field: 'system', 'api', or 'home'
- Must include 'commandDetails' with specific context

Current date: ${currentDate}${replanContext}

CRITICAL: Every plan MUST end with a 'respond' step. This is not optional.`
            },
            {
                role: 'user',
                content: `${contextPreface}User query: ${query}`
            }
        ], { context: 'planner decision' });
        // Parse and validate the plan
        let executionPlan;
        const normalizedPlan = normalizeExecutionPlan(response);
        if (!normalizedPlan) {
            throw new Error(`Invalid planning response format: ${JSON.stringify(response)}`);
        }
        executionPlan = normalizedPlan;
        // Validate plan has steps
        if (!executionPlan.steps || executionPlan.steps.length === 0) {
            throw new Error('Plan must contain at least one step');
        }
        // Validate plan ends with respond
        const lastStep = executionPlan.steps[executionPlan.steps.length - 1];
        if (lastStep.type !== 'respond') {
            // Auto-fix: add respond step if missing
            executionPlan.steps.push({
                type: 'respond',
                purpose: 'Provide final answer to user'
            });
            yield redInstance.logger.log({
                level: 'warn',
                category: 'planner',
                message: '<yellow>⚠ Plan missing respond step, auto-added</yellow>',
                generationId,
                conversationId,
            });
        }
        // Log the execution plan
        const stepsList = executionPlan.steps
            .map((step, i) => {
            let details = '';
            if (step.type === 'search' && step.searchQuery) {
                details = ` → "${step.searchQuery}"`;
            }
            else if (step.type === 'command' && step.domain) {
                details = ` → ${step.domain}`;
            }
            return `  ${i + 1}. ${step.type.toUpperCase()}${details} - ${step.purpose}`;
        })
            .join('\n');
        yield redInstance.logger.log({
            level: 'info',
            category: 'planner',
            message: `<green>📋 Execution Plan (${executionPlan.steps.length} steps):</green>\n<dim>${stepsList}</dim>\n<cyan>Strategy:</cyan> <dim>${executionPlan.reasoning}</dim>`,
            generationId,
            conversationId,
        });
        // Store plan in database for debugging
        yield redInstance.logger.log({
            level: 'debug',
            category: 'planner',
            message: 'Full execution plan',
            generationId,
            conversationId,
            metadata: {
                plan: executionPlan,
                replannedCount
            }
        });
        return {
            executionPlan,
            currentStepIndex: 0, // Start at first step
            nodeNumber: nextNodeNumber,
            requestReplan: false, // Clear replan flag
            replanReason: undefined,
            replannedCount: isReplanning ? replannedCount + 1 : replannedCount
        };
    }
    catch (error) {
        yield redInstance.logger.log({
            level: 'error',
            category: 'planner',
            message: `<red>❌ Planning failed:</red> ${error instanceof Error ? error.message : String(error)}`,
            generationId,
            conversationId,
        });
        // Fallback: create simple respond-only plan
        return {
            executionPlan: {
                reasoning: 'Fallback plan due to planning error',
                steps: [{
                        type: 'respond',
                        purpose: 'Provide direct answer'
                    }]
            },
            currentStepIndex: 0,
            nodeNumber: nextNodeNumber,
            requestReplan: false,
            replanReason: undefined
        };
    }
});
exports.plannerNode = plannerNode;
