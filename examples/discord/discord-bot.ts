/**
 * @file examples/discord/discord-bot.ts
 * @description Discord bot interface for Red AI
 * 
 * This bot responds when tagged in messages, maintaining conversation context
 * and using the "[username]: [message]" format for multi-user conversations.
 * 
 * Features:
 * - Responds when bot is mentioned/tagged
 * - Maintains conversation context per Discord channel
 * - Loads up to 100 recent messages or up to token limit
 * - Formats messages as "[username]: [message]" for multi-user context
 * - Handles streaming responses with typing indicators
 * 
 * Setup:
 * 1. Install dependencies: npm install
 * 2. Create a Discord bot at https://discord.com/developers/applications
 * 3. Enable Message Content Intent in bot settings
 * 4. Set DISCORD_BOT_TOKEN environment variable
 * 5. Run: npm start
 */

import 'dotenv/config';
import { Client, GatewayIntentBits, Message, TextChannel, Partials } from 'discord.js';
import { Red, RedConfig } from '@redbtn/ai';

// Configuration
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const TYPING_INDICATOR_INTERVAL = 5000; // Send typing every 5 seconds
const DISCORD_MAX_MESSAGE_LENGTH = 2000; // Discord's hard limit
const CHUNK_SIZE = 1950; // Leave some buffer for safety

/**
 * Split text at the nearest newline or whitespace before the limit
 * Priority: newline first, then any whitespace, then force split
 */
function splitAtWhitespace(text: string, maxLength: number): [string, string] {
  if (text.length <= maxLength) {
    return [text, ''];
  }
  
  // First, try to find the last newline before maxLength
  let splitIndex = -1;
  for (let i = maxLength - 1; i >= 0; i--) {
    if (text[i] === '\n') {
      splitIndex = i;
      break;
    }
  }
  
  // If no newline found, look for any whitespace
  if (splitIndex === -1) {
    for (let i = maxLength - 1; i >= 0; i--) {
      if (/\s/.test(text[i])) {
        splitIndex = i;
        break;
      }
    }
  }
  
  // If still no whitespace found, force split at maxLength
  if (splitIndex === -1) {
    splitIndex = maxLength;
  }
  
  const firstPart = text.slice(0, splitIndex).trim();
  const remainder = text.slice(splitIndex).trim();
  
  return [firstPart, remainder];
}

/**
 * Handle incoming Discord messages
 */

if (!DISCORD_BOT_TOKEN) {
  console.error('❌ DISCORD_BOT_TOKEN environment variable is required');
  process.exit(1);
}

// Red AI Configuration
const redConfig: RedConfig = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  vectorDbUrl: process.env.VECTOR_DB_URL || "http://localhost:8024",
  databaseUrl: process.env.DATABASE_URL || "mongodb://localhost:27017/red-webapp",
  chatLlmUrl: process.env.CHAT_LLM_URL || "http://192.168.1.4:11434",
  workLlmUrl: process.env.WORK_LLM_URL || "http://192.168.1.3:11434"
};

// Initialize Red AI
const red = new Red(redConfig);

// Initialize Discord client
const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel, // Required for DM channels
    Partials.Message,  // Required for DM messages
  ]
});

/**
 * Convert Discord channel ID to conversation ID
 */
function channelToConversationId(channelId: string): string {
  return `discord_${channelId}`;
}

/**
 * Process a message and generate AI response
 */
