// /lib/models.ts

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai"
import { RedConfig } from "../index"; // Import the config type

/**
 * Creates a fast chat model instance based on the provided configuration.
 * @param config The Red configuration object.
 * @returns A configured instance of ChatOllama.
 */
export function createFastChatModel(config: RedConfig): ChatOllama {
  return new ChatOllama({
    baseUrl: config.defaultLlmUrl || 
      process.env.OLLAMA_BASE_URL || 
      "http://localhost:11434", // Use the URL from the config
    model: "gemma:2b-instruct",
    temperature: 0.0,
  });
}

export function createSmartResearchModel(config: RedConfig): ChatOllama {
  // Use the specific endpoint if available, otherwise fall back to the default
  const baseUrl = config.llmEndpoints?.['researcher'] || config.defaultLlmUrl;

  return new ChatOllama({
    baseUrl: baseUrl,
    model: "mixtral",
    temperature: 0.2,
  });
}

export function createOpenAIModel(): ChatOpenAI {
  return new ChatOpenAI({
    modelName: "gpt-4o",
    temperature: 0.0,
    streaming: true,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
}