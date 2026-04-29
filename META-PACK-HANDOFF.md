# Meta Pack ("Tool Tools") — Architecture & Coverage Handoff

**Status:** Specification — ready to be implemented in a single PR.
**Owner:** Engine team.
**Goal:** Three thin native tools that let an agent **dynamically discover and dispatch** any other native tool at runtime. Solves the "I want this stream to have full tool access without manually wiring 80 entries into `toolGraphs`" problem.

---

## 1. Architecture decisions (already made — do not re-litigate)

### 1.1 What this is

A 3-tool native pack that wraps the existing `NativeToolRegistry` so agents can:
- List the tool catalog (with optional filters)
- Inspect any tool's input schema
- Invoke any tool by name with constructed args

### 1.2 What this is NOT

- Not a replacement for `toolGraphs` map. The map stays for high-frequency, well-known agent capabilities (deterministic, fast). Meta tools are the catch-all for the long tail.
- Not a security primitive. It exposes whatever the registry contains — the deny-list / allow-list config is the safety surface (see §3 below).
- Not for MCP `custom` tools (yet). v1 only dispatches to `native` source tools. Future v2 could extend.

### 1.3 Naming

`verb_noun` matching the existing convention. Three tools:
- `list_available_tools(filter?, source?)`
- `get_tool_schema(toolName)`
- `invoke_tool(toolName, args)`

### 1.4 Five operating decisions

| # | Decision | Final answer |
|---|---|---|
| 1 | Which tools are exposed | `native` source only for v1. The handler reads from `getNativeRegistry().listTools()`. |
| 2 | Self-reference protection | `invoke_tool` REFUSES to dispatch to itself, `list_available_tools`, or `get_tool_schema` (would enable infinite indirection). |
| 3 | Allow / deny config | Read from graph state at dispatch time: `state.toolToolsConfig: { allow?: string[]; deny?: string[] }`. Glob patterns supported (`fs.*`, `delete_*`). Deny wins over allow. If neither set, all tools allowed. |
| 4 | Result shape | Returns whatever the underlying tool returns, unmodified. Same `{content, isError?}` MCP shape. |
| 5 | Auditing | Every `invoke_tool` call writes a log line (`[meta-pack] invoking <toolName> via meta dispatch`) so post-hoc review of what an agent reached for is easy. |

---

## 2. Scope of work

Single PR. Engine-only. ~3 tools + tests.

---

## 3. Tool specifications

### 3.1 `list_available_tools`

```jsonc
{
  "description": "List native tools available for dynamic invocation. Use this to discover tools by capability when you don't already know the name. Returns name + description for each match. Use get_tool_schema(name) to see the input shape, then invoke_tool(name, args) to call.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "filter": { "type": "string", "description": "Optional substring filter applied to tool name + description (case-insensitive)." },
      "source": { "type": "string", "enum": ["native"], "default": "native", "description": "Tool source. Only 'native' supported in v1." }
    }
  },
  "output": "{ tools: [{ name, description, server }], total: number }"
}
```

