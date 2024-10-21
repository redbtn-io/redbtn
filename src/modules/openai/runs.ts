import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

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
        tool_outputs: outputs,
        stream: true
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