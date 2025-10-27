# JSON Extraction for Router

**Status**: ✅ Complete

## Problem

The router LLM sometimes returns responses with extra text around the JSON object:
- "Sure, here's the routing decision: {...}"  
- "```json\n{...}\n```"
- "{...}\n\nThis is my reasoning."

The previous implementation would fail to parse these responses, falling back to CHAT routing.

## Solution

Created `src/lib/utils/json-extractor.ts` with robust JSON extraction that:

### Extraction Strategies

1. **Direct Parse** - Try parsing the entire response as-is (fastest)
2. **Brace Matching** - Find balanced `{...}` pairs and try parsing each
3. **Code Block Extraction** - Extract from markdown code blocks (```json...```)

### Features

- **Multiple Attempts**: Tries all strategies until valid JSON found
- **Shape Validation**: Can validate expected keys exist (e.g., `action`, `reasoning`)
- **Detailed Results**: Returns extraction metadata (strategy used, raw text, extracted text)
- **Logging Friendly**: Logs full raw response + extraction details

## Implementation

### New File: `src/lib/utils/json-extractor.ts`

**Main Functions**:
- `extractJSON<T>(text, expectedShape?)` - Simple extraction, returns data or null
- `extractJSONWithDetails<T>(text, expectedShape?)` - Returns detailed result object

**Extraction Result**:
```typescript
{
  success: boolean;
  data: T | null;
  rawText: string;           // Full LLM response
  extractedText?: string;    // Just the JSON part
  strategy?: 'direct' | 'braces' | 'codeblock';
  error?: string;
}
```

### Updated: `src/lib/nodes/router.ts`

**Changes**:
1. Import `extractJSONWithDetails` from json-extractor
2. Log full raw response before extraction
3. Use `extractJSONWithDetails()` instead of `JSON.parse()`
4. Log extraction success with strategy used
5. Log whether extra text was present (`hadExtraText`)
6. Log extraction failure with error details

**New Logging**:
```typescript
// Raw response logged first
await redInstance.logger.log({
  message: '📋 Raw LLM response received',
  metadata: { rawResponse, responseLength }
});

// Extraction success
await redInstance.logger.log({
  message: '✓ Routing decision extracted successfully (strategy: braces)',
  metadata: { 
    decision,
    extractionStrategy: 'braces',
    extractedText,
    hadExtraText: true  // Shows if extra text was stripped
  }
});

// Extraction failure
await redInstance.logger.log({
  message: '✗ Failed to extract routing decision from response',
  metadata: { 
    rawResponse,
    extractionError: 'No valid JSON object found',
    attemptedStrategies: ['direct', 'braces', 'codeblock']
  }
});
```

## Test Results

Tested with various edge cases (`examples/test-json-extractor.ts`):

✅ **Test 1**: Clean JSON → Direct parse
✅ **Test 2**: Text before JSON → Brace extraction  
✅ **Test 3**: Text after JSON → Brace extraction
✅ **Test 4**: JSON in code block → Brace extraction (works even without code block strategy)
✅ **Test 6**: No JSON → Properly fails with error message
✅ **Test 7**: Nested objects → Handles complex JSON structures

## Usage Example

```typescript
// In any node that needs to parse LLM JSON responses
import { extractJSONWithDetails } from '../utils/json-extractor';

const result = extractJSONWithDetails<MyType>(
  llmResponse,
  { requiredKey: undefined }  // Optional shape validation
);

if (result.success) {
  // Log full details
  console.log('Extraction strategy:', result.strategy);
  console.log('Had extra text:', result.extractedText !== result.rawText);
  
  // Use the data
  const data = result.data;
} else {
  // Log failure with full context
  console.error('Extraction failed:', result.error);
  console.error('Raw response:', result.rawText);
}
```

## Benefits

1. **Robust**: Handles LLMs that add explanatory text
2. **Transparent**: Always logs full raw response for debugging
3. **Informative**: Shows which extraction strategy worked
4. **Reusable**: Can be used in any node that parses LLM JSON
5. **Backward Compatible**: Still works with clean JSON responses

## Future Use Cases

Can be used in other nodes that expect JSON from LLMs:
- Query optimizer in search node
- Command validator 
- Any structured output from LLMs

## Example Logs

**Before** (would fail):
```
✗ Failed to parse routing decision as JSON
Raw: "Sure! Here's the routing: {...}"
```

**After** (now succeeds):
```
📋 Raw LLM response received
Raw: "Sure! Here's the routing: {...}"

✓ Routing decision extracted successfully (strategy: braces)
Decision: { action: 'WEB_SEARCH', ... }
Had extra text: true
```

## Testing

Run the test suite:
```bash
npx tsx examples/test-json-extractor.ts
```

All tests pass with proper extraction and error handling.
