import { ChatOpenAI } from "@langchain/openai";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
export declare function createOpenAIModel(): ChatOpenAI;
/**
 * Creates a Gemini chat model instance.
 * @returns A configured instance of ChatGoogleGenerativeAI.
 */
export declare function createGeminiModel(): ChatGoogleGenerativeAI;
