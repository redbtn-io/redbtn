# Native Tools — Restructure & Coverage Handoff

**Status:** Specification — all decisions made; ready to be implemented across multiple PRs.
**Owner:** Engine team (multi-agent execution).
**Goal:** Consolidate tool architecture so that **native (in-process) tools fully cover platform features**, and MCP is reserved for **external/user-supplied** servers only.

---

## 1. Architecture decisions (already made — do not re-litigate)

### 1.1 One source of truth for first-party tools: native

- All platform-shipped tools live in `@redbtn/redbtn` `src/lib/tools/native/` and register through `NativeToolRegistry` in `native-registry.ts`.
- The four bundled MCP SSE servers (`web-sse`, `system-sse`, `rag-sse`, `context-sse`) are **deleted** after parity tools land.
- MCP infrastructure remains, but only for `custom` (user-configured external MCP servers via `mcp-connections`).

### 1.2 UI vocabulary

The `/connections/tools` page filters by `source`:

- `source: 'native'` → labelled **"System"** (rename the API field to `'system'` once everything else is settled — track as a follow-up; do not block the cleanup on it).
- `source: 'custom'` → labelled **"Custom"**.
- `source: 'global'` → **deleted** — no tools should ever be returned with this source after cleanup.

### 1.3 The `toolregistries` MongoDB collection is dead

- Nothing in the current codebase writes to it.
- The `/api/v1/tools` route is updated to **stop reading** from it.
- After landing, drop the collection: `db.toolregistries.drop()` on `redbtn` and `redbtn-beta`.

### 1.4 Naming convention: `verb_noun`

Matches the existing pattern (`get_recent_runs`, `store_message`, `add_document`, `fetch_url`, `ssh_shell`).

- ✅ `get_global_state`, `list_libraries`, `invoke_graph`
- ❌ `globalState_get`, `library_list`, `graph_invoke`

Rename the one outlier: `library_write` → consolidate into `add_document` (see §4.3).

### 1.5 Tool dispatcher precedence

When a name resolves, native wins. The `universalNode` tool executor already prefers native — leave that alone.

### 1.6 Six operating decisions

| # | Decision | Final answer |
|---|---|---|
| 1 | Naming | `verb_noun`. |
| 2 | `library_write` vs `add_document` | Consolidate. Delete `library_write`; extend `add_document` to accept text content and migrate the one node that uses it (`codetracker-write-library`). |
| 3 | TTS provider | Default to **Kokoro** (`http://192.168.1.6:8880`). Accept `provider: 'kokoro' \| 'gemini'` arg; gemini stays available. |
| 4 | Connection credential reads | **Restricted.** Expose `list_connections` and `validate_connection` (metadata only). Do **not** expose a `get_connection` that returns secret values — credentials reach graphs only via the `connection` step type. |
| 5 | Secrets | **Not exposed as tools.** Continue to use `{{secret:NAME}}` template substitution only. |
| 6 | `invoke_graph` scoping | Same access check as `/api/v1/graphs/[graphId]` (owner or shared participant). Recursion depth limit: **5**, enforced via `state._invokeGraphDepth` counter. Child runs link to parent via `parentRunId` on the run state. |

---

## 2. Scope of work

### Phase A — Cleanup (one PR)

1. Delete the 5 MCP↔native duplicates from MCP servers:
   - `system-sse` → empty after removing `fetch_url`; delete the file and its startup call.
   - `rag-sse` → remove `add_document`, `search_documents`. Delete the unused `delete_documents`, `list_collections`, `get_collection_stats` *(unused in live nodes — confirmed)*.
   - `context-sse` → remove `store_message`, `get_context_history`. Delete the unused `get_summary`, `get_messages`, `get_conversation_metadata` *(unused in live nodes — confirmed; equivalent native tools land in Phase B)*.
   - `web-sse` → keep for now; it has the only copy of `web_search`/`scrape_url`. Delete after Phase B's web pack lands.
