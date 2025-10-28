# Discord Bot Example

A full-featured Discord bot interface for Red AI that responds when mentioned in channels, maintaining conversation context and handling multi-user conversations.

## Features

- ✅ **Tag-based activation** - Bot responds only when mentioned/tagged
- ✅ **Per-channel conversations** - Each Discord channel maintains its own conversation context
- ✅ **Context management** - Loads up to 100 recent messages or token limit
- ✅ **Multi-user format** - Messages formatted as `[username]: [message]` for context
- ✅ **Streaming responses** - Real-time message streaming with typing indicators
- ✅ **Chunk handling** - Automatically splits long responses into multiple messages
- ✅ **Graceful shutdown** - Handles CTRL+C cleanly

## Setup

### 1. Install Dependencies

```bash
cd examples/discord
npm install
```

### 2. Create Discord Bot

1. Go to https://discord.com/developers/applications
2. Click "New Application" and give it a name
3. Go to the "Bot" tab and click "Add Bot"
4. **Important:** Enable "Message Content Intent" under "Privileged Gateway Intents"
5. Copy the bot token (click "Reset Token" if needed)

### 3. Invite Bot to Server

1. Go to the "OAuth2" → "URL Generator" tab
2. Select scopes:
   - ✅ `bot`
3. Select bot permissions:
   - ✅ Read Messages/View Channels
   - ✅ Send Messages
   - ✅ Read Message History
4. Copy the generated URL and open it in your browser
5. Select your server and authorize the bot

### 4. Configure Environment

Create a `.env` file in the `examples/discord` directory:

```bash
# Discord Configuration
DISCORD_BOT_TOKEN=your_discord_bot_token_here

# Red AI Configuration (optional - uses defaults if not set)
REDIS_URL=redis://localhost:6379
VECTOR_DB_URL=http://localhost:8200
DATABASE_URL=mongodb://localhost:27017/red-webapp
CHAT_LLM_URL=http://192.168.1.4:11434
WORK_LLM_URL=http://192.168.1.3:11434
```

### 5. Start MCP Servers

The bot requires MCP servers to be running for conversation management (run from the main library directory):

```bash
cd ../..
npm run mcp:start
```

### 6. Run the Bot

```bash
# Using npm script
npm start

# Or using the convenience script
./start-discord-bot.sh
```

You should see:

```
🤖 Red AI Discord Bot Starting...

Initializing Red AI...
✓ Red AI initialized (12 MCP tools)

Connecting to Discord...
✓ Discord bot logged in as YourBot#1234
📡 Monitoring 1 server(s)

🎯 Bot is ready! Mention me in a channel to chat.
```

## Usage

### In Channels (Mention Required)

In server channels, mention the bot to get a response:

```
@YourBot Hello! How are you?
```

The bot will:
1. Load conversation history for that channel
2. Build context from recent messages
3. Generate a response
4. Stream it back to the channel

### In Direct Messages (Always Responds)

In DMs, the bot will respond to every message without requiring a mention:

```
User: Hey, can you help me with something?
Bot: Of course! What do you need help with?

User: What's 2 + 2?
Bot: 2 + 2 equals 4.
```

### Multi-User Conversations

The bot understands multi-user context in channels. For example:

```
[Alice]: @YourBot What's the weather like?
[YourBot]: I don't have access to current weather data, but...

[Bob]: @YourBot What did Alice just ask?
[YourBot]: Alice asked about the weather.
```

Messages are formatted as `[username]: [message]` so the AI can track who said what.

### Long Responses

If the response is longer than Discord's 2000 character limit, it will be automatically split into multiple messages.

## How It Works

### Conversation ID Mapping

Each Discord channel or DM gets a unique conversation ID:

**Channels:**
```typescript
conversationId = `discord_${channelId}`
```

**Direct Messages:**
```typescript
conversationId = `discord_dm_${userId}`
```

This ensures each channel and each DM conversation maintains its own separate context.

### Context Building

When the bot receives a message in a channel, it:

1. **Fetches stored history** - Gets last 50 messages from MongoDB via MCP context server
2. **Fetches Discord history** - Gets up to 100 recent Discord messages from the channel
3. **Combines context** - Merges both sources, removing duplicates
4. **Formats messages** - Converts to `[username]: [message]` format
5. **Sends to AI** - Passes full context to Red AI for response generation

