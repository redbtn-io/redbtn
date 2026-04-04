"use strict";
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
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NativeToolRegistry = void 0;
exports.getNativeRegistry = getNativeRegistry;
class NativeToolRegistry {
    constructor() {
        this.tools = new Map();
    }
    /**
     * Register a native tool definition.
     * The name must match what graphs use in their toolName step config.
     */
    register(name, definition) {
        this.tools.set(name, definition);
    }
    has(name) {
        return this.tools.has(name);
    }
    get(name) {
        return this.tools.get(name);
    }
    /**
     * List all registered native tools in MCP-compatible format.
     */
    listTools() {
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
    callTool(name, args, context) {
        return __awaiter(this, void 0, void 0, function* () {
            const tool = this.tools.get(name);
            if (!tool)
                throw new Error(`Native tool not found: ${name}`);
            return tool.handler(args, context);
        });
    }
}
exports.NativeToolRegistry = NativeToolRegistry;
// =============================================================================
// Singleton
// =============================================================================
let _instance = null;
/**
 * Get the shared NativeToolRegistry singleton.
 * Lazily registers all built-in native tools on first call.
 */
function getNativeRegistry() {
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
function registerBuiltinTools(registry) {
    try {
        // SSH Shell — requires ssh2 package
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sshShell = require('./native/ssh-shell.js');
        registry.register('ssh_shell', sshShell);
        console.log('[NativeRegistry] Registered built-in tool: ssh_shell');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register ssh_shell:', msg);
    }
    try {
        // Invoke Function — async RedRun function invocation with polling
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const invokeFunction = require('./native/invoke-function.js');
        registry.register('invoke_function', invokeFunction);
        console.log('[NativeRegistry] Registered built-in tool: invoke_function');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register invoke_function:', msg);
    }
    try {
        // SSH Copy — SFTP file transfer with Knowledge Library integration
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sshCopy = require('./native/ssh-copy.js');
        registry.register('ssh_copy', sshCopy);
        console.log('[NativeRegistry] Registered built-in tool: ssh_copy');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register ssh_copy:', msg);
    }
    try {
        // Library Write — programmatic document ingestion into Knowledge Libraries
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const libraryWrite = require('./native/library-write.js');
        registry.register('library_write', libraryWrite);
        console.log('[NativeRegistry] Registered built-in tool: library_write');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register library_write:', msg);
    }
    try {
        // Store Message — persist messages to Redis + MongoDB (ported from context-sse.ts)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const storeMessage = require('./native/store-message.js');
        registry.register('store_message', storeMessage);
        console.log('[NativeRegistry] Registered built-in tool: store_message');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register store_message:', msg);
    }
    try {
        // Get Context — build formatted conversation context for LLM (ported from context-sse.ts)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const getContext = require('./native/get-context.js');
        registry.register('get_context_history', getContext);
        console.log('[NativeRegistry] Registered built-in tool: get_context_history');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register get_context_history:', msg);
    }
    try {
        // Search Documents — semantic vector search (ported from rag-sse.ts)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const searchDocuments = require('./native/search-documents.js');
        registry.register('search_documents', searchDocuments);
        console.log('[NativeRegistry] Registered built-in tool: search_documents');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register search_documents:', msg);
    }
    try {
        // Add Document — chunk, embed, store in ChromaDB (ported from rag-sse.ts)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const addDocument = require('./native/add-document.js');
        registry.register('add_document', addDocument);
        console.log('[NativeRegistry] Registered built-in tool: add_document');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register add_document:', msg);
    }
    try {
        // Fetch URL — HTTP requests with full REST support (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fetchUrl = require('./native/fetch-url.js');
        registry.register('fetch_url', fetchUrl);
        console.log('[NativeRegistry] Registered built-in tool: fetch_url');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register fetch_url:', msg);
    }
    try {
        // Push Message — send messages to conversation streams in real-time
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pushMessage = require('./native/push-message.js');
        registry.register('push_message', pushMessage);
        console.log('[NativeRegistry] Registered built-in tool: push_message');
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[NativeRegistry] Failed to register push_message:', msg);
    }
}