2. Delete `worker/src/mcp-servers.ts` startup logic for the deleted servers (`SystemServerSSE`, `RagServerSSE`, `ContextServerSSE` imports + start/stop).
3. Scrub `execute_command` stragglers:
   - `redbtn/src/lib/mcp/README.md:192` — remove the bullet.
   - `worker/src/mcp-servers.ts:32–44` — remove the comment + the dead `{ allowedCommands, workingDirectory }` arg + the `// @ts-ignore`.
4. Update `webapp/src/app/api/v1/tools/route.ts`:
   - Stop reading `toolregistries` collection.
   - Return only `native` (in-process) and `custom` (user MCP) sources.
   - Keep the `source` filter param accepting `'global'` for backwards compat — just always return empty for it. Remove from the UI in a follow-up.
5. Drop `toolregistries` collection on `redbtn` + `redbtn-beta` (manual SSH command in PR description, run post-merge).
6. Stale seed JSON cleanup in `~/code/@redbtn/data/nodes/`:
   - `command.json` — replace `system_execute` with `ssh_shell` (or delete if not part of the seed flow anymore).
   - `browse.json`, `search.json` — update to use Phase B's native `web_search`/`scrape_url` once they land. Coordinate ordering.
   - `context.json`, `knowledge.json` — remove references to non-existent `search_library`/`search_all_libraries`. Replace with `search_documents` or `search_all_libraries` (Phase B library pack), as appropriate.

### Phase B — New tool packs (split into multiple PRs, one per pack)

See §3 for the full inventory. Recommended PR ordering:

1. **web pack** — port `web_search`, `scrape_url` → unblocks deleting `web-sse`.
2. **global-state pack** — biggest gap, biggest agent-impact win.
3. **conversation pack** — second-biggest gap.
4. **library pack** — finishes RAG coverage.
5. **voice pack** — small, easy.
6. **pattern pack** — small, easy.
7. **graph pack** — `invoke_graph` is the showstopper feature here.
8. **automation pack**.
9. **stream pack**.
10. **runs / logs / notifications / files / utility** — fill-in.

Each pack PR:
- Adds tool files in `redbtn/src/lib/tools/native/<name>.ts`.
- Wires registration in `native-registry.ts` (`registerBuiltinTools`).
- Adds a Vitest under `redbtn/tests/tools/<name>.test.ts` that exercises the happy path + one error case.
- Bumps the engine version (patch alpha bump) and lands a follow-up bump in `webapp` + `worker` so the new tools ship.

---

## 3. Tool specifications

### 3.1 Conventions

Every native tool file looks like:

```ts
import type { NativeToolDefinition, NativeToolContext, NativeMcpResult } from '../native-registry';

const myTool: NativeToolDefinition = {
  description: '<one-sentence description>. <one sentence on when an agent should use it>.',
  server: 'system',
  inputSchema: {
    type: 'object',
    properties: { /* … */ },
    required: [ /* … */ ],
  },
  async handler(args, context: NativeToolContext): Promise<NativeMcpResult> {
    // 1. Validate
    // 2. Resolve auth/userId from context
    // 3. Call into the engine module or webapp API
    // 4. Return { content: [{ type: 'text', text: <result-as-json-string> }] }
    // 5. On error: return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true }
  },
};

export default myTool;
```

### 3.2 `NativeToolContext`

Provides `userId`, `authToken`, `workflowId`, `conversationId`, `runId`, and Redis/Mongo handles. Every tool that hits a `/api/v1/...` route reuses `GlobalStateClient` patterns — pass `Authorization: Bearer ${authToken}` when present, otherwise fall back to `X-Internal-Key`. See `redbtn/src/lib/globalState/client.ts` for the established pattern.

### 3.3 Output shape

Tools return `{ content: [{ type: 'text', text: string }] }` where `text` is **JSON-stringified output**. For binary results (audio, files), use `{ type: 'image' | 'audio', data: <base64>, mimeType: '...' }` per MCP convention.

### 3.4 Error handling

