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

import { ChatOpenAI } from "@langchain/openai"
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

export function createOpenAIModel(): ChatOpenAI {
  return new ChatOpenAI({
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
export function createGeminiModel(): ChatGoogleGenerativeAI {
  return new ChatGoogleGenerativeAI({
    model: "gemini-2.5-pro",
    temperature: 0.0,
    streaming: true,
    apiKey: process.env.GOOGLE_API_KEY,
  });
}
