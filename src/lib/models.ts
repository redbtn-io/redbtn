// /lib/models.ts

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai"
import { RedConfig } from "../index"; // Import the config type
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

/**
 * Creates a fast chat model instance based on the provided configuration.
 * Supports DeepSeek-R1 and other Ollama models.
 * @param config The Red configuration object.
 * @returns A configured instance of ChatOllama.
 */
export function createLocalModel(config: RedConfig): ChatOllama {
  // Allow model override via environment variable
  const modelName = process.env.OLLAMA_MODEL || "Red";
  
  return new ChatOllama({
    baseUrl: config.defaultLlmUrl || 
      process.env.OLLAMA_BASE_URL || 
      "http://localhost:11434", // Use the URL from the config
    model: modelName,
    temperature: 0.0,
    // NOTE: DeepSeek-R1 reasoning models can take 2-5 minutes to respond
    // If using remote Ollama (llm.redbtn.io), ensure reverse proxy timeout is set to at least 300s
    // Example nginx config: proxy_read_timeout 300s;
  });
}

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