- Validation errors → `isError: true`, `text: JSON.stringify({ error: 'message', code: 'VALIDATION' })`.
- Upstream API errors → `isError: true`, `text: JSON.stringify({ error: msg, status: <http-code> })`.
- Never throw raw — every tool's handler must return a well-formed `NativeMcpResult`.

---

## 4. Tool inventory (full specs)

> All tools below are **net-new** unless marked **(existing)** or **(consolidate)**.

### 4.1 Web pack

#### `web_search` — port from `web-sse`

```jsonc
{
  "description": "Search the web for results. Use for current-events questions, fact-checking, or when context-history doesn't have the answer.",
  "inputSchema": {
    "query": "string (required)",
    "count": "integer (1-50, default 10)",
    "queryPlan": "string (optional — structured plan from the planner node)"
  },
  "output": "{ results: [{ title, url, snippet, publishedAt? }], totalResults: number }"
}
```

Underlying impl: today inside `web-sse.ts`. Move to native, drop the SSE wrapper. Use the same upstream provider (Brave/SerpAPI/whatever it currently calls — verify via `web-sse.ts` source).

#### `scrape_url` — port from `web-sse`

```jsonc
{
  "description": "Fetch a URL and extract its main readable content as markdown. Use to read article bodies, docs, or any URL whose content you need to summarize.",
  "inputSchema": {
    "url": "string (required)",
    "format": "'markdown' | 'text' | 'html' (default 'markdown')",
    "timeout": "integer milliseconds (default 30000, max 120000)"
  },
  "output": "{ url, title, content, contentLength, scrapedAt }"
}
```

### 4.2 Global-state pack

All routes live under `/api/v1/state/namespaces`. Reuse `GlobalStateClient` in `redbtn/src/lib/globalState/client.ts`.

| Tool | Inputs | Output |
|---|---|---|
| `get_global_state` | `namespace`, `key` | `{ value: any, exists: boolean }` |
| `set_global_state` | `namespace`, `key`, `value`, `description?`, `ttlSeconds?` | `{ ok: true }` |
| `delete_global_state` | `namespace`, `key` | `{ ok: true, existed: boolean }` |
| `list_global_state` | `namespace` | `{ values: { [key]: any } }` |
| `list_namespaces` | (none) | `{ namespaces: [{ name, keyCount, lastModified }] }` |
| `delete_namespace` | `namespace` | `{ ok: true, deletedKeys: number }` |

**Notes:**
- `value` accepts arbitrary JSON.
- Description on `set_global_state` is metadata for the UI.
- TTL is server-enforced.
- Cache: every tool invokes the client fresh — do **not** rely on `GlobalStateClient`'s in-memory cache between tool calls (different requests, different instances).

### 4.3 Conversation pack

Routes under `/api/v1/conversations`. Engine module `redbtn/src/lib/conversation/`.

| Tool | Replaces / new | Inputs | Output |
|---|---|---|---|
| `store_message` (existing) | — | (existing schema) | (existing) |
| `get_context_history` (existing) | — | (existing schema) | (existing) |
| `push_message` (existing) | — | (existing schema) | (existing) |
| `create_conversation` | new | `title?`, `graphId?`, `metadata?` | `{ conversationId, createdAt }` |
| `list_conversations` | new | `limit? (default 20)`, `offset?`, `search?`, `archived?` | `{ conversations: [...], total }` |
| `get_conversation` | new | `conversationId`, `includeMessages? (default false)` | full conversation doc |
| `get_messages` | new (replaces MCP `get_messages`) | `conversationId`, `limit? (default 50)`, `before?` (cursor) | `{ messages: [...], hasMore }` |
| `get_conversation_metadata` | new (replaces MCP) | `conversationId` | `{ id, title, graphId, createdAt, lastMessageAt, messageCount, participants }` |
| `get_conversation_summary` | new (replaces MCP) | `conversationId`, `regenerate? (default false)` | `{ summary, generatedAt, fromCache: boolean }` |
| `set_conversation_title` | new | `conversationId`, `title` | `{ ok: true }` |
| `delete_conversation` | new | `conversationId`, `archive? (default true)` | `{ ok: true, archived: boolean }` |
| `list_threads` | new | `conversationId` | `{ threads: [{ threadId, parentMessageId, replyCount, lastReplyAt }] }` |
| `create_thread` | new | `conversationId`, `parentMessageId`, `firstMessage?` | `{ threadId }` |
| `list_participants` | new | `conversationId` | `{ participants: [{ userId, role, addedAt }] }` |
| `add_participant` | new | `conversationId`, `userId`, `role: 'member' \| 'viewer'` | `{ ok: true }` |

