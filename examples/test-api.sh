#!/bin/bash

# Red AI API Server Test Script
# This script tests both streaming and non-streaming endpoints

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "🧪 Testing Red AI API Server"
echo "================================"
echo ""

# Test 1: Health check
echo "1️⃣  Testing health endpoint..."
HEALTH=$(curl -s "${BASE_URL}/health")
echo "Response: $HEALTH"
echo ""

# Test 2: Models endpoint
echo "2️⃣  Testing models endpoint..."
curl -s "${BASE_URL}/v1/models" | jq .
echo ""

# Test 3: Non-streaming chat completion
echo "3️⃣  Testing non-streaming chat completion..."
curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Red",
    "messages": [
      {"role": "user", "content": "Say hello in one sentence"}
    ],
    "stream": false
  }' | jq .
echo ""

# Test 4: Streaming chat completion
echo "4️⃣  Testing streaming chat completion..."
echo "Note: Streaming output will show Server-Sent Events format"
curl -s -X POST "${BASE_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Red",
    "messages": [
      {"role": "user", "content": "Count to 5"}
    ],
    "stream": true
  }'
echo ""
echo ""

echo "✅ Tests complete!"
echo ""
echo "💡 Tips:"
echo "  - Make sure Ollama is running: ollama serve"
echo "  - Set LLM_URL if Ollama is on a different port"
echo "  - Use 'npm run server' to start the Red AI server"
