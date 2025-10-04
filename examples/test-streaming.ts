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

	console.log("Testing streaming with conversational queries...\n");

	// Test 1: Simple greeting
	console.log('=== Test 1: "Hi, how are you?" ===');
	process.stdout.write('Response: ');
	const stream1 = await red.respond({ message: 'Hi, how are you?' }, { source: { application: 'redChat' }, stream: true });
	let text1 = '';
	for await (const chunk of stream1) {
		if (typeof chunk === 'string') {
			text1 += chunk;
			process.stdout.write(chunk);
		}
	}
	console.log('\n');

	// Test 2: Explanation request
	console.log('=== Test 2: "What is recursion?" ===');
	process.stdout.write('Response: ');
	const stream2 = await red.respond({ message: 'What is recursion?' }, { source: { application: 'redChat' }, stream: true });
	let text2 = '';
	for await (const chunk of stream2) {
		if (typeof chunk === 'string') {
			text2 += chunk;
			process.stdout.write(chunk);
		}
	}
	console.log('\n');

	// Test 3: Query that SHOULD use tools
	console.log('=== Test 3: "What is the weather in San Francisco today?" ===');
	process.stdout.write('Response: ');
	const stream3 = await red.respond({ message: 'What is the weather in San Francisco today?' }, { source: { application: 'redChat' }, stream: true });
	let text3 = '';
	for await (const chunk of stream3) {
		if (typeof chunk === 'string') {
			text3 += chunk;
			process.stdout.write(chunk);
		}
	}
	console.log('\n');
}

main().catch(err => {
	console.error('Error running test:', err);
	process.exit(1);
});