### 4.4 Library pack

Routes under `/api/v1/libraries`. Engine module `redbtn/src/lib/memory/`.

| Tool | Replaces / new | Inputs | Output |
|---|---|---|---|
| `add_document` (consolidate) | absorbs `library_write` | `libraryId`, `content?: string` **OR** `fileBase64?: string`, `filename?`, `metadata?` | `{ documentId, chunks: number }` |
| `search_documents` (existing) | — | (existing) | (existing) |
| `search_all_libraries` | new | `query`, `limit? (default 10)`, `libraryIds?: string[]` (filter), `minScore?` | `{ results: [{ libraryId, documentId, content, score }] }` |
| `list_libraries` | new | `search?`, `limit?` | `{ libraries: [{ id, name, description, documentCount }] }` |
| `create_library` | new | `name`, `description?`, `metadata?` | `{ libraryId }` |
| `update_library` | new | `libraryId`, `name?`, `description?`, `metadata?` | `{ ok: true }` |
| `delete_library` | new | `libraryId` | `{ ok: true, deletedDocuments: number }` |
| `list_documents` | new | `libraryId`, `limit?`, `offset?` | `{ documents: [{ id, filename, chunks, createdAt }], total }` |
| `get_document` | new | `libraryId`, `documentId`, `format?: 'full' \| 'chunks' \| 'metadata'` | full / chunks / metadata |
| `delete_document` | new | `libraryId`, `documentId` | `{ ok: true }` |
| `update_document` | new | `libraryId`, `documentId`, `content?`, `metadata?` | `{ ok: true, reprocessed: boolean }` |
| `reprocess_document` | new | `libraryId`, `documentId` | `{ ok: true, chunks: number }` |
| `upload_to_library` | new | `libraryId`, `fileBase64`, `filename`, `mimeType` | `{ documentId, chunks: number }` |

**Migration:** `codetracker-write-library` node currently uses `library_write`. After landing this pack:
1. Delete `library_write` registration from `native-registry.ts`.
2. Delete `redbtn/src/lib/tools/native/library-write.ts`.
3. Update the live `codetracker-write-library` node config in MongoDB to call `add_document` with the new arg shape. SSH command in the PR description.
4. Update the seed JSON if it exists.

### 4.5 Voice pack

| Tool | Inputs | Output |
|---|---|---|
| `synthesize_speech` (consolidates `tts_synthesize`) | `text`, `voice?`, `provider?: 'kokoro' \| 'gemini' (default 'kokoro')`, `format?: 'wav' \| 'pcm' (default 'wav')` | `{ audioBase64, mimeType, durationMs }` |
| `transcribe_audio` | `audioBase64` **OR** `audioUrl`, `mimeType`, `language? (default 'auto')` | `{ text, language, segments?: [{ start, end, text }] }` |

**Provider routing:**
- `kokoro` → `${TTS_URL ?? 'http://192.168.1.6:8880'}/v1/audio/speech`. Default voice `af_bella` (or whatever the existing Kokoro client uses; verify in `webapp/src/app/api/v1/voice/synthesize/route.ts`).
- `gemini` → existing Gemini TTS implementation in `redbtn/src/lib/tools/native/tts-synthesize.ts`. Default voice `Kore`.
- Migration: rename existing `tts_synthesize` → `synthesize_speech`. The old name should remain registered as an alias for one engine version, then be removed.

