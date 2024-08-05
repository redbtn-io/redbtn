import OpenAI from "openai";
import { AssistantCreateParams } from "openai/resources/beta/assistants";
import { ThreadCreateParams } from "openai/resources/beta/threads/threads";
import { VectorStoreCreateParams, VectorStoreUpdateParams } from "openai/resources/beta/vector-stores/vector-stores";

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

// Threads
export async function createThread(params?: ThreadCreation) {
    let {metadata, messages, assistant_id } = params as ThreadCreation
    if (!metadata) metadata = {}
    if (messages && assistant_id) return openai.beta.threads.createAndRunStream({
        assistant_id,
        metadata, 
        thread: { messages }
    })
    const createParams = messages ? { messages, metadata } : { metadata }
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

// Runs
export async function runThread(assistant_id: string, thread: string, params?: any) {
    return await openai.beta.threads.runs.create(thread, {
        assistant_id,
        stream: true,
        ...params
    })
}

export async function submitTools(threadId: string, runId:string, outputs: any[]) {
    return await openai.beta.threads.runs.submitToolOutputs(threadId, runId, {
        tool_outputs: outputs
    })
}

export async function getRun(threadId: string, runId: string) {
    return await openai.beta.threads.runs.retrieve(threadId, runId)
}

export async function editRun(threadId: string, runId: string, params: any) {
    return await openai.beta.threads.runs.update(threadId, runId, params)
}

export async function cancelRun(threadId: string, runId: string) {
    return await openai.beta.threads.runs.cancel(threadId, runId)
}

export async function listRuns(threadId: string) {
    return await openai.beta.threads.runs.list(threadId)
}

// Files
export async function uploadFile(file: File) {
    return await openai.files.create({ file, purpose: 'assistants' })
}

export async function getFile(id: string) {
    return await openai.files.retrieve(id)
}

export async function readFile(id: string) {
    return await openai.files.content(id)
}

export async function deleteFile(id: string) {
    return await openai.files.del(id)
}

export async function listFiles() {
    return await openai.files.list()
}

// Vectors
export async function createVector(params: VectorStoreCreateParams) {
    return await openai.beta.vectorStores.create(params)
}

export async function getVector(id: string) {
    return await openai.beta.vectorStores.retrieve(id)
}

export async function editVector(id: string, params: VectorStoreUpdateParams) {
    return await openai.beta.vectorStores.update(id, params)
}

export async function deleteVector(id: string) {
    return await openai.beta.vectorStores.del(id)
}

export async function listVectors() {
    return await openai.beta.vectorStores.list()
}

// Vector Files
export async function addVectorFile(vector_id: string, file: string) {
    return await openai.beta.vectorStores.files.create(vector_id, {file_id: file})
}

export async function listVectorFiles(id: string) {
    return await openai.beta.vectorStores.files.list(id)
}

export async function getVectorFile(id: string, fileId: string) {
    return await openai.beta.vectorStores.files.retrieve(id, fileId)
}

export async function deleteVectorFile(id: string, fileId: string) {
    return await openai.beta.vectorStores.files.del(id, fileId)
}

// Vector Batches

export async function createBatch(id: string, file_ids: string[]) {
    return await openai.beta.vectorStores.fileBatches.create(id, {file_ids})
}

export async function getBatch(id: string, batchId: string) {
    return await openai.beta.vectorStores.fileBatches.retrieve(id, batchId)
}

export async function listBatches(id: string, batchId: string) {
    return await openai.beta.vectorStores.fileBatches.listFiles(id, batchId)
}

export async function deleteBatch(id: string, batchId: string) {
    return await openai.beta.vectorStores.fileBatches.cancel(id, batchId)
}


interface ThreadCreation extends ThreadCreateParams {
    assistant_id?: string
}