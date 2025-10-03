import { Red, RedConfig } from "../src/index";

async function main() {
	const config: RedConfig = {
		redisUrl: "redis://localhost:6379",
		vectorDbUrl: "http://localhost:8200",
		databaseUrl: "http://localhost:5432",
		defaultLlmUrl: "https://llm.redbtn.io",
		llmEndpoints: {
			default: "https://llm.redbtn.io"
		}
	};

	const red = new Red(config);
	await red.load("test-node");

	console.log("Red instance created and loaded with default LLM:", config.defaultLlmUrl);

	console.log('\n=== Testing non-streaming response ===');
	const response = await red.respond({ message: 'hello there' }, { source: { application: 'redChat' } });
	
	// Response is now the full AIMessage object
	console.log('Response text:', response.content);
	console.log('Token usage:', response.usage_metadata);
	console.log('Model used:', response.response_metadata?.model);
	console.log('Output tokens:', response.usage_metadata?.output_tokens);

	console.log('\n=== Testing streaming response ===');
	process.stdout.write('Stream: ');
	const streamResponse = await red.respond({ message: 'tell me a joke' }, { source: { application: 'redChat' }, stream: true });
	
	// Streaming response - streamResponse is an AsyncGenerator
	// It yields string chunks followed by the final AIMessage
	let chunkCount = 0;
	for await (const chunk of streamResponse) {
		if (typeof chunk === 'string') {
			// Text chunk - display with typing effect
			chunkCount++;
			const chars = chunk.split('');
			for (const char of chars) {
				process.stdout.write(char);
				await new Promise(res => setTimeout(res, 40)); // Simulate typing delay
			}
		} else {
			// Final AIMessage with complete metadata
			console.log('\n\n--- Final streaming metadata ---');
			console.log('Total chunks received:', chunkCount);
			console.log('Total tokens used:', chunk.usage_metadata?.total_tokens);
			console.log('Input tokens:', chunk.usage_metadata?.input_tokens);
			console.log('Output tokens:', chunk.usage_metadata?.output_tokens);
			console.log('Model:', chunk.response_metadata?.model);
			console.log('Generation speed:', 
				(chunk.usage_metadata?.output_tokens / (chunk.response_metadata?.eval_duration / 1_000_000_000)).toFixed(2), 
				'tokens/second');
		}
	}
}

main().catch(err => {
	console.error('Error running test:', err);
	process.exit(1);
});
