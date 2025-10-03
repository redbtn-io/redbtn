/**
 * Example client for Red AI OpenAI-compatible API
 * This shows how to use the API from TypeScript/JavaScript code
 */

const BASE_URL = process.env.RED_API_URL || 'http://localhost:3000';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: 'assistant';
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Send a non-streaming chat completion request
 */
async function chatCompletion(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number } = {}
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || 'Red',
      messages,
      stream: false,
      temperature: options.temperature,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Send a streaming chat completion request
 */
async function* chatCompletionStream(
  messages: ChatMessage[],
  options: { model?: string; temperature?: number } = {}
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: options.model || 'Red',
      messages,
      stream: true,
      temperature: options.temperature,
    }),
  });

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          return;
        }

        try {
          const chunk = JSON.parse(data);
          const content = chunk.choices[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  }
}

/**
 * List available models
 */
async function listModels() {
  const response = await fetch(`${BASE_URL}/v1/models`);
  return response.json();
}

// Example usage
async function main() {
  console.log('🤖 Red AI Client Example\n');

  // Example 1: Non-streaming chat
  console.log('1️⃣  Non-streaming chat:');
  const response = await chatCompletion([
    { role: 'user', content: 'Explain TypeScript in one sentence' }
  ]);
  console.log(`Response: ${response.choices[0].message.content}`);
  console.log(`Tokens: ${response.usage.total_tokens} (${response.usage.prompt_tokens} in, ${response.usage.completion_tokens} out)\n`);

  // Example 2: Streaming chat
  console.log('2️⃣  Streaming chat:');
  process.stdout.write('Response: ');
  for await (const chunk of chatCompletionStream([
    { role: 'user', content: 'Count from 1 to 5' }
  ])) {
    process.stdout.write(chunk);
  }
  console.log('\n');

  // Example 3: List models
  console.log('3️⃣  Available models:');
  const models = await listModels();
  console.log(JSON.stringify(models, null, 2));
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

// Export for use in other modules
export { chatCompletion, chatCompletionStream, listModels };
export type { ChatMessage, ChatCompletionRequest, ChatCompletionResponse };
