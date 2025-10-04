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

	console.log("Testing new router-based filtering...\n");

	// Test 1: Pure conversation (should skip tools entirely)
	console.log('=== Test 1: "Hi, how are you?" (CONVERSATION) ===');
	const response1 = await red.respond({ message: 'Hi, how are you?' }, { source: { application: 'redChat' } });
	console.log('Response:', response1.content.substring(0, 200) + '...');
	console.log('');

	// Test 2: Explanation (should skip tools)
	console.log('=== Test 2: "What is recursion?" (CONVERSATION) ===');
	const response2 = await red.respond({ message: 'What is recursion?' }, { source: { application: 'redChat' } });
	console.log('Response:', response2.content.substring(0, 200) + '...');
	console.log('');

	// Test 3: Current information (SHOULD use tools)
	console.log('=== Test 3: "What is the weather in San Francisco today?" (ACTION) ===');
	const response3 = await red.respond({ message: 'What is the weather in San Francisco today?' }, { source: { application: 'redChat' } });
	console.log('Response:', response3.content.substring(0, 200) + '...');
	console.log('');

	// Test 4: Streaming conversation (should skip tools)
	console.log('=== Test 4: "Tell me a joke" (CONVERSATION, streaming) ===');
	process.stdout.write('Response: ');
	const stream = await red.respond({ message: 'Tell me a joke' }, { source: { application: 'redChat' }, stream: true });
	let chunkCount = 0;
	for await (const chunk of stream) {
		if (typeof chunk === 'string') {
			chunkCount++;
			process.stdout.write(chunk);
		} else {
			console.log(`\n[Streamed ${chunkCount} chunks]`);
		}
	}
	console.log('');
}

main().catch(err => {
	console.error('Error running test:', err);
	process.exit(1);
});
