import { createAssistant, deleteAssistant, editAssistant, getAssistant } from "./openai/assistants"
import { deleteFile, getFile, listFiles, readFile, uploadFile } from "./openai/files"
import { createMessage, deleteMessage, editMessage, getMessage, listMessages } from "./openai/messages"
import RealtimeAI from "./openai/realtime"
import { cancelRun, editRun, getRun, listRuns, runThread, submitTools } from "./openai/runs"
import { createThread, deleteThread, editThread, getThread } from "./openai/threads"
import { addVectorFile, createBatch, createVector, deleteBatch, deleteVector, deleteVectorFile, editVector, getBatch, getVector, getVectorFile, listBatches, listVectorFiles, listVectors } from "./openai/vectors"
import { createVoice } from "./openai/voice"

export const Assistant = {
    addVectorFile, cancelRun, createAssistant, createBatch, createMessage, createThread, createVector, createVoice, deleteAssistant, deleteBatch, deleteFile, deleteMessage, deleteThread, deleteVector, deleteVectorFile, editAssistant, editMessage, editRun, editThread, editVector, getAssistant, getBatch, getFile, getMessage, getRun, getThread, getVector, getVectorFile, listBatches, listFiles, listMessages, listRuns, listVectorFiles, listVectors, readFile, runThread, submitTools, uploadFile, RealtimeAI
}