async function handleMessage(message: Message): Promise<void> {
  // Ignore bot messages
  if (message.author.bot) return;

  const channel = message.channel;
  const isDM = channel.isDMBased();

  console.log(`\n🔍 Message received - isDM: ${isDM}, author: ${message.author.username}`);

  // In channels: only respond when bot is mentioned
  // In DMs: always respond
  if (!isDM && !message.mentions.has(discordClient.user!.id)) {
    console.log(`   ⏭️  Skipping (channel message without mention)`);
    return;
  }

  // For text channels, ensure it's a proper TextChannel
  if (!isDM && !(channel instanceof TextChannel)) {
    console.log(`   ⏭️  Skipping (not a text channel)`);
    return;
  }

  const conversationId = isDM 
    ? `discord_dm_${message.author.id}` 
    : channelToConversationId(channel.id);
  const username = message.author.username;
  
  // Extract message content (remove bot mention in channels)
  const rawContent = isDM 
    ? message.content.trim()
    : message.content.replace(/<@!?\d+>/g, '').trim();
  
  if (!rawContent) {
    const response = 'Please include a message!';
    isDM ? await (channel as any).send(response) : await message.reply(response);
    return;
  }

  const locationInfo = isDM ? 'DM' : `#${(channel as TextChannel).name}`;
  console.log(`\n📨 Message from ${username} in ${locationInfo}`);
  console.log(`   Content: ${rawContent}`);

  try {
    // Format the current message with username
    // Don't build context manually - let Red AI's context system handle it
    const formattedMessage = `[${username}]: ${rawContent}`;

    console.log(`   Sending message to Red AI...`);

    // Start typing indicator
    let typingInterval: NodeJS.Timeout | null = null;
    const startTyping = () => {
      if ('sendTyping' in channel) {
        channel.sendTyping().catch((err: any) => console.error('Typing error:', err));
      }
    };
    
    startTyping(); // Initial typing indicator
    typingInterval = setInterval(startTyping, TYPING_INDICATOR_INTERVAL);

    try {
      // Get streaming response from Red AI
      const stream = await red.respond(
        { message: formattedMessage },
        {
          stream: true,
          conversationId,
          source: {
            application: 'redChat',
            device: 'web'
          }
        }
      );

      let fullResponse = '';
      let messageChunk = '';
      let sentMessages: Message[] = [];

      // Process streaming response
      for await (const chunk of stream) {
        if (typeof chunk === 'string') {
          fullResponse += chunk;
          messageChunk += chunk;

          // Send in chunks if getting too long
          while (messageChunk.length >= CHUNK_SIZE) {
            const [toSend, remainder] = splitAtWhitespace(messageChunk, CHUNK_SIZE);
            messageChunk = remainder;
            
            if (toSend.length === 0) break; // Safety check
            
            // In DMs, always use channel.send (no replies)
            // In channels, reply to first message, then use channel.send
            const sentMsg = sentMessages.length === 0 && !isDM
              ? await message.reply(toSend)
              : await (message.channel as any).send(toSend);
            
            sentMessages.push(sentMsg);
          }
        } else if (chunk.usage_metadata) {
          // Final metadata received
          console.log(`   ✓ Generated response (${chunk.usage_metadata.total_tokens} tokens)`);
        }
      }

      // Send any remaining content
      if (messageChunk.trim().length > 0) {
        // Split remaining content if it's too long
        let remaining = messageChunk.trim();
        while (remaining.length > 0) {
          const [toSend, remainder] = splitAtWhitespace(remaining, CHUNK_SIZE);
          remaining = remainder;
          
          if (toSend.length === 0) break; // Safety check
          
          // In DMs, always use channel.send (no replies)
          // In channels, reply to first message, then use channel.send
          const sentMsg = sentMessages.length === 0 && !isDM
            ? await message.reply(toSend)
            : await (message.channel as any).send(toSend);
          
          sentMessages.push(sentMsg);
        }
      }

      // If no messages were sent (empty response), send a fallback
      if (sentMessages.length === 0 && fullResponse.trim().length === 0) {
        const fallbackMsg = 'I received your message but had no response to generate.';
        isDM ? await (channel as any).send(fallbackMsg) : await message.reply(fallbackMsg);
      }

      console.log(`   📤 Sent ${sentMessages.length} message(s)`);

    } finally {
      // Stop typing indicator
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }

  } catch (error) {
    console.error('Error processing message:', error);
    const errorMsg = 'Sorry, I encountered an error processing your message. Please try again.';
    const sendError = isDM 
      ? (channel as any).send(errorMsg)
      : message.reply(errorMsg);
    await sendError.catch(console.error);
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('🤖 Red AI Discord Bot Starting...\n');

  // Initialize Red AI
  console.log('Initializing Red AI...');
  await red.load('discord-bot');
  console.log('✓ Red AI initialized\n');

  // Set up Discord event handlers
  discordClient.on('clientReady', () => {
    console.log(`✓ Discord bot logged in as ${discordClient.user?.tag}`);
    console.log(`📡 Monitoring ${discordClient.guilds.cache.size} server(s)`);
    console.log(`💬 DM support: enabled`);
    console.log('\n🎯 Bot is ready!');
    console.log('   - Mention me in a channel to chat');
    console.log('   - Send me a DM to chat privately\n');
  });

  discordClient.on('messageCreate', async (message: any) => {
    // Debug: Log all incoming messages
    const channelType = message.channel.isDMBased() ? 'DM' : 'Channel';
    console.log(`\n📥 Message received [${channelType}] from ${message.author.tag}: "${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}"`);
    
    await handleMessage(message).catch((error: any) => {
      console.error('Error handling message:', error);
    });
  });

  discordClient.on('error', (error: any) => {
    console.error('Discord client error:', error);
  });

  // Login to Discord
  console.log('Connecting to Discord...');
  await discordClient.login(DISCORD_BOT_TOKEN);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Shutting down...');
    
    discordClient.destroy();
    console.log('✓ Discord client disconnected');
    
    await red.shutdown();
    console.log('✓ Red AI unloaded');
    
    console.log('👋 Goodbye!\n');
    process.exit(0);
  });
}

// Run the bot
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
