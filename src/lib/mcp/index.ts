/**
 * MCP (Model Context Protocol) over Redis
 * 
 * A Redis-based implementation of the Model Context Protocol that allows
 * tools to run as independent processes and communicate via Redis pub/sub
 * using JSON-RPC 2.0.
 */

export * from './types';
export * from './server';
export * from './client';
export * from './registry';
export * from './servers/web';
export * from './servers/system';
export * from './servers/rag';
export * from './servers/context';
export * from './event-publisher';

// Legacy exports for backward compatibility
export { WebServer as WebSearchServer } from './servers/web';
export { SystemServer as SystemCommandServer } from './servers/system';
