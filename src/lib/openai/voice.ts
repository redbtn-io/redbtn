import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

type Voice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer"

// Voice

export async function createVoice(model: string = "tts-1", 
    voice: Voice = "alloy", input: string, params?: any) {
        const speech = await openai.audio.speech.create({
            model, voice, input, 
        })
        return speech
}