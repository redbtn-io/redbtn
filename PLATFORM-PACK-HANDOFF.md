# Platform Pack — Architecture & Coverage Handoff

**Status:** Specification — captured for future implementation, **not yet started**.
**Owner:** Engine team.
**Goal:** Native tools that let agents create, modify, fork, and validate the platform's own primitives — graphs, nodes, neurons, streams. Combined with a curated Knowledge Library of platform docs, this makes the platform **self-bootstrapping**: agents can build agents.

**Status flag — "new game+":** ship AFTER the human-driven workflow is proven and stable. The platform should make sense to a human first. Self-construction is the cheat code that gets enabled once the system is solid.

---

## 1. Architecture decisions (already made — do not re-litigate)

### 1.1 What this is

A native tool pack that wraps the existing `/api/v1/{graphs,nodes,neurons,streams}` CRUD endpoints. The tools live in `redbtn/src/lib/tools/native/` alongside the other native packs.

### 1.2 What this is NOT

- **Not a code generator.** The platform is config-driven; these tools generate JSON configs, not code. No compile step, no runtime risk beyond what the config validator already catches.
- **Not a privilege elevation.** Tools are user-scoped — they can only act on the caller's own assets. System assets (`isSystem: true`) require an explicit fork.
- **Not a replacement for the Studio UI.** Humans still build graphs in Studio. These tools let an LLM-driven agent ALSO build graphs, in the same shape, with the same validation.

### 1.3 Strategic ordering — when to ship

Ship AFTER:
- Environments (Phases A-F) — coding-agent capability is mature
- A solid set of human-built reference graphs exists and runs cleanly (red-assistant, red-chat, claude-assistant, all seven personal-voice-stream subgraphs)
- The Knowledge Library `redbtn-platform-docs` is populated with comprehensive API + step-type docs

The platform must "work for humans" first. Self-construction is the meta-feature you turn on once everything underneath is rock-solid. Premature shipping = agents generating broken graphs = bad first impression of self-construction.

### 1.4 Six operating decisions

| # | Decision | Final answer |
|---|---|---|
| 1 | Naming | `verb_noun`. `create_graph`, `update_node`, `fork_neuron`, `validate_graph_config`. |
| 2 | System asset modification | NEVER directly. Agent must call `fork_*` first to get a user copy, then mutate the fork. |
| 3 | Quotas | Inherit/extend the existing per-user automation cap (currently 20). Add `MAX_GRAPHS_PER_USER`, `MAX_NODES_PER_USER`, `MAX_NEURONS_PER_USER`, `MAX_STREAMS_PER_USER` at sensible defaults (100/200/50/20). |
| 4 | Cost guarding | Agent-generated graphs run under the same per-user neuron tier-gating as human-built ones — no new mechanism needed. |
| 5 | Validation | `validate_graph_config` runs the compiler in dry-run mode against an unsaved config. Returns errors/warnings without persisting. Catches bad edges, missing referenced nodeIds, malformed condition expressions, etc. |
| 6 | Compile-time error visibility | New endpoint `GET /api/v1/graphs/:id/compile-log` returns the most recent compile attempt's diagnostics. Lets the agent (and humans) debug failures in the closed loop. |

---

## 2. Scope of work

### Phase A — Platform pack tools (one PR, engine-only)

~17 native tools wrapping existing CRUD routes. See §3 for full inventory.

### Phase B — Knowledge Library seeding (one PR — docs + script)

Build `redbtn-platform-docs` Knowledge Library with the docs listed in §4. Includes a one-off script `~/code/@redbtn/scripts/seed-platform-docs.ts` that generates and uploads the docs (re-runnable as the platform evolves).

### Phase C — Validation tooling (small PR)

`validate_graph_config` engine-side helper + `validate_graph_config` native tool + `GET /api/v1/graphs/:id/compile-log` webapp route + `get_graph_compile_log` native tool. Surface compile diagnostics in the Studio UI graph detail page (small UI add).

---

## 3. Tool inventory

### 3.1 Graph tools

