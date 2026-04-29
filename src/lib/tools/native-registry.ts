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

  // ─── Voice pack (TOOL-HANDOFF.md §4.5) ────────────────────────────────────
  try {
    // Synthesize Speech — consolidated TTS (Kokoro default + Gemini fallback)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const synthesizeSpeech = require('./native/synthesize-speech.js');
    registry.register('synthesize_speech', synthesizeSpeech.default || synthesizeSpeech);
    console.log('[NativeRegistry] Registered built-in tool: synthesize_speech');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register synthesize_speech:', msg);
  }

  try {
    // Transcribe Audio — Whisper STT proxy (base64 OR audioUrl input)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const transcribeAudio = require('./native/transcribe-audio.js');
    registry.register('transcribe_audio', transcribeAudio.default || transcribeAudio);
    console.log('[NativeRegistry] Registered built-in tool: transcribe_audio');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register transcribe_audio:', msg);
  }

  try {
    // TTS Synthesize — DEPRECATED alias for synthesize_speech (provider=gemini).
    // Kept registered for one engine version so existing graphs keep working.
    // Removed in the follow-up PR.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ttsSynthesize = require('./native/tts-synthesize.js');
    registry.register('tts_synthesize', ttsSynthesize.default || ttsSynthesize);
    console.log('[NativeRegistry] Registered built-in tool: tts_synthesize (alias for synthesize_speech)');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register tts_synthesize:', msg);
  }

  try {
    // Get Recent Runs — read recent runEvents archive entries as a context source
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getRecentRuns = require('./native/get-recent-runs.js');
    registry.register('get_recent_runs', getRecentRuns);
    console.log('[NativeRegistry] Registered built-in tool: get_recent_runs');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_recent_runs:', msg);
  }

  try {
    // Web Search — Google Custom Search API (ported from web-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const webSearch = require('./native/web-search.js');
    registry.register('web_search', webSearch.default || webSearch);
    console.log('[NativeRegistry] Registered built-in tool: web_search');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register web_search:', msg);
  }

  try {
    // Scrape URL — fetch + smart-extract main readable content (ported from web-sse.ts)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const scrapeUrl = require('./native/scrape-url.js');
    registry.register('scrape_url', scrapeUrl.default || scrapeUrl);
    console.log('[NativeRegistry] Registered built-in tool: scrape_url');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register scrape_url:', msg);
  }

  // ─── Global-state pack (TOOL-HANDOFF.md §4.2) ─────────────────────────────
  try {
    // Get Global State — read a single namespace value
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getGlobalState = require('./native/get-global-state.js');
    registry.register('get_global_state', getGlobalState.default || getGlobalState);
    console.log('[NativeRegistry] Registered built-in tool: get_global_state');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_global_state:', msg);
  }

  try {
    // Set Global State — write a single namespace value (with optional TTL)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const setGlobalState = require('./native/set-global-state.js');
    registry.register('set_global_state', setGlobalState.default || setGlobalState);
    console.log('[NativeRegistry] Registered built-in tool: set_global_state');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register set_global_state:', msg);
  }

  try {
    // Delete Global State — delete a single namespace key
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const deleteGlobalState = require('./native/delete-global-state.js');
    registry.register('delete_global_state', deleteGlobalState.default || deleteGlobalState);
    console.log('[NativeRegistry] Registered built-in tool: delete_global_state');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register delete_global_state:', msg);
  }

  try {
    // List Global State — return all key/value pairs in a namespace
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listGlobalState = require('./native/list-global-state.js');
    registry.register('list_global_state', listGlobalState.default || listGlobalState);
    console.log('[NativeRegistry] Registered built-in tool: list_global_state');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_global_state:', msg);
  }

  try {
    // List Namespaces — list every namespace the caller can access
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listNamespaces = require('./native/list-namespaces.js');
    registry.register('list_namespaces', listNamespaces.default || listNamespaces);
    console.log('[NativeRegistry] Registered built-in tool: list_namespaces');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_namespaces:', msg);
  }

  try {
    // Delete Namespace — delete an entire namespace and all keys (owner-only)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const deleteNamespace = require('./native/delete-namespace.js');
    registry.register('delete_namespace', deleteNamespace.default || deleteNamespace);
    console.log('[NativeRegistry] Registered built-in tool: delete_namespace');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register delete_namespace:', msg);
  }

  // ─── Conversation pack (TOOL-HANDOFF.md §4.3) ─────────────────────────────
  try {
    // Create Conversation — POST /api/v1/conversations
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createConversation = require('./native/create-conversation.js');
    registry.register('create_conversation', createConversation.default || createConversation);
    console.log('[NativeRegistry] Registered built-in tool: create_conversation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register create_conversation:', msg);
  }

  try {
    // List Conversations — GET /api/v1/conversations
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listConversations = require('./native/list-conversations.js');
    registry.register('list_conversations', listConversations.default || listConversations);
    console.log('[NativeRegistry] Registered built-in tool: list_conversations');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_conversations:', msg);
  }

  try {
    // Get Conversation — GET /api/v1/conversations/:id
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getConversation = require('./native/get-conversation.js');
    registry.register('get_conversation', getConversation.default || getConversation);
    console.log('[NativeRegistry] Registered built-in tool: get_conversation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_conversation:', msg);
  }

  try {
    // Get Messages — GET /api/v1/conversations/:id/messages (replaces MCP get_messages)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getMessages = require('./native/get-messages.js');
    registry.register('get_messages', getMessages.default || getMessages);
    console.log('[NativeRegistry] Registered built-in tool: get_messages');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_messages:', msg);
  }

  try {
    // Get Conversation Metadata — projection from GET /api/v1/conversations/:id
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getConversationMetadata = require('./native/get-conversation-metadata.js');
    registry.register(
      'get_conversation_metadata',
      getConversationMetadata.default || getConversationMetadata,
    );
    console.log('[NativeRegistry] Registered built-in tool: get_conversation_metadata');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_conversation_metadata:', msg);
  }

  try {
    // Get Conversation Summary — GET /api/v1/conversations/:id/summary
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getConversationSummary = require('./native/get-conversation-summary.js');
    registry.register(
      'get_conversation_summary',
      getConversationSummary.default || getConversationSummary,
    );
    console.log('[NativeRegistry] Registered built-in tool: get_conversation_summary');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_conversation_summary:', msg);
  }

  try {
    // Set Conversation Title — PATCH /api/v1/conversations/:id { title }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const setConversationTitle = require('./native/set-conversation-title.js');
    registry.register(
      'set_conversation_title',
      setConversationTitle.default || setConversationTitle,
    );
    console.log('[NativeRegistry] Registered built-in tool: set_conversation_title');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register set_conversation_title:', msg);
  }

  try {
    // Delete Conversation — PATCH (archive) or DELETE (hard) /api/v1/conversations/:id
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const deleteConversation = require('./native/delete-conversation.js');
    registry.register('delete_conversation', deleteConversation.default || deleteConversation);
    console.log('[NativeRegistry] Registered built-in tool: delete_conversation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register delete_conversation:', msg);
  }

  try {
    // List Threads — GET /api/v1/conversations/:id/threads
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listThreads = require('./native/list-threads.js');
    registry.register('list_threads', listThreads.default || listThreads);
    console.log('[NativeRegistry] Registered built-in tool: list_threads');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_threads:', msg);
  }

  try {
    // Create Thread — POST /api/v1/conversations/:id/threads (+ optional first message)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createThread = require('./native/create-thread.js');
    registry.register('create_thread', createThread.default || createThread);
    console.log('[NativeRegistry] Registered built-in tool: create_thread');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register create_thread:', msg);
  }

  try {
    // List Participants — GET /api/v1/conversations/:id/participants
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listParticipants = require('./native/list-participants.js');
    registry.register('list_participants', listParticipants.default || listParticipants);
    console.log('[NativeRegistry] Registered built-in tool: list_participants');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_participants:', msg);
  }

  try {
    // Add Participant — POST /api/v1/conversations/:id/participants by userId
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const addParticipant = require('./native/add-participant.js');
    registry.register('add_participant', addParticipant.default || addParticipant);
    console.log('[NativeRegistry] Registered built-in tool: add_participant');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register add_participant:', msg);
  }

  // ─── Library pack (TOOL-HANDOFF.md §4.4) ──────────────────────────────────
  // `add_document` and `search_documents` are already registered above (the
  // existing rag-sse ports). The pack adds 12 net-new tools and consolidates
  // `library_write` into `add_document` (which now accepts content + fileBase64).
  try {
    // Search All Libraries — fan-out semantic search across every accessible library
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const searchAllLibraries = require('./native/search-all-libraries.js');
    registry.register(
      'search_all_libraries',
      searchAllLibraries.default || searchAllLibraries,
    );
    console.log('[NativeRegistry] Registered built-in tool: search_all_libraries');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register search_all_libraries:', msg);
  }

  try {
    // List Libraries — GET /api/v1/libraries
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listLibraries = require('./native/list-libraries.js');
    registry.register('list_libraries', listLibraries.default || listLibraries);
    console.log('[NativeRegistry] Registered built-in tool: list_libraries');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_libraries:', msg);
  }

  try {
    // Create Library — POST /api/v1/libraries
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createLibrary = require('./native/create-library.js');
    registry.register('create_library', createLibrary.default || createLibrary);
    console.log('[NativeRegistry] Registered built-in tool: create_library');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register create_library:', msg);
  }

  try {
    // Update Library — PATCH /api/v1/libraries/:libraryId
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const updateLibrary = require('./native/update-library.js');
    registry.register('update_library', updateLibrary.default || updateLibrary);
    console.log('[NativeRegistry] Registered built-in tool: update_library');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register update_library:', msg);
  }

  try {
    // Delete Library — DELETE /api/v1/libraries/:libraryId?permanent=true
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const deleteLibrary = require('./native/delete-library.js');
    registry.register('delete_library', deleteLibrary.default || deleteLibrary);
    console.log('[NativeRegistry] Registered built-in tool: delete_library');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register delete_library:', msg);
  }

  try {
    // List Documents — GET /api/v1/libraries/:libraryId (paginated documents)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listDocuments = require('./native/list-documents.js');
    registry.register('list_documents', listDocuments.default || listDocuments);
    console.log('[NativeRegistry] Registered built-in tool: list_documents');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_documents:', msg);
  }

  try {
    // Get Document — GET /api/v1/libraries/:libraryId/documents/:documentId[/full|/chunks]
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getDocument = require('./native/get-document.js');
    registry.register('get_document', getDocument.default || getDocument);
    console.log('[NativeRegistry] Registered built-in tool: get_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_document:', msg);
  }

  try {
    // Delete Document — DELETE /api/v1/libraries/:libraryId/documents/:documentId
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const deleteDocument = require('./native/delete-document.js');
    registry.register('delete_document', deleteDocument.default || deleteDocument);
    console.log('[NativeRegistry] Registered built-in tool: delete_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register delete_document:', msg);
  }

  try {
    // Update Document — PATCH /api/v1/libraries/:libraryId/documents/:documentId
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const updateDocument = require('./native/update-document.js');
    registry.register('update_document', updateDocument.default || updateDocument);
    console.log('[NativeRegistry] Registered built-in tool: update_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register update_document:', msg);
  }

  try {
    // Reprocess Document — POST /api/v1/libraries/:libraryId/documents/:documentId/process
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const reprocessDocument = require('./native/reprocess-document.js');
    registry.register(
      'reprocess_document',
      reprocessDocument.default || reprocessDocument,
    );
    console.log('[NativeRegistry] Registered built-in tool: reprocess_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register reprocess_document:', msg);
  }

  try {
    // Upload To Library — POST /api/v1/libraries/:libraryId/upload (multipart, base64 input)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const uploadToLibrary = require('./native/upload-to-library.js');
    registry.register('upload_to_library', uploadToLibrary.default || uploadToLibrary);
    console.log('[NativeRegistry] Registered built-in tool: upload_to_library');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register upload_to_library:', msg);
  }

  // ─── Pattern pack (TOOL-HANDOFF.md §4.6) ──────────────────────────────────
  // Pure utility tools. No API calls, no side effects — they only manipulate
  // strings, regexes, JSON, or token counts.
  try {
    // Regex Match — apply a regex to text; returns match(es) with groups + index
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const regexMatch = require('./native/regex-match.js');
    registry.register('regex_match', regexMatch.default || regexMatch);
    console.log('[NativeRegistry] Registered built-in tool: regex_match');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register regex_match:', msg);
  }

  try {
    // JSON Query — JSONPath-style accessor against an arbitrary JSON value
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const jsonQuery = require('./native/json-query.js');
    registry.register('json_query', jsonQuery.default || jsonQuery);
    console.log('[NativeRegistry] Registered built-in tool: json_query');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register json_query:', msg);
  }

  try {
    // Extract Thinking — strip <think>...</think> tags; returns thinking + content
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const extractThinking = require('./native/extract-thinking.js');
    registry.register('extract_thinking', extractThinking.default || extractThinking);
    console.log('[NativeRegistry] Registered built-in tool: extract_thinking');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register extract_thinking:', msg);
  }

  try {
    // Strip Formatting — remove Markdown or HTML formatting from text
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const stripFormatting = require('./native/strip-formatting.js');
    registry.register('strip_formatting', stripFormatting.default || stripFormatting);
    console.log('[NativeRegistry] Registered built-in tool: strip_formatting');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register strip_formatting:', msg);
  }

  try {
    // Count Tokens — tiktoken-backed token count for a given model (default gpt-4)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const countTokens = require('./native/count-tokens.js');
    registry.register('count_tokens', countTokens.default || countTokens);
    console.log('[NativeRegistry] Registered built-in tool: count_tokens');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register count_tokens:', msg);
  }

  // ─── Graph pack (TOOL-HANDOFF.md §4.9) ────────────────────────────────────
  // Three tools that let an LLM-driven agent dynamically introspect and
  // invoke other graphs. invoke_graph is the showstopper: full access
  // checking, recursion depth limit (5), parent linkage via input metadata.
  try {
    // List Graphs — GET /api/v1/graphs (system + public + owned + shared)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listGraphs = require('./native/list-graphs.js');
    registry.register('list_graphs', listGraphs.default || listGraphs);
    console.log('[NativeRegistry] Registered built-in tool: list_graphs');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_graphs:', msg);
  }

  try {
    // Get Graph — GET /api/v1/graphs/:graphId (full definition + inputSchema)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getGraph = require('./native/get-graph.js');
    registry.register('get_graph', getGraph.default || getGraph);
    console.log('[NativeRegistry] Registered built-in tool: get_graph');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_graph:', msg);
  }

  try {
    // Invoke Graph — dynamically invoke another graph as a tool. Access check
    // mirrors verifyGraphAccess; recursion limit 5; parent linkage via
    // input.parentRunId and input._invokeGraphDepth.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const invokeGraph = require('./native/invoke-graph.js');
    registry.register('invoke_graph', invokeGraph.default || invokeGraph);
    console.log('[NativeRegistry] Registered built-in tool: invoke_graph');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register invoke_graph:', msg);
  }

  // ─── Stream pack (TOOL-HANDOFF.md §4.10) ──────────────────────────────────
  // Four tools that let an agent dynamically start, end, inspect, and list
  // live stream sessions (chat, voice, websocket, etc.). The session-listing
  // and per-session GET routes are scoped under :streamId in the webapp; the
  // tools that take only a sessionId fall back to a bounded discovery walk
  // across the caller's accessible streams.
  try {
    // Start Stream Session — POST /api/v1/streams/:streamId/sessions; metadata
    // is forwarded as triggerData on the new session doc.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const startStreamSession = require('./native/start-stream-session.js');
    registry.register(
      'start_stream_session',
      startStreamSession.default || startStreamSession,
    );
    console.log('[NativeRegistry] Registered built-in tool: start_stream_session');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register start_stream_session:', msg);
  }

  try {
    // End Stream Session — POST /api/v1/streams/sessions/:sessionId/end;
    // returns the persisted lifecycle status (typically `'draining'`).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const endStreamSession = require('./native/end-stream-session.js');
    registry.register(
      'end_stream_session',
      endStreamSession.default || endStreamSession,
    );
    console.log('[NativeRegistry] Registered built-in tool: end_stream_session');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register end_stream_session:', msg);
  }

  try {
    // Get Stream Session — GET /api/v1/streams/:streamId/sessions/:sessionId;
    // when streamId is omitted, walks the caller's accessible streams to find
    // the session.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getStreamSession = require('./native/get-stream-session.js');
    registry.register(
      'get_stream_session',
      getStreamSession.default || getStreamSession,
    );
    console.log('[NativeRegistry] Registered built-in tool: get_stream_session');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_stream_session:', msg);
  }

  try {
    // List Stream Sessions — GET /api/v1/streams/:streamId/sessions; when
    // streamId is omitted, fans out across the caller's accessible streams
    // and merges + re-sorts the results.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listStreamSessions = require('./native/list-stream-sessions.js');
    registry.register(
      'list_stream_sessions',
      listStreamSessions.default || listStreamSessions,
    );
    console.log('[NativeRegistry] Registered built-in tool: list_stream_sessions');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_stream_sessions:', msg);
  }

  // ─── Automation pack (TOOL-HANDOFF.md §4.8) ───────────────────────────────
  // Five tools that let an agent dynamically discover, inspect, and control
  // automations. trigger_automation supports optional polling for terminal
  // status via wait:true; enable/disable_automation are owner-only.
  try {
    // Trigger Automation — POST /api/v1/automations/:id/trigger; optional
    // polling via wait:true returns terminal status.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const triggerAutomation = require('./native/trigger-automation.js');
    registry.register(
      'trigger_automation',
      triggerAutomation.default || triggerAutomation,
    );
    console.log('[NativeRegistry] Registered built-in tool: trigger_automation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register trigger_automation:', msg);
  }

  try {
    // List Automations — GET /api/v1/automations (owned + participated)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const listAutomations = require('./native/list-automations.js');
    registry.register('list_automations', listAutomations.default || listAutomations);
    console.log('[NativeRegistry] Registered built-in tool: list_automations');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register list_automations:', msg);
  }

  try {
    // Get Automation — GET /api/v1/automations/:id
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getAutomation = require('./native/get-automation.js');
    registry.register('get_automation', getAutomation.default || getAutomation);
    console.log('[NativeRegistry] Registered built-in tool: get_automation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_automation:', msg);
  }

  try {
    // Enable Automation — POST /api/v1/automations/:id/enable (owner-only)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const enableAutomation = require('./native/enable-automation.js');
    registry.register(
      'enable_automation',
      enableAutomation.default || enableAutomation,
    );
    console.log('[NativeRegistry] Registered built-in tool: enable_automation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register enable_automation:', msg);
  }

  try {
    // Disable Automation — POST /api/v1/automations/:id/disable (owner-only)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const disableAutomation = require('./native/disable-automation.js');
    registry.register(
      'disable_automation',
      disableAutomation.default || disableAutomation,
    );
    console.log('[NativeRegistry] Registered built-in tool: disable_automation');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register disable_automation:', msg);
  }

  // ─── Runs pack (TOOL-HANDOFF.md §4.11) ────────────────────────────────────
  // Three tools that complement the existing `get_recent_runs` (archive
  // reader). These work against live Redis state via the webapp routes:
  //   - get_run         → GET /api/v1/runs/:runId (live RunState)
  //   - get_run_logs    → GET /api/v1/runs/:runId/logs (redlog entries)
  //   - cancel_run      → POST /api/v1/runs/:runId/interrupt (handshake +
  //                       force-kill fallback)
  // Together they let an agent poll, audit, and abort runs it has triggered
  // via trigger_automation / invoke_graph (with wait:false).
  try {
    // Get Run — live RunState lookup; 404 once Redis TTL expires (~1 hour).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getRun = require('./native/get-run.js');
    registry.register('get_run', getRun.default || getRun);
    console.log('[NativeRegistry] Registered built-in tool: get_run');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_run:', msg);
  }

  try {
    // Get Run Logs — redlog entries for a run, with client-side level + limit.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const getRunLogs = require('./native/get-run-logs.js');
    registry.register('get_run_logs', getRunLogs.default || getRunLogs);
    console.log('[NativeRegistry] Registered built-in tool: get_run_logs');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register get_run_logs:', msg);
  }

  try {
    // Cancel Run — request/ACK interrupt with force-kill fallback.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cancelRun = require('./native/cancel-run.js');
    registry.register('cancel_run', cancelRun.default || cancelRun);
    console.log('[NativeRegistry] Registered built-in tool: cancel_run');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register cancel_run:', msg);
  }

  // ─── Files pack (TOOL-HANDOFF.md §4.14) ───────────────────────────────────
  // Two tools that complement the existing `upload_attachment`:
  //   - download_file   → fetch a remote URL as base64 + MIME type + size
  //   - parse_document  → decode base64 bytes and extract readable text via
  //                       the shared DocumentParser (PDF / DOCX / XLSX / etc.)
  // Together they let an agent pull a file off the network, hand it to the
  // parser, and feed the resulting text into prompts or RAG without ever
  // touching disk.
  try {
    // Download File — bounded HTTP/HTTPS download → base64 + mimeType + size.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const downloadFile = require('./native/download-file.js');
    registry.register('download_file', downloadFile.default || downloadFile);
    console.log('[NativeRegistry] Registered built-in tool: download_file');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register download_file:', msg);
  }

  try {
    // Parse Document — base64 + mimeType → extracted text via DocumentParser.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parseDocument = require('./native/parse-document.js');
    registry.register('parse_document', parseDocument.default || parseDocument);
    console.log('[NativeRegistry] Registered built-in tool: parse_document');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[NativeRegistry] Failed to register parse_document:', msg);
  }
}
