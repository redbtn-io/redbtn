#!/usr/bin/env tsx
/**
 * Cleanup script to remove duplicate messages from Redis cache
 * 
 * This script deduplicates messages based on their messageId.
 * Run this if you notice duplicate messages in conversation history.
 * 
 * Usage:
 *   tsx scripts/cleanup-redis-duplicates.ts [conversationId]
 *   
 *   If no conversationId is provided, it will clean all conversations.
 */

import { Redis } from 'ioredis';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.local' });

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

interface ConversationMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  toolExecutions?: any[];
}

async function deduplicateConversation(conversationId: string): Promise<number> {
  const key = `conversations:${conversationId}:messages`;
  
  // Get all messages
  const messagesJson = await redis.lrange(key, 0, -1);
  
  if (messagesJson.length === 0) {
    console.log(`  No messages found for ${conversationId}`);
    return 0;
  }
  
  // Track seen message IDs
  const seen = new Set<string>();
  const uniqueMessages: string[] = [];
  let duplicateCount = 0;
  
  for (const msgJson of messagesJson) {
    try {
      const msg: ConversationMessage = JSON.parse(msgJson);
      
      if (!seen.has(msg.id)) {
        seen.add(msg.id);
        uniqueMessages.push(msgJson);
      } else {
        duplicateCount++;
        console.log(`    Removing duplicate: ${msg.id} (${msg.role})`);
      }
    } catch (error) {
      console.warn(`    Skipping invalid message JSON: ${msgJson.substring(0, 50)}...`);
    }
  }
  
  // If we found duplicates, replace the list
  if (duplicateCount > 0) {
    await redis.del(key);
    if (uniqueMessages.length > 0) {
      await redis.rpush(key, ...uniqueMessages);
    }
    console.log(`  ✓ Removed ${duplicateCount} duplicate(s) from ${conversationId} (${messagesJson.length} → ${uniqueMessages.length})`);
  } else {
    console.log(`  ✓ No duplicates found in ${conversationId} (${messagesJson.length} messages)`);
  }
  
  return duplicateCount;
}

async function getAllConversationKeys(): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  
  do {
    const [nextCursor, foundKeys] = await redis.scan(
      cursor,
      'MATCH',
      'conversations:*:messages',
      'COUNT',
      100
    );
    cursor = nextCursor;
    keys.push(...foundKeys);
  } while (cursor !== '0');
  
  return keys;
}

async function main() {
  const args = process.argv.slice(2);
  
  console.log('🧹 Redis Message Deduplication Tool\n');
  
  try {
    if (args.length > 0) {
      // Clean specific conversation
      const conversationId = args[0];
      console.log(`Cleaning conversation: ${conversationId}\n`);
      await deduplicateConversation(conversationId);
    } else {
      // Clean all conversations
      console.log('Scanning for all conversations...\n');
      const keys = await getAllConversationKeys();
      
      if (keys.length === 0) {
        console.log('No conversations found in Redis.');
        return;
      }
      
      console.log(`Found ${keys.length} conversation(s)\n`);
      
      let totalDuplicates = 0;
      for (const key of keys) {
        // Extract conversationId from key
        const conversationId = key.replace('conversations:', '').replace(':messages', '');
        const duplicates = await deduplicateConversation(conversationId);
        totalDuplicates += duplicates;
      }
      
      console.log(`\n✅ Complete! Removed ${totalDuplicates} total duplicate(s) from ${keys.length} conversation(s)`);
    }
  } catch (error) {
    console.error('❌ Error:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

main();