| Tool | Inputs | Output |
|---|---|---|
| `create_graph` | `graphId`, `config: GraphConfig` | `{ graphId, createdAt }` |
| `update_graph` | `graphId`, `patch: Partial<GraphConfig>` | `{ ok: true, updatedAt }` |
| `delete_graph` | `graphId` | `{ ok: true }` — refuses if `isSystem` |
| `fork_graph` | `graphId`, `newGraphId?` | `{ graphId: newId, forkedFrom: originalId }` |
| `publish_graph` | `graphId` | `{ ok: true, isPublic: true }` |
| `validate_graph_config` | `config: GraphConfig` | `{ valid: boolean, errors: [], warnings: [] }` |
| `get_graph_compile_log` | `graphId` | `{ logs: [{level, message, nodeId?}], lastCompiledAt }` |

### 3.2 Node tools

| Tool | Inputs | Output |
|---|---|---|
| `create_node` | `nodeId`, `config: NodeConfig` (must include `steps[]`) | `{ nodeId, createdAt }` |
| `update_node` | `nodeId`, `patch` | `{ ok: true }` |
| `delete_node` | `nodeId` | `{ ok: true }` — refuses if isSystem; warns if any graph references it |
| `fork_node` | `nodeId`, `newNodeId?` | `{ nodeId, forkedFrom }` |

### 3.3 Neuron tools

| Tool | Inputs | Output |
|---|---|---|
| `create_neuron` | `neuronId`, `config: NeuronConfig` | `{ neuronId, createdAt }` |
| `update_neuron` | `neuronId`, `patch` | `{ ok: true }` |
| `delete_neuron` | `neuronId` | `{ ok: true }` |
| `fork_neuron` | `neuronId`, `newNeuronId?` | `{ neuronId, forkedFrom }` |

### 3.4 Stream tools

| Tool | Inputs | Output |
|---|---|---|
| `create_stream` | `streamId`, `config: StreamConfig` | `{ streamId, createdAt }` |
| `update_stream` | `streamId`, `patch` | `{ ok: true }` |
| `delete_stream` | `streamId` | `{ ok: true }` — force-closes any active session |

---

## 4. Knowledge Library — `redbtn-platform-docs`

Library structure (each as a separate chunked document):

1. **Architecture overview** — based on CLAUDE.md / AGENTS.md
2. **Step types reference** — every universalNode step type (`neuron`, `tool`, `transform`, `conditional`, `loop`, `connection`, `delay`, `graph`) with config schema + minimal example
3. **Edge types reference** — sequential, conditional, parallel, join with examples
4. **Tool catalog** — every native tool, name + description + input schema + a tiny example call. Auto-generated from `native-registry.ts` listings.
5. **Neuron config reference** — providers (Ollama/OpenAI/Anthropic/Google/custom), model selection, structured-output, streaming, audioOptimized, tier-gating
6. **Stream config reference** — provider mode vs graph mode, `startupGraphId`, `teardownGraphId`, parsers (`parserConfig`), keepAlive, shutdownConfig
7. **Automation triggers** — webhook, cron, manual, interval mode (continuous loops)
8. **Concurrency modes** — skip / allow / queue / interrupt and when to use each
9. **Run lifecycle** — RunPublisher events, runEvents archive shape, `get_recent_runs` queries
10. **Connections + Secrets** — `{{secret:NAME}}` pattern, `secretRef` for SSH keys, `UserConnection` for OAuth/API keys
11. **Environments** — long-running SSH/SFTP targets, `environmentId` on ssh_shell + fs pack tools
12. **Common patterns**:
    - Chat with conversation history
    - RAG over a knowledge library
    - Scheduled daily summary
    - Webhook → process → respond
    - Stream + dispatch to subgraphs
    - Continuous-loop background agent
13. **Curated examples** — full-config dumps of `red-chat`, `red-assistant`, `claude-assistant`, plus a few hand-picked simple workflow graphs

The seed script reads from authoritative sources (markdown docs, Mongo configs, native-registry exports) and writes to the library via `add_document`. Re-running it updates the library — versioning handled by `add_document`'s overwrite semantics.

---

## 5. Closed-loop iteration recipe

The intended agent flow when given a build request:

```
USER: "Build me a graph that summarizes today's GitHub PRs and emails me the summary"

AGENT internal loop:
  1.  search_documents(query="how to write a workflow graph", libraryId="redbtn-platform-docs")
  2.  search_documents(query="GitHub MCP connection")
  3.  search_documents(query="send_email native tool")
  4.  search_documents(query="cron automation trigger")
  5.  draft = compose graph config
  6.  validate_graph_config(draft)            → catches obvious mistakes
  7.  create_graph({graphId: "github-pr-summary", config: draft})
  8.  invoke_graph(graphId, sampleInput={...today's PRs}, wait: true)
  9.  IF error:
        get_run_logs(runId, level: 'error')
        search_documents(query=<error message>)
        update_graph(graphId, {patched config})
        GOTO 8
 10.  trigger_automation(automationId)        → real run with cron schedule
 11.  reply: "Done. Graph 'github-pr-summary' built and scheduled. First run at 9am."
```

