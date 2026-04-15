/**
 * Native Tool Registry
 *
 * Native tools run in-process with direct access to the RunPublisher
 * for real-time streaming. No MCP protocol overhead, no timeouts.
 *
 * The native path is checked BEFORE the MCP path in toolExecutor.
 * Results are returned in MCP-compatible format so no special handling
 * is required downstream.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export interface NativeToolContext {
  /** RunPublisher instance for streaming events — null if not in a run context */
  publisher: AnyObject | null;
  /** Current graph state */
  state: AnyObject;
  /** Current run ID */
  runId: string | null;
  /** Graph node ID that invoked the tool */
  nodeId: string | null;
  /** Unique tool execution ID — use with publisher.toolProgress(toolId, ...) */
  toolId: string | null;
  /** AbortSignal for cancellation support */
  abortSignal: AbortSignal | null;
  /** Callback for real-time chunk interception (used by stream parsers) */
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  /**
   * Resolved connection credentials from UserConnection.
   * Present when the tool step config specifies connectionId or providerId.
   * Contains auth headers and raw credentials for authenticated API calls.
   */
  credentials?: {
    type: 'api_key' | 'bearer' | 'basic' | 'custom';
    headers: Record<string, string>;
    providerId: string;
    connectionId: string;
    accountInfo?: { email?: string; name?: string; externalId?: string };
  } | null;
}

export interface NativeMcpResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export interface NativeToolDefinition {
  /** Human-readable description shown in the UI */
  description: string;
  /** JSON Schema for input validation */
  inputSchema: AnyObject;
  /** Source server name for grouping in UI */
  server?: string;
  /** The actual tool implementation */
  handler: (args: AnyObject, context: NativeToolContext) => Promise<NativeMcpResult>;
}

export interface NativeToolInfo {
  name: string;
  description: string;
  inputSchema: AnyObject;
  server: string;
}

export class NativeToolRegistry {
  private tools: Map<string, NativeToolDefinition> = new Map();

  /**
   * Register a native tool definition.
   * The name must match what graphs use in their toolName step config.
   */
  register(name: string, definition: NativeToolDefinition): void {
    this.tools.set(name, definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): NativeToolDefinition | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered native tools in MCP-compatible format.
   */
  listTools(): NativeToolInfo[] {
    return Array.from(this.tools.entries()).map(([name, def]) => ({
      name,
      description: def.description,
      inputSchema: def.inputSchema,
      server: def.server || 'system',
    }));
  }

  /**
   * Invoke a native tool handler with the given args and context.
   */
  async callTool(name: string, args: AnyObject, context: NativeToolContext): Promise<NativeMcpResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Native tool not found: ${name}`);
    return tool.handler(args, context);
  }
}

// =============================================================================
// Singleton
// =============================================================================

let _instance: NativeToolRegistry | null = null;

/**
 * Get the shared NativeToolRegistry singleton.
 * Lazily registers all built-in native tools on first call.
 */
export function getNativeRegistry(): NativeToolRegistry {
  if (!_instance) {
    _instance = new NativeToolRegistry();
    registerBuiltinTools(_instance);
  }
  return _instance;
}

/**
 * Register all built-in native tools.
 * Add new tools here as they are implemented.
 */
function registerBuiltinTools(registry: NativeToolRegistry): void {
  try {
    // SSH Shell — requires ssh2 package
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sshShell = require('./native/ssh-shell.js');
    registry.register('ssh_shell', sshShell);
    console.log('[NativeRegistry] Registered built-in tool: ssh_shell');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register ssh_shell:', msg);
  }

  try {
    // Invoke Function — async RedRun function invocation with polling
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const invokeFunction = require('./native/invoke-function.js');
    registry.register('invoke_function', invokeFunction);
    console.log('[NativeRegistry] Registered built-in tool: invoke_function');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register invoke_function:', msg);
  }

  try {
    // SSH Copy — SFTP file transfer with Knowledge Library integration
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sshCopy = require('./native/ssh-copy.js');
    registry.register('ssh_copy', sshCopy);
    console.log('[NativeRegistry] Registered built-in tool: ssh_copy');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register ssh_copy:', msg);
  }

  try {
    // Library Write — programmatic document ingestion into Knowledge Libraries
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const libraryWrite = require('./native/library-write.js');
    registry.register('library_write', libraryWrite);
    console.log('[NativeRegistry] Registered built-in tool: library_write');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register library_write:', msg);
  }

  try {
    // Store Message — persist messages to Redis + MongoDB (ported from context-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const storeMessage = require('./native/store-message.js');
    registry.register('store_message', storeMessage);
    console.log('[NativeRegistry] Registered built-in tool: store_message');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register store_message:', msg);
  }

  try {
    // Get Context — build formatted conversation context for LLM (ported from context-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getContext = require('./native/get-context.js');
    registry.register('get_context_history', getContext);
    console.log('[NativeRegistry] Registered built-in tool: get_context_history');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_context_history:', msg);
  }

  try {
    // Search Documents — semantic vector search (ported from rag-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const searchDocuments = require('./native/search-documents.js');
    registry.register('search_documents', searchDocuments);
    console.log('[NativeRegistry] Registered built-in tool: search_documents');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register search_documents:', msg);
  }

  try {
    // Add Document — chunk, embed, store in ChromaDB (ported from rag-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addDocument = require('./native/add-document.js');
    registry.register('add_document', addDocument);
    console.log('[NativeRegistry] Registered built-in tool: add_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register add_document:', msg);
  }

  try {
    // Fetch URL — HTTP requests with full REST support (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fetchUrl = require('./native/fetch-url.js');
    registry.register('fetch_url', fetchUrl);
    console.log('[NativeRegistry] Registered built-in tool: fetch_url');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register fetch_url:', msg);
  }

  try {
    // Push Message — send messages to conversation streams in real-time
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pushMessage = require('./native/push-message.js');
    registry.register('push_message', pushMessage);
    console.log('[NativeRegistry] Registered built-in tool: push_message');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register push_message:', msg);
  }

  try {
    // Upload Attachment — upload files to the attachment store and publish to run stream
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const uploadAttachment = require('./native/upload-attachment.js');
    registry.register('upload_attachment', uploadAttachment);
    console.log('[NativeRegistry] Registered built-in tool: upload_attachment');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register upload_attachment:', msg);
  }

  try {
    // TTS Synthesize — Google Gemini TTS, returns PCM audio as base64
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ttsSynthesize = require('./native/tts-synthesize.js');
    registry.register('tts_synthesize', ttsSynthesize.default || ttsSynthesize);
    console.log('[NativeRegistry] Registered built-in tool: tts_synthesize');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register tts_synthesize:', msg);
  }
}
