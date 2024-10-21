import OpenAI from "openai";
import { VectorStoreCreateParams, VectorStoreUpdateParams } from "openai/resources/beta/vector-stores/vector-stores";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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