**Transcribe:** routes through `${STT_URL ?? 'http://192.168.1.3:8787'}/transcribe` (Whisper). See `webapp/src/app/api/v1/voice/transcribe/route.ts` for the existing proxy.

### 4.6 Pattern pack

Pure utility tools — all in-process, no API calls.

| Tool | Inputs | Output |
|---|---|---|
| `regex_match` | `text`, `pattern`, `flags?: string`, `mode?: 'first' \| 'all' (default 'first')` | `{ matches: [{ match, groups, index }] }` |
| `json_query` | `data: any`, `path: string` (JSONPath: `$.users[0].name`) | `{ value: any \| null }` |
| `extract_thinking` | `text` | `{ thinking: string, content: string }` (strips `<think>…</think>` tags) |
| `strip_formatting` | `text`, `format: 'markdown' \| 'html'` | `{ text: string }` |
| `count_tokens` | `text`, `model?: string (default 'gpt-4')` | `{ tokens: number, model }` |

**Use existing engine helpers:**
- `redbtn/src/lib/utils/thinking.ts` for `extract_thinking`.
- `redbtn/src/lib/utils/tokenizer.ts` for `count_tokens`.
- `redbtn/src/lib/utils/json-extractor.ts` for `json_query`.

### 4.7 Connection pack

| Tool | Inputs | Output |
|---|---|---|
| `list_connections` | `provider?: string` (filter by provider name) | `{ connections: [{ id, providerId, providerName, label, createdAt, lastValidatedAt, isValid }] }` |
| `validate_connection` | `connectionId` | `{ valid: boolean, error?: string, validatedAt }` |

**Explicitly NOT included:** `get_connection` (would expose stored OAuth tokens / API keys to LLMs).

### 4.8 Automation pack

| Tool | Inputs | Output |
|---|---|---|
| `trigger_automation` | `automationId`, `input?: any`, `wait? (default false)` | `{ runId, automationId, status }` (if `wait`, returns terminal status) |
| `list_automations` | `enabled?`, `search?`, `limit?` | `{ automations: [...] }` |
| `get_automation` | `automationId` | full automation doc |
| `enable_automation` | `automationId` | `{ ok: true, isEnabled: true }` |
| `disable_automation` | `automationId` | `{ ok: true, isEnabled: false }` |

### 4.9 Graph pack

| Tool | Inputs | Output |
|---|---|---|
| `invoke_graph` | `graphId`, `input: Record<string, any>`, `wait? (default true)`, `timeoutMs? (default 600000)` | `{ runId, output, status, durationMs }` |
| `list_graphs` | `search?`, `mine? (default false — only my graphs vs all accessible)`, `limit?` | `{ graphs: [{ graphId, name, description, isOwned, isSystem }] }` |
| `get_graph` | `graphId` | full graph definition |

**`invoke_graph` constraints:**
- Access check: caller must own the graph or be a participant on it (mirror `verifyGraphAccess` from `webapp/src/lib/auth/graph-access.ts`).
- Recursion limit: child run inherits `state._invokeGraphDepth = (parent._invokeGraphDepth ?? 0) + 1`. Reject if `> 5`.
- Parent linkage: child `RunState.parentRunId = currentRunId`.
- Tracing: child run inherits parent's `userId`, `conversationId` (if any), but generates a fresh `runId`.
- If `wait: false`, returns immediately with `runId`; agent can later poll via `get_run`.

### 4.10 Stream pack

Routes under `/api/v1/streams`. Engine module `redbtn/src/lib/streams/`.

| Tool | Inputs | Output |
|---|---|---|
| `start_stream_session` | `streamId`, `metadata?: Record<string, any>` | `{ sessionId, streamId, status: 'warming' }` |
| `end_stream_session` | `sessionId` | `{ ok: true, finalStatus: 'ended' \| 'draining' }` |
| `get_stream_session` | `sessionId` | full session doc |
| `list_stream_sessions` | `streamId?`, `status?`, `limit?` | `{ sessions: [...] }` |

### 4.11 Runs

