import { Red, RedConfig } from "../src/index";
import { redGraph } from "../src/lib/graphs/red";

async function debugStreaming() {
	const config: RedConfig = {
		redisUrl: "redis://localhost:6379",
		vectorDbUrl: "http://localhost:8200",
		databaseUrl: "http://localhost:5432",
		defaultLlmUrl: "https://llm.redbtn.io",
	};

	const red = new Red(config);
	await red.load("debug-node");

	const initialState = {
		query: { message: 'hello' },
		options: { source: { application: 'redChat' as const }, stream: true },
		redInstance: red,
	};

	console.log("=== Debugging Stream Events ===\n");
	const stream = redGraph.streamEvents(initialState, { version: "v1" });
	
	for await (const event of stream) {
		if (event.event.includes('llm') || event.event.includes('chat')) {
			console.log(`\nEvent: ${event.event}`);
			console.log('Data keys:', Object.keys(event.data || {}));
			if (event.data?.output) {
				console.log('Output type:', typeof event.data.output);
				console.log('Output keys:', Object.keys(event.data.output));
			}
		}
	}
}

debugStreaming().catch(console.error);
