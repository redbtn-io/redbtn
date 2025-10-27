/**
 * Test cases for JSON extraction utility
 * Run with: npx tsx examples/test-json-extractor.ts
 */

import { extractJSON, extractJSONWithDetails } from '../src/lib/utils/json-extractor';

console.log('🧪 Testing JSON Extractor\n');

// Test case 1: Clean JSON
const test1 = `{"action": "CHAT", "reasoning": "This is a test"}`;
console.log('Test 1: Clean JSON');
console.log('Input:', test1);
const result1 = extractJSONWithDetails(test1);
console.log('Result:', result1.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result1.strategy);
console.log('Data:', result1.data);
console.log();

// Test case 2: JSON with text before
const test2 = `Sure, here's the routing decision:
{"action": "WEB_SEARCH", "reasoning": "User needs current info", "searchQuery": "latest AI news"}`;
console.log('Test 2: JSON with text before');
console.log('Input:', test2.substring(0, 60) + '...');
const result2 = extractJSONWithDetails(test2);
console.log('Result:', result2.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result2.strategy);
console.log('Data:', result2.data);
console.log('Had extra text:', result2.extractedText !== test2.trim());
console.log();

// Test case 3: JSON with text after
const test3 = `{"action": "SCRAPE_URL", "reasoning": "URL provided", "url": "https://example.com"}

This is the routing decision based on the user's query.`;
console.log('Test 3: JSON with text after');
console.log('Input:', test3.substring(0, 60) + '...');
const result3 = extractJSONWithDetails(test3);
console.log('Result:', result3.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result3.strategy);
console.log('Data:', result3.data);
console.log();

// Test case 4: JSON in code block
const test4 = `Here's the routing decision:

\`\`\`json
{
  "action": "SYSTEM_COMMAND",
  "reasoning": "User wants to execute a command",
  "command": "ls -la"
}
\`\`\`

Hope this helps!`;
console.log('Test 4: JSON in code block');
console.log('Input:', test4.substring(0, 60) + '...');
const result4 = extractJSONWithDetails(test4);
console.log('Result:', result4.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result4.strategy);
console.log('Data:', result4.data);
console.log();

// Test case 5: Multiple JSON objects (should get first valid one)
const test5 = `Invalid: {"incomplete": true
Valid: {"action": "CHAT", "reasoning": "Simple response"}
Another: {"action": "WEB_SEARCH"}`;
console.log('Test 5: Multiple JSON objects');
console.log('Input:', test5.substring(0, 60) + '...');
const result5 = extractJSONWithDetails(test5, { action: undefined, reasoning: undefined });
console.log('Result:', result5.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result5.strategy);
console.log('Data:', result5.data);
console.log();

// Test case 6: No valid JSON
const test6 = `This is just plain text without any JSON at all.`;
console.log('Test 6: No valid JSON');
console.log('Input:', test6);
const result6 = extractJSONWithDetails(test6);
console.log('Result:', result6.success ? '✓ PASS (unexpected)' : '✗ Expected failure');
console.log('Error:', result6.error);
console.log();

// Test case 7: Nested objects
const test7 = `The router analyzed the query and determined:

{"action": "WEB_SEARCH", "reasoning": "User needs current information", "searchQuery": "weather today", "metadata": {"confidence": 0.95}}

This should work with nested objects.`;
console.log('Test 7: Nested objects');
console.log('Input:', test7.substring(0, 60) + '...');
const result7 = extractJSONWithDetails(test7);
console.log('Result:', result7.success ? '✓ PASS' : '✗ FAIL');
console.log('Strategy:', result7.strategy);
console.log('Data:', JSON.stringify(result7.data, null, 2));
console.log();

console.log('🎉 All tests completed!');