Implementation:
- Read `getNativeRegistry().listTools()`
- Apply filter (substring match against `name` + `description`)
- Apply state-level allow/deny config (drop denied tools from results entirely so the agent doesn't even know they exist)
- Strip the meta-tools themselves from results (agent doesn't need to recurse)
- Return name/description/server for each — NOT the input schema (use `get_tool_schema` for that to keep payload small)

### 3.2 `get_tool_schema`

```jsonc
{
  "description": "Get the input schema for a specific tool. Call after list_available_tools when you know the tool name and need to construct args for invoke_tool.",
  "inputSchema": {
    "type": "object",
    "required": ["toolName"],
    "properties": {
      "toolName": { "type": "string" }
    }
  },
  "output": "{ name, description, server, inputSchema }"
}
```

Implementation:
- `getNativeRegistry().get(toolName)`
- If not found → `isError: true, code: 'TOOL_NOT_FOUND'`
- If denied by config → same shape (don't reveal existence)
- If meta-tool itself → refuse (`code: 'META_TOOL_NOT_INTROSPECTABLE'`)
- Return `{name, description, server, inputSchema}`

### 3.3 `invoke_tool`

```jsonc
{
  "description": "Invoke a native tool by name with the given args. Use list_available_tools + get_tool_schema first to discover the tool and construct args correctly. Returns whatever the underlying tool returns.",
  "inputSchema": {
    "type": "object",
    "required": ["toolName", "args"],
    "properties": {
      "toolName": { "type": "string" },
      "args": { "type": "object", "description": "Args matching the tool's inputSchema." }
    }
  },
  "output": "Pass-through of the underlying tool's result."
}
```

Implementation:
1. Validate `toolName` is a string + `args` is an object
2. Refuse if `toolName` is one of the meta tools (`list_available_tools`, `get_tool_schema`, `invoke_tool`) — `code: 'META_RECURSION_BLOCKED'`
3. Read `state.toolToolsConfig` (if present); apply deny + allow logic with glob match (use a tiny matcher — no `minimatch` dep). Deny wins over allow.
4. `getNativeRegistry().get(toolName)` → if missing, `code: 'TOOL_NOT_FOUND'`
5. Log: `console.log('[meta-pack] invoking ${toolName} via meta dispatch (run=${context.runId})')`
6. `await tool.handler(args, context)` — pass through context unchanged
7. Return result unmodified

### 3.4 Allow/deny pattern matching

Tiny inline matcher (no dependency):
- `*` matches any chars except path separator (toolnames don't have separators, so equivalent to `.*`)
- Trailing `*` matches everything from that prefix (`fs_*` matches `fs_read`, `fs_write`)
- `?` matches single char
- Anything else is literal

Roughly:
```
function matchPattern(name: string, pattern: string): boolean {
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  return regex.test(name);
}
```

Deny first, then allow. If allow is set and no pattern matches, deny.

---

## 4. Files

```
redbtn/src/lib/tools/native/list-available-tools.ts
redbtn/src/lib/tools/native/get-tool-schema.ts
redbtn/src/lib/tools/native/invoke-tool.ts
```

Wire all 3 in `redbtn/src/lib/tools/native-registry.ts` in their own "meta pack" block.

Tests:
```
redbtn/tests/tools/list-available-tools.test.ts
redbtn/tests/tools/get-tool-schema.test.ts
redbtn/tests/tools/invoke-tool.test.ts
redbtn/tests/integration/tools-meta.test.ts
```

Cover:
- Listing returns expected names (mock the registry)
- Filter works
- Schema fetch happy + missing + meta-tool refusal
- Invoke happy path (passes through to underlying tool)
- Invoke denies meta-tool recursion
- Invoke respects deny list
- Invoke respects allow list
- Pattern matching (`fs_*`, `delete_*`, etc)

---

## 5. How a graph uses it

Stream config example:
```json
{
  "streamId": "god-stream",
  "toolGraphs": {
    "personal": { "graphId": "red-personal" },
    "work": { "graphId": "red-work" },
    // ... domain agents stay
  },
  "defaultInput": {
    "tools": [{
      "functionDeclarations": [
        // tool tools as Gemini function declarations
        {"name": "list_available_tools", "description": "...", "parameters": {...}},
        {"name": "get_tool_schema", "description": "...", "parameters": {...}},
        {"name": "invoke_tool", "description": "...", "parameters": {...}},
        // plus the domain tools wired via toolGraphs
      ]
    }],
    "toolToolsConfig": {
      "deny": ["delete_*", "fork_*", "send_email", "send_webhook"],
      "allow": ["*"]
    }
  }
}
```

The session manager's `dispatchToolCall` already routes `toolGraphs[name]` to subgraph runs. For `list_available_tools` / `get_tool_schema` / `invoke_tool` (which AREN'T in `toolGraphs`), it'll fall through to direct native-tool dispatch. (Verify this is wired in session-manager.ts; if not, a small change there is needed.)

---

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Agent invokes a destructive tool you didn't expect | Deny list in stream/graph config (`delete_*`, `send_*`, `fork_*`, etc) |
| Agent loops invoking itself | Meta-recursion blocked at `invoke_tool` level |
| Deny bypass via fuzzy name match | Strict literal + glob matching, no regex passthrough from user input |
| Agent burns LLM budget exploring | Bounded by run-level interrupt (PR #1) |
| Audit gap: who called what | Every invoke logs to console with runId; archived to runEvents like any other tool call |

---

## 7. Engine version bump

`0.0.107-alpha` → `0.0.108-alpha`. Coordinate with parallel Platform Pack A/C if shipping together.

---

## 8. Status checklist

- [ ] PR opened
- [ ] Merged to beta + main
- [ ] Engine alpha bumped + published
- [ ] Webapp + worker bumped
- [ ] Smoke test: an agent successfully list → schema → invoke a real tool
