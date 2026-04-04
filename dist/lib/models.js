"use strict";
// /lib/models.ts
//
// LLM model factory functions.
//
// IMPORTANT: createChatModel() and createWorkerModel() have been REMOVED.
// LLM endpoints are now configured via neuron configs in MongoDB.
// Use NeuronRegistry.getModel(neuronId, userId) to obtain model instances.
//
// The remaining functions (createOpenAIModel, createGeminiModel) are convenience
// factories for non-neuron use cases (e.g., direct API key access for specific providers).
Object.defineProperty(exports, "__esModule", { value: true });
exports.createOpenAIModel = createOpenAIModel;
exports.createGeminiModel = createGeminiModel;
const openai_1 = require("@langchain/openai");
const google_genai_1 = require("@langchain/google-genai");
function createOpenAIModel() {
    return new openai_1.ChatOpenAI({
        modelName: "gpt-5",
        temperature: 0.0,
        streaming: true,
        openAIApiKey: process.env.OPENAI_API_KEY,
    });
}
/**
 * Creates a Gemini chat model instance.
 * @returns A configured instance of ChatGoogleGenerativeAI.
 */
function createGeminiModel() {
    return new google_genai_1.ChatGoogleGenerativeAI({
        model: "gemini-2.5-pro",
        temperature: 0.0,
        streaming: true,
        apiKey: process.env.GOOGLE_API_KEY,
    });
}
