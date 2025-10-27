#!/usr/bin/env tsx
/**
 * Migration script to fix messages with null messageId values
 * 
 * This script:
 * 1. Finds all messages with null or missing messageId
 * 2. Generates unique messageIds for them
 * 3. Drops the failed index if it exists
 * 4. Creates the unique sparse index
 */

import { MongoClient } from 'mongodb';
import * as dotenv from 'dotenv';
import { resolve } from 'path';

// Try to load environment variables from multiple possible locations
dotenv.config({ path: resolve(__dirname, '../.env') });
dotenv.config({ path: resolve(__dirname, '../../webapp/.env.local') });

const MONGODB_URL = process.env.MONGODB_URI || process.env.MONGODB_URL || 'mongodb://alpha:alpha123@localhost:27017/redbtn?authSource=admin';

console.log('Using MongoDB URL:', MONGODB_URL.replace(/:[^:@]+@/, ':****@'));

async function fixNullMessageIds() {
  const client = new MongoClient(MONGODB_URL);
  
  try {
    console.log('🔌 Connecting to MongoDB...');
    await client.connect();
    console.log('✅ Connected to MongoDB');
    
    const db = client.db();
    const messages = db.collection('messages');
    
    // Step 1: Find and fix messages with null or missing messageId
    const nullMessages = await messages.find({
      $or: [
        { messageId: null },
        { messageId: { $exists: false } }
      ]
    }).toArray();
    
    console.log(`\n📊 Found ${nullMessages.length} messages with null/missing messageId`);
    
    if (nullMessages.length > 0) {
      console.log('🔧 Generating unique messageIds...\n');
      
      for (const msg of nullMessages) {
        const newMessageId = `msg_${msg.timestamp.getTime()}_${Math.random().toString(36).substring(2, 11)}`;
        await messages.updateOne(
          { _id: msg._id },
          { $set: { messageId: newMessageId } }
        );
      }
      
      console.log(`✅ Fixed ${nullMessages.length} messages with new messageIds\n`);
    }
    
    // Step 2: Find duplicate messageIds
    console.log('🔍 Checking for duplicate messageIds...');
    const duplicates = await messages.aggregate([
      {
        $match: {
          messageId: { $ne: null, $exists: true }
        }
      },
      {
        $group: {
          _id: '$messageId',
          count: { $sum: 1 },
          ids: { $push: '$_id' },
          timestamps: { $push: '$timestamp' }
        }
      },
      {
        $match: {
          count: { $gt: 1 }
        }
      }
    ]).toArray();
    
    console.log(`📊 Found ${duplicates.length} duplicate messageIds`);
    
    if (duplicates.length > 0) {
      console.log('🔧 Fixing duplicates (keeping oldest, updating newer ones)...\n');
      
      for (const dup of duplicates) {
        // Sort by timestamp to keep the oldest
        const sorted = dup.ids.map((id: any, idx: number) => ({
          id,
          timestamp: dup.timestamps[idx]
        })).sort((a: any, b: any) => a.timestamp - b.timestamp);
        
        // Keep the first (oldest), update the rest
        for (let i = 1; i < sorted.length; i++) {
          const newMessageId = `msg_${sorted[i].timestamp.getTime()}_${Math.random().toString(36).substring(2, 11)}`;
          await messages.updateOne(
            { _id: sorted[i].id },
            { $set: { messageId: newMessageId } }
          );
          console.log(`  Fixed duplicate: ${dup._id} -> ${newMessageId}`);
        }
      }
      
      console.log(`\n✅ Fixed ${duplicates.length} duplicate messageIds\n`);
    }
    
    // Drop the failed index if it exists
    console.log('🗑️  Dropping existing messageId index (if any)...');
    try {
      await messages.dropIndex('messageId_1');
      console.log('✅ Dropped old index');
    } catch (error: any) {
      if (error.codeName === 'IndexNotFound') {
        console.log('ℹ️  No existing index to drop');
      } else {
        console.log('⚠️  Error dropping index:', error.message);
      }
    }
    
    // Create the unique sparse index
    console.log('\n🔨 Creating unique sparse index on messageId...');
    await messages.createIndex(
      { messageId: 1 }, 
      { unique: true, sparse: true }
    );
    console.log('✅ Index created successfully');
    
    console.log('\n✨ Migration complete!\n');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await client.close();
  }
}

fixNullMessageIds();