| Tool | Inputs | Output |
|---|---|---|
| `get_recent_runs` (existing) | (existing) | (existing) |
| `get_run` | `runId` | full RunState |
| `get_run_logs` | `runId`, `limit?`, `level?: 'debug' \| 'info' \| 'warn' \| 'error'` | `{ logs: [...], hasMore }` |
| `cancel_run` | `runId`, `reason?` | `{ ok: true, status: 'cancelled' }` |

### 4.12 Logs

| Tool | Inputs | Output |
|---|---|---|
| `write_log` | `level`, `message`, `category?`, `metadata?` | `{ ok: true }` |
| `query_logs` | `runId? \| conversationId?`, `category?`, `level?`, `limit?` | `{ logs: [...] }` |

### 4.13 Notifications

| Tool | Inputs | Output |
|---|---|---|
| `push_message` (existing) | (existing) | (existing) |
| `send_email` | `to`, `subject`, `body`, `bodyType?: 'text' \| 'html' \| 'markdown' (default 'markdown')`, `attachments?` | `{ ok: true, messageId }` |
| `send_webhook` | `url`, `method? (default 'POST')`, `headers?`, `body?` | `{ status, response }` |

**Email backend:** wire to the same SMTP/Gmail relay used by the `send-email` agent. SMTP creds in `~/code/@redbtn/.env.docker` (`EMAIL_USER`, `EMAIL_PASS`). From-address default: `agent@redbtn.io` (alias of `george@redbtn.io`).

### 4.14 Files

| Tool | Inputs | Output |
|---|---|---|
| `upload_attachment` (existing) | (existing) | (existing) |
| `download_file` | `url`, `maxSizeBytes? (default 10MB)` | `{ contentBase64, mimeType, size }` |
| `parse_document` | `fileBase64`, `mimeType`, `format?: 'text' \| 'markdown' (default 'markdown')` | `{ text, pageCount?, wordCount }` |

`parse_document` reuses `redbtn/src/lib/memory/documentParser.ts`.

### 4.15 Utility

| Tool | Inputs | Output |
|---|---|---|
| `now` | `timezone? (default 'UTC')`, `format?: 'iso' \| 'unix' \| 'human' (default 'iso')` | `{ time, timezone, unix }` |
| `wait` | `ms (1-300000)` | `{ ok: true, waited: ms }` |
| `generate_id` | `format?: 'uuid' \| 'short' \| 'numeric' (default 'uuid')`, `prefix?: string` | `{ id }` |

---

## 5. Migrations

### 5.1 Live node configs to update

| Node | Current tool | New tool | Notes |
|---|---|---|---|
| `codetracker-write-library` | `library_write` | `add_document` | Args shape changes — see §4.4 migration. |
| `search` | `web_search` (MCP) | `web_search` (native) | Same name, no config change needed. |
| (any node calling `tts_synthesize`) | `tts_synthesize` | `synthesize_speech` | Old name aliased for one version; update at leisure. |

**SSH commands** (run after each phase merges):

```bash
# After Phase B web pack merges
# (no DB migration needed — same tool name)

# After Phase B library pack merges
ssh -i ~/s alpha@192.168.1.10 'docker exec mongodb mongosh --quiet \
  --username alpha --password redbtnioai --authenticationDatabase admin \
  "mongodb://localhost:27017/redbtn" \
  --eval "db.nodes.updateOne({nodeId: \"codetracker-write-library\"}, {\$set: {\"steps.0.config.toolName\": \"add_document\", \"steps.0.config.parameters\": { libraryId: \"{{parameters.libraryId}}\", content: \"{{parameters.content}}\", filename: \"{{parameters.filename}}\" }}})"'

# After full cleanup merges
ssh -i ~/s alpha@192.168.1.10 'docker exec mongodb mongosh --quiet \
  --username alpha --password redbtnioai --authenticationDatabase admin \
  "mongodb://localhost:27017/redbtn" \
  --eval "db.toolregistries.drop()"'
```

Apply the same to `redbtn-beta` DB.

### 5.2 Seed JSON updates

