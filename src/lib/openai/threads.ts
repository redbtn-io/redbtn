import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Threads
export async function createThread(params?: any) {
    let {metadata, messages, assistant_id, tool_resources} = params as any
    if (!metadata) metadata = {}
    if (!tool_resources) tool_resources = {}
    if (messages && assistant_id) return openai.beta.threads.createAndRunStream({
        assistant_id,
        metadata, 
        thread: { messages, tool_resources }
    })
    const createParams = { 
        metadata, 
        ...(messages && { messages }), 
        ...(tool_resources && { tool_resources }),
        ...params
    };
    return await openai.beta.threads.create(createParams)
}

export async function getThread(id: string) {
    return await openai.beta.threads.retrieve(id)
}

export async function editThread(id: string, params: any) {
    return await openai.beta.threads.update(id, params)
}

export async function deleteThread(id: string) {
    return await openai.beta.threads.del(id)
}