#!/bin/bash
# Quick start script for Discord bot example

echo "🤖 Red AI Discord Bot - Quick Start"
echo ""

# Change to the discord directory if not already there
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Paths
AI_DIR="$(cd ../.. && pwd)"
TAR_NAME="redbtn-ai-0.0.1.tgz"

# Load environment variables from .env or .env.local if they exist
if [ -f ".env.local" ]; then
    echo "📄 Loading environment from .env.local"
    set -a
    source .env.local
    set +a
elif [ -f ".env" ]; then
    echo "📄 Loading environment from .env"
    set -a
    source .env
    set +a
fi

# Build and pack AI package
echo "📦 Building AI package..."
cd "$AI_DIR"
rm -f "$TAR_NAME"  # Remove old tarball first
npm run build
npm pack

# Install package into discord example
echo "📦 Installing AI package..."
cd "$SCRIPT_DIR"
npm install "$AI_DIR/$TAR_NAME"

# Check for DISCORD_BOT_TOKEN
if [ -z "$DISCORD_BOT_TOKEN" ]; then
    echo "⚠️  DISCORD_BOT_TOKEN environment variable not set!"
    echo ""
    echo "Please set it in your .env or .env.local file, or export it:"
    echo "  export DISCORD_BOT_TOKEN=your_token_here"
    echo ""
    echo "Get your token from: https://discord.com/developers/applications"
    echo ""
    exit 1
fi

# Check if Redis is running
echo "🔍 Checking Redis..."
REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
if ! redis-cli -u "$REDIS_URL" ping > /dev/null 2>&1; then
    echo "⚠️  Redis is not running at $REDIS_URL"
    echo "   Please start Redis: sudo systemctl start redis"
    echo ""
    exit 1
fi
echo "✓ Redis is running"

# Check if MongoDB is running
echo "🔍 Checking MongoDB..."
DATABASE_URL="${DATABASE_URL:-mongodb://localhost:27017/red-webapp}"
MONGO_HOST=$(echo "$DATABASE_URL" | sed -E 's|mongodb://([^:/]+).*|\1|')
MONGO_PORT=$(echo "$DATABASE_URL" | sed -E 's|mongodb://[^:]+:([0-9]+).*|\1|')
MONGO_PORT="${MONGO_PORT:-27017}"

if ! timeout 2 bash -c "echo > /dev/tcp/$MONGO_HOST/$MONGO_PORT" 2>/dev/null; then
    echo "⚠️  MongoDB is not running at $MONGO_HOST:$MONGO_PORT"
    echo "   Please start MongoDB: sudo systemctl start mongod"
    echo ""
    exit 1
fi
echo "✓ MongoDB is running"

# Check if Vector DB (ChromaDB) is running
echo "🔍 Checking Vector DB..."
VECTOR_DB_URL="${VECTOR_DB_URL:-http://localhost:8024}"
if ! curl -s "$VECTOR_DB_URL/api/v1/heartbeat" > /dev/null 2>&1; then
    echo "⚠️  Vector DB (ChromaDB) is not running at $VECTOR_DB_URL"
    echo "   Please start ChromaDB"
    echo ""
    exit 1
fi
echo "✓ Vector DB is running"

# Check if MCP servers are running (from main library)
echo "🔍 Checking MCP servers..."
MCP_PID=$(pgrep -f "mcp-servers" | head -1)
if [ -n "$MCP_PID" ]; then
    echo "⚠️  MCP servers already running with old code (PID: $MCP_PID)"
    echo "📡 Stopping old MCP servers..."
    kill $MCP_PID
    sleep 2
    echo "✓ Old MCP servers stopped"
fi

echo "📡 Starting MCP servers with updated code..."
# Start MCP servers from the main library directory
(cd ../.. && npm run mcp:start > /tmp/mcp-servers.log 2>&1) &
MCP_PID=$!

# Wait for MCP servers to initialize
echo "   Waiting for MCP servers to start..."
sleep 3

# Check if MCP servers started successfully
if ! pgrep -f "mcp-servers" > /dev/null; then
    echo "❌ Failed to start MCP servers. Check /tmp/mcp-servers.log for details"
    exit 1
fi

echo "✓ MCP servers started (PID: $MCP_PID, logs: /tmp/mcp-servers.log)"

echo ""
echo "🚀 Starting Discord bot..."
echo "   Press Ctrl+C to stop"
echo ""

# Trap SIGINT (Ctrl+C) to clean up
trap cleanup INT

cleanup() {
    echo ""
    echo "🛑 Shutting down Discord bot..."
    exit 0
}

npm start
