import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

// Messages
export async function createMessage(threadId: string, message: string, params?: any) {
    return await openai.beta.threads.messages.create(threadId, {
        role: 'user',
        content: message, 
        ...params // { metadata, attachments}
    })
}

export async function getMessage(threadId: string, messageId: string) {
    return await openai.beta.threads.messages.retrieve(threadId, messageId)
}

export async function editMessage(threadId: string, messageId: string, params: any) {
    // metadata only
    return await openai.beta.threads.messages.update(threadId, messageId, params)
}

export async function deleteMessage(threadId: string, messageId: string) {
    return await openai.beta.threads.messages.del(threadId, messageId)
}

export async function listMessages(threadId: string) {
    return await openai.beta.threads.messages.list(threadId)
}