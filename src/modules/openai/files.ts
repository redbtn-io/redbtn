import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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