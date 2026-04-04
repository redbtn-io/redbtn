/**
 * push_message -- native tool for sending messages to conversations
 *
 * Pushes a message to a conversation stream in real-time.
 * The message appears immediately in the chat UI and is persisted to MongoDB.
 *
 * Can target the current run's conversation (default) or any conversation by ID.
 */
import type { NativeToolDefinition } from '../native-registry';
declare const definition: NativeToolDefinition;
export = definition;
