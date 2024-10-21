import OpenAI from "openai";
import { AssistantCreateParams } from "openai/resources/beta/assistants";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
// Assistants
export async function createAssistant(params?: AssistantCreateParams) {
    if (!params) params = { model: 'gpt-3.5-turbo-1106' }
    return await openai.beta.assistants.create(params)
}

export async function editAssistant(id: string, params: AssistantCreateParams) {
    return await openai.beta.assistants.update(id, params)
}

export async function getAssistant(id: string) {
    return await openai.beta.assistants.retrieve(id)
}

export async function deleteAssistant(id: string) {
    return await openai.beta.assistants.del(id)
}