After each phase, sync `~/code/@redbtn/data/nodes/*.json` to match the live DB. The seed files have drifted significantly — easiest path is to dump the current live nodes back to JSON via a script rather than hand-edit.

---

## 6. Testing requirements

### 6.1 Per-tool

Every new tool ships with a Vitest under `redbtn/tests/tools/<tool-name>.test.ts`:

```ts
describe('<tool-name>', () => {
  it('happy path returns expected shape', async () => { /* … */ });
  it('returns isError: true on validation failure', async () => { /* … */ });
  it('returns isError: true on upstream error', async () => { /* … */ });
});
```

### 6.2 Per-pack

One integration test per pack that runs a small graph using the new tools end-to-end. Place under `redbtn/tests/integration/tools-<pack>.test.ts`.

### 6.3 Smoke test before each phase merge

1. `bash run.sh` to start full stack.
2. From the Studio UI, run `red-assistant` graph with a query that triggers the search node.
3. Trigger an automation that uses `ssh_shell`.
4. From `/connections/tools`, verify the source counts match expectations:
   - Phase A merged → "Global" filter is empty, "System" count unchanged, no `execute_command`.
   - Phase B web pack merged → "System" count = previous + 2 (`web_search`, `scrape_url`), `web-sse` deletable.

---

## 7. PR template

Each phase / pack PR uses this template:

```markdown
## Summary

Part of TOOL-HANDOFF.md §<n>. <One-sentence summary>.

## Tool list

- `<tool>` — <one-line description>
- `<tool>` — <one-line description>

## Migrations

- [ ] Update live node configs (SSH commands in description below)
- [ ] Update seed JSON (or note follow-up)
- [ ] Bump `@redbtn/redbtn` engine alpha version
- [ ] Bump installed engine version in `webapp` and `worker`

## Test plan

- [ ] Per-tool unit tests pass
- [ ] Pack integration test passes
- [ ] Smoke test: <specific graph that exercises the new tools>

## Post-merge SSH commands

```bash
<the migration commands>
```
```

---

## 8. Open follow-ups (not blocking)

1. Rename the API field `source: 'native'` → `source: 'system'` and update the UI to drop "Global" filter. Single-PR rename across `webapp/src/hooks/useAvailableTools.ts`, the route, and `webapp/src/app/connections/tools/page.tsx`.
2. Consider whether `invoke_function` should be deprecated in favour of `invoke_graph`. They overlap but `invoke_function` is finer-grained.
3. Consider exposing a `tool_meta_search` tool (an agent searching for tools by capability) once the surface gets large.
4. Once everything lands, drop the `toolregistries` collection and remove the legacy code paths.

---

## 9. Status checklist

Phase A — Cleanup
- [ ] PR opened
- [ ] Merged to beta
- [ ] Merged to main
- [ ] `toolregistries` dropped on prod + beta DBs

Phase B packs (one row per pack):
- [ ] **web pack** — `web_search`, `scrape_url` ported; `web-sse` deleted
- [ ] **global-state pack** — 6 tools
- [ ] **conversation pack** — 11 net-new tools
- [ ] **library pack** — 11 net-new tools, `library_write` consolidated into `add_document`
- [ ] **voice pack** — `synthesize_speech` (Kokoro default), `transcribe_audio`
- [ ] **pattern pack** — 5 tools
- [ ] **graph pack** — `invoke_graph`, `list_graphs`, `get_graph`
- [ ] **automation pack** — 5 tools
- [ ] **stream pack** — 4 tools
- [ ] **runs pack** — `get_run`, `get_run_logs`, `cancel_run`
- [ ] **logs pack** — `write_log`, `query_logs`
- [ ] **notifications pack** — `send_email`, `send_webhook`
- [ ] **files pack** — `download_file`, `parse_document`
- [ ] **utility pack** — `now`, `wait`, `generate_id`

Final
- [ ] Drop API `source: 'native'` → `'system'` rename
- [ ] Drop "Global" filter from UI
- [ ] Update seed JSONs to current live state