This is the Devin/SWE-agent pattern but with **redbtn config** as the substrate instead of code. Order-of-magnitude faster iteration loop than text-to-code agents.

---

## 6. Risks + mitigations

| Risk | Mitigation |
|---|---|
| Agent generates infinite-loop graph (subgraph calls itself) | `invoke_graph` has depth-5 limit (already shipped, Pack 7) |
| Agent burns LLM budget with bad graph | Existing tier-gating + the external interrupt mechanism (PR #1) — operator can cancel runaway runs |
| Quota exhaustion (agent generates 1000s of graphs in a loop) | `MAX_GRAPHS_PER_USER` enforcement at create time |
| System asset corruption | Tools refuse to modify `isSystem`; agent must `fork_*` first |
| Bad config crashes worker | `validate_graph_config` dry-run before create + create-time validation in the existing API |
| Stylistic drift from human-curated standards | Curated examples in knowledge library + lint rules surfaced via `validate_graph_config` warnings |
| Confused agent overwrites a working graph | Optional: track `agentEditedAt` vs `humanEditedAt` and warn before overwriting human-edited graphs |

---

## 7. Testing requirements

Per-tool Vitest + a "build and run" pack integration test that:
1. Creates a minimal workflow graph
2. Validates it
3. Runs it via `invoke_graph`
4. Verifies output
5. Updates it
6. Re-runs successfully
7. Deletes

Plus an end-to-end smoke test where an LLM-driven agent goes through the full closed-loop iteration recipe (§5) — given a one-sentence user request, builds a working graph from scratch.

---

## 8. PR template

Each phase / pack PR uses the standard template (see TOOL-HANDOFF.md §7).

---

## 9. Open questions

1. **Should agents be allowed to create automations?** Probably YES via a future Automation creation tool — but more sensitive (real schedule, real outbound effects). Defer to a separate decision.
2. **Should agents be allowed to create connections / secrets?** Probably NO — credential creation should stay human-driven. Agents can REFERENCE existing secrets via `secretRef`, but not mint new ones.
3. **Versioning / rollback**: do we add `restore_graph_version(graphId, version)` so an agent can undo its own changes? Useful for closed-loop iteration. Worth it; minor follow-up.
4. **Graph templates**: should there be a `clone_graph_from_template(templateId, vars)` for the common case where the agent wants "the standard chat graph but with my system prompt"? Possibly — defer until usage patterns emerge.

---

## 10. Status checklist

Phase A — Platform pack tools
- [ ] PR opened
- [ ] Merged to beta + main
- [ ] Engine alpha bumped + published
- [ ] Webapp + worker bumped

Phase B — Knowledge Library seeding
- [ ] `seed-platform-docs.ts` written
- [ ] Run against prod + beta DBs
- [ ] `redbtn-platform-docs` library populated
- [ ] Re-runnability verified (incremental updates work)

Phase C — Validation tooling
- [ ] `validate_graph_config` endpoint + tool
- [ ] `GET /api/v1/graphs/:id/compile-log` endpoint
- [ ] `get_graph_compile_log` tool
- [ ] Compile log surfaced in Studio graph detail page

End-state validation
- [ ] An agent can build a working chat graph from a one-sentence user request
- [ ] Closed-loop debugging works: agent reads its own error, fixes, retries
- [ ] Curated example graphs exist for the most common patterns
- [ ] No agent has accidentally exhausted the system

---

## 11. The aesthetic principle

The platform is for humans first. The Platform Pack is the moment the platform turns around and starts helping itself grow — **but only after humans have established what "good" looks like.** Don't ship this until:

- Reference graphs are clean and well-documented
- Studio UX is intuitive enough that a human builds confidently before reaching for an agent
- The Knowledge Library docs are something a NEW human dev could learn from in an afternoon

Then enable the meta-loop. The agent's outputs will be as good as the human-curated source material it learns from. Garbage in, garbage out — so do the human-quality work first.

> *What's a God who cannot create?*
> *Just a really expensive chat completion.*