For DMs, the bot uses stored conversation history from MongoDB only (no Discord channel history fetching).

### Token Management

The bot respects token limits:
- **Max Discord messages**: 100 (configurable via `MAX_MESSAGES_CONTEXT`)
- **Max context tokens**: 30,000 (configurable via `MAX_CONTEXT_TOKENS`)
- Red AI's context server automatically trims history to fit within limits

### Streaming & Typing

1. **Typing indicator** starts when processing begins
2. **Refreshed every 5 seconds** while generating
3. **Chunks sent immediately** as they arrive from the AI
4. **Typing stops** when response is complete

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | ✅ Yes | - | Your Discord bot token |
| `REDIS_URL` | No | `redis://localhost:6379` | Redis connection URL |
| `VECTOR_DB_URL` | No | `http://localhost:8200` | Vector database URL |
| `DATABASE_URL` | No | `mongodb://localhost:27017/red-webapp` | MongoDB URL |
| `CHAT_LLM_URL` | No | `http://192.168.1.4:11434` | Primary LLM endpoint |
| `WORK_LLM_URL` | No | `http://192.168.1.3:11434` | Worker LLM endpoint |

### Code Constants

```typescript
const MAX_MESSAGES_CONTEXT = 100;        // Max Discord messages to load
const MAX_CONTEXT_TOKENS = 30000;        // Max tokens for context
const TYPING_INDICATOR_INTERVAL = 5000;  // Typing refresh interval (ms)
const CHUNK_SIZE = 1900;                 // Discord message chunk size
```

## Troubleshooting

### Bot doesn't respond when mentioned

1. **Check Message Content Intent** - Must be enabled in Discord Developer Portal
2. **Check permissions** - Bot needs "Read Messages" and "Send Messages"
3. **Check bot is online** - Should show as "Online" in server member list
4. **Check console logs** - Look for error messages in terminal

### "MCP server registration failed" error

Make sure MCP servers are running:

```bash
npm run mcp:start
```

Verify they're running:

```bash
ps aux | grep mcp
```

### Bot responds but messages are slow

- Check LLM server performance (Ollama/OpenAI)
- Reduce `MAX_MESSAGES_CONTEXT` if loading too much history
- Use faster model for `CHAT_LLM_URL`

### Bot shows "typing" forever

This usually means the AI generation failed or is stuck:

1. Check Red AI console logs for errors
2. Restart the bot (CTRL+C and restart)
3. Check MCP context server is responding

### Context not persisting across restarts

This is expected - context is loaded from:
1. MongoDB (persistent, managed by MCP context server)
2. Discord channel history (always available)

If MongoDB has no history, the bot will load from Discord on first run.

## Advanced Usage

### Custom System Prompts

Modify the bot to inject system prompts:

```typescript
const fullMessage = `System: You are a helpful Discord assistant.

${context}
${formattedMessage}`;
```

### Reaction-based Features

Add reactions to messages for feedback:

```typescript
await message.react('✅'); // Success
await message.react('❌'); // Error
```

### Private Conversations

The bot works in DMs too! Just message it directly.

```typescript
// In handleMessage function, check if it's a DM
if (message.channel.isDMBased()) {
  // Handle DM-specific logic
}
```

### Multiple Bots

Run multiple bot instances with different personalities:

```bash
# Terminal 1 - Friendly bot
DISCORD_BOT_TOKEN=token1 npx tsx examples/discord-bot.ts

# Terminal 2 - Technical bot  
DISCORD_BOT_TOKEN=token2 npx tsx examples/discord-bot.ts
```

## Architecture

```
Discord Message
      ↓
   (mentions bot?)
      ↓
Fetch Channel Context (100 msgs)
      ↓
Get Stored History (MongoDB via MCP)
      ↓
Format as [username]: [message]
      ↓
Red AI (streaming response)
      ↓
Discord Channel (chunked messages)
```

## Files

- **`discord-bot.ts`** - Main bot implementation
- **`DISCORD-BOT.md`** - This documentation

## Dependencies

- `discord.js` - Discord API client
- `@redbtn/ai` - Red AI library
- `dotenv` - Environment variable loading

## License

ISC License - see the [LICENSE](../LICENSE) file for details.

---

**Built with ❤️ by the Red Button team**
