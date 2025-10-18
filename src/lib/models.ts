// /lib/models.ts

import { ChatOllama } from "@langchain/ollama";
import { ChatOpenAI } from "@langchain/openai"
import { RedConfig } from "../index"; // Import the config type
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

/**
 * Creates a chat model instance based on the provided configuration.
 * This is the primary model used for chat interactions.
 * Supports DeepSeek-R1 and other Ollama models.
 * @param config The Red configuration object.
 * @returns A configured instance of ChatOllama.
 */
export function createChatModel(config: RedConfig): ChatOllama {
  // Allow model override via environment variable
  const modelName = process.env.OLLAMA_MODEL || "Red";
  
  return new ChatOllama({
    baseUrl: config.chatLlmUrl || 
      process.env.CHAT_LLM_URL || 
      process.env.OLLAMA_BASE_URL || 
      "http://localhost:11434",
    model: modelName,
    temperature: 0.0,
    keepAlive: -1,
  });
}

/**
 * Creates a worker model instance based on the provided configuration.
 * This model is used for background tasks and tool execution.
 * @param config The Red configuration object.
 * @returns A configured instance of ChatOllama.
 */
export function createWorkerModel(config: RedConfig): ChatOllama {
  // Allow model override via environment variable
  const modelName = process.env.OLLAMA_WORKER_MODEL || process.env.OLLAMA_MODEL || "Red";
  
  return new ChatOllama({
    baseUrl: config.workLlmUrl || 
      process.env.WORK_LLM_URL || 
      "http://localhost:11434",
    model: modelName,
    temperature: 0.0,
    keepAlive: -1,
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