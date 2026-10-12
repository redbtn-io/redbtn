/**
 * Data-tool → capability mapping.
 *
 * The single source of truth for which native tools are DATA tools (State or
 * Knowledge), what action each performs, and how to extract the resource
 * ADDRESS (the thing a selector is matched against) from the tool's arguments.
 *
 * Anything NOT in this map is treated as a non-data tool and is NEVER gated by
 * the capability layer — the enforcement hook short-circuits to "allow" for
 * unmapped tool names. This keeps the blast radius of the permissions layer
 * scoped strictly to State + Knowledge, per the task.
 *
 * # Address semantics
 *
 *   - State tools: the address is the `namespace` arg. Prefix-jailing a State
 *     namespace (e.g. `coder/*`) is the primary defense.
 *   - Knowledge tools: the address is the LIBRARY identity. Most library tools
 *     take an opaque `libraryId`; `create_library` takes a human `name`. We
 *     expose BOTH the raw arg and a hint of which field it came from so the
 *     enforcement layer can match a selector against whatever the agent
 *     supplied. (Selectors authored for Knowledge therefore generally target
 *     library NAMES for create, and library IDs for mutate/read of an existing
 *     library — operators should grant the prefix on whichever identity their
 *     workflow uses; for the Red Coder jail we grant create by name-prefix and
 *     a wildcard is intentionally NOT used.)
 *
 * # Why a per-tool extractor instead of a generic arg sniff
 *
 * Tools are inconsistent: namespace vs libraryId vs name vs libraryIds[]. An
 * explicit table is auditable — a reviewer can see exactly which mutation
 * paths are covered and what each one keys on. A generic sniff would silently
 * miss a renamed field.
 *
 * @module lib/permissions/tool-map
 */

import type { CapabilityAction, CapabilityResource } from './types';
import { isUsableConversationId } from '../conversation/conversation-id';
import { repoSlug, repoSlugFromPullRequestUrl, workspaceAliases } from './workspace-grants';

/** One or more addresses extracted from a tool call (some tools fan out). */
export interface ExtractedAddress {
  /** Addresses to check. ALL must pass for the call to be allowed. */
  addresses: string[];
  /**
   * Several identities of ONE target (a workspace: ws_ id, owner/repo,
   * owner/repo@branch, github.com/owner/repo@branch). The call is allowed when ANY of them matches a
   * grant. Used by the `workspace` resource; `addresses[0]` is then only the
   * display address for errors.
   */
  anyOf?: string[];
  /**
   * True when the tool COULD touch resources but no specific address was
   * supplied (e.g. `search_all_libraries` with no `libraryIds`, or a list-all
   * tool). For a profiled run this means "broad/unscoped access" and the
   * enforcement layer treats it as requiring a wildcard-capable grant.
   */
  unscoped?: boolean;
}

export interface DataToolRule {
  resource: CapabilityResource;
  action: CapabilityAction;
  /**
   * Pull the address(es) this call targets out of the raw tool args. Returns
   * `{ addresses: [], unscoped: true }` when the tool is inherently broad and
   * no narrowing identifier was given.
   */
  extract: (args: Record<string, unknown>) => ExtractedAddress;
  /**
   * Optional async resolution, run by the dispatch chokepoint INSTEAD of
   * `extract` when present: for tools whose target can only be known from the
   * run (its checkouts, the PRs it shipped) or a Mongo lookup. Implemented in
   * permissions/workspace-address.ts and wired by native-registry.ts.
   */
  asyncResolve?: 'workspace';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => str(x)).filter((x) => x.length > 0);
}

/** Address extractor for State tools — always keys on `namespace`. */
function stateNamespace(args: Record<string, unknown>): ExtractedAddress {
  const ns = str(args.namespace);
  if (!ns) return { addresses: [], unscoped: true };
  return { addresses: [ns] };
}

/** Address extractor for single-library tools — keys on `libraryId`. */
function libraryId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.libraryId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

/** Address extractor for `create_library` — keys on the new `name`. */
function libraryName(args: Record<string, unknown>): ExtractedAddress {
  const name = str(args.name);
  if (!name) return { addresses: [], unscoped: true };
  return { addresses: [name] };
}

/** `search_all_libraries`: optional `libraryIds[]` filter, else broad. */
function libraryIdsFilter(args: Record<string, unknown>): ExtractedAddress {
  const ids = strArray(args.libraryIds);
  if (ids.length === 0) return { addresses: [], unscoped: true };
  return { addresses: ids };
}

function searchDocumentsAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.libraryId);
  if (id) return { addresses: [id] };
  return { addresses: [], unscoped: true };
}

/**
 * Address extractor for exec + computer tools — keys on `environmentId` (the
 * env/connector the op targets). Selectors are authored as environmentIds so an
 * agent is jailed to specific machines. A call with NO environmentId (e.g.
 * `ssh_shell` inline host/user mode) is UNSCOPED → requires an explicit `'*'`
 * grant. Because exec/computer are fail-closed (enforce.ts), an unmapped-address
 * op with no wildcard grant is denied.
 */
function envId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.environmentId) || str(args.machine);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function parseDocumentAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.libraryId);
  if (id) return { addresses: [id] };
  return { addresses: [], unscoped: true };
}

function graphId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.graphId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function nodeId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.nodeId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

/**
 * `workspace_for_repo`: the workspace the call names — `owner/repo`,
 * `owner/repo@<branch>` (default main) and `github.com/owner/repo@<branch>`
 * (its canonical name). At dispatch an EXISTING workspace is judged by its own
 * configuration and id instead (workspace-address.ts). No repo -> unscoped.
 */
function workspaceFromRepoArgs(args: Record<string, unknown>): ExtractedAddress {
  const slug = repoSlug(args.repo);
  if (!slug) return { addresses: [], unscoped: true };
  const branch = str(args.branch) || 'main';
  const aliases = workspaceAliases({ repo: slug, branch });
  return { addresses: [aliases[1] ?? slug], anyOf: aliases };
}

/** `workspace_get` / `workspace_task`: the `workspaceId` argument (its repo identities are added at dispatch). */
function workspaceIdArg(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.workspaceId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id], anyOf: [id] };
}

/**
 * `workspace_merge`: `owner/repo` from the PR URL. When THIS run shipped the
 * PR, dispatch adds the shipping workspace's identities and `owner/repo@<base>`.
 */
function workspaceFromPullRequest(args: Record<string, unknown>): ExtractedAddress {
  const slug = repoSlugFromPullRequestUrl(args.prUrl);
  if (!slug) return { addresses: [], unscoped: true };
  return { addresses: [`github.com/${slug}`], anyOf: [`github.com/${slug}`, slug] };
}

function toolNameAddress(args: Record<string, unknown>): ExtractedAddress {
  const name = str(args.toolName);
  if (!name) return { addresses: [], unscoped: true };
  return { addresses: [name] };
}

function automationId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.automationId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function runAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.runId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function recentRunsAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.graphId || args.streamId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function conversationId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.conversationId);
  // Unusable ids (undefined / "undefined" / unrendered templates) address
  // nothing — treat them as unscoped rather than scoping a grant to a
  // `conversations:undefined` shaped address.
  if (!id || !isUsableConversationId(id)) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function streamSessionAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.sessionId || args.streamId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function streamId(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.streamId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

function emailRecipient(args: Record<string, unknown>): ExtractedAddress {
  const to = strArray(Array.isArray(args.to) ? args.to : [args.to]);
  if (to.length === 0) return { addresses: [], unscoped: true };
  return { addresses: to };
}

function urlAddress(args: Record<string, unknown>): ExtractedAddress {
  const u = str(args.url);
  if (!u) return { addresses: [], unscoped: true };
  return { addresses: [u] };
}

function taskAddress(args: Record<string, unknown>): ExtractedAddress {
  const id = str(args.taskId || args.scope || args.parentTaskId);
  if (!id) return { addresses: [], unscoped: true };
  return { addresses: [id] };
}

/**
 * The data-tool table. EXHAUSTIVE for State + Knowledge mutation AND read
 * paths in `native/`. Read tools are included so a jail can also prevent
 * cross-tenant *reads* (data exfiltration), not just writes — but read grants
 * are independent, so a profile that only restricts writes can leave reads
 * open by granting `read: '*'`.
 *
 * Grouped + commented by domain so the audit is legible.
 */
export const DATA_TOOL_RULES: Record<string, DataToolRule> = {
  // ── State: reads ──────────────────────────────────────────────────────────
  get_global_state: { resource: 'state', action: 'read', extract: stateNamespace },
  list_global_state: { resource: 'state', action: 'read', extract: stateNamespace },
  get_global_schema: { resource: 'state', action: 'read', extract: stateNamespace },
  // list_namespaces enumerates ALL namespaces the user can access — inherently
  // broad. Mapped as an unscoped read so a jailed agent needs a wildcard read
  // grant to enumerate (otherwise it could discover sibling-workflow namespaces).
  list_namespaces: {
    resource: 'state',
    action: 'read',
    extract: () => ({ addresses: [], unscoped: true }),
  },

  // ── State Records: reads ──────────────────────────────────────────────────
  // Records live under a namespace and are addressed by it, so the SAME
  // namespace-keyed extractor applies — an agent jailed to namespace X by an
  // existing selector is jailed for records in X too, with no new grant syntax.
  get_state_record: { resource: 'state', action: 'read', extract: stateNamespace },
  query_state_records: { resource: 'state', action: 'read', extract: stateNamespace },

  // ── State: writes ─────────────────────────────────────────────────────────
  set_global_state: { resource: 'state', action: 'write', extract: stateNamespace },
  state_patch: { resource: 'state', action: 'write', extract: stateNamespace },
  // state_atomic's `read` op is a read, but the tool as a whole mutates
  // (claims, releases, CAS, increments), so it is gated as a write.
  state_atomic: { resource: 'state', action: 'write', extract: stateNamespace },
  create_state_record: { resource: 'state', action: 'write', extract: stateNamespace },
  update_state_record: { resource: 'state', action: 'write', extract: stateNamespace },

  // ── State: deletes ────────────────────────────────────────────────────────
  delete_global_state: { resource: 'state', action: 'delete', extract: stateNamespace },
  delete_namespace: { resource: 'state', action: 'delete', extract: stateNamespace },
  delete_state_record: { resource: 'state', action: 'delete', extract: stateNamespace },

  // ── Knowledge: reads ──────────────────────────────────────────────────────
  list_libraries: {
    resource: 'knowledge',
    action: 'read',
    extract: () => ({ addresses: [], unscoped: true }),
  },
  get_document: { resource: 'knowledge', action: 'read', extract: libraryId },
  list_documents: { resource: 'knowledge', action: 'read', extract: libraryId },
  search_documents: {
    // `libraryId` is the safe scoped path. Legacy `collection` calls are still
    // treated as unscoped because the capability layer cannot resolve a Chroma
    // collection name to a library id without I/O.
    resource: 'knowledge',
    action: 'read',
    extract: searchDocumentsAddress,
  },
  search_all_libraries: {
    resource: 'knowledge',
    action: 'read',
    extract: libraryIdsFilter,
  },
  parse_document: {
    resource: 'knowledge',
    action: 'read',
    extract: parseDocumentAddress,
  },

  // ── Knowledge: create ─────────────────────────────────────────────────────
  create_library: { resource: 'knowledge', action: 'create', extract: libraryName },
  add_document: { resource: 'knowledge', action: 'write', extract: libraryId },
  upload_to_library: { resource: 'knowledge', action: 'write', extract: libraryId },

  // ── Knowledge: writes (mutate existing) ───────────────────────────────────
  update_library: { resource: 'knowledge', action: 'write', extract: libraryId },
  update_document: { resource: 'knowledge', action: 'write', extract: libraryId },
  reprocess_document: { resource: 'knowledge', action: 'write', extract: libraryId },
  restore_library: { resource: 'knowledge', action: 'write', extract: libraryId },
  restore_document: { resource: 'knowledge', action: 'write', extract: libraryId },

  // ── Knowledge: deletes ────────────────────────────────────────────────────
  delete_library: { resource: 'knowledge', action: 'delete', extract: libraryId },
  delete_document: { resource: 'knowledge', action: 'delete', extract: libraryId },

  // ── Exec: run commands / file I/O via an environment session ──────────────
  // FAIL-CLOSED (enforce.ts): denied unless the run's profile grants
  // `exec:execute` for the target environmentId (or `'*'`). This CLOSES the
  // prior hole where these tools were unmapped ⇒ ungated even in profiled runs.
  // Reading/writing files on a machine you can exec on is not a meaningfully
  // separate authority, so file ops share the single `execute` verb (split into
  // exec:read/exec:write later only if finer control is wanted).
  run_command: { resource: 'exec', action: 'execute', extract: envId },
  // ── Managed workspaces (`workspace` resource, FAIL-CLOSED; 0.0.296) ───────
  // Keyed by the WORKSPACE (ws_ id / its configured owner/repo[@branch]),
  // any identity matching a grant — see permissions/workspace-grants.ts.
  // Before 0.0.296 these were exec: workspace_for_repo / workspace_merge
  // unscoped (only exec:* could call them) and workspace_ship keyed by the
  // checkout env, which exists only mid-run, so no profile could say "this
  // workspace only". `exec:execute@*` still passes them all (legacy superset).
  //   - read     workspace_get, get_workspace_task (look, change nothing)
  //   - execute  workspace_for_repo (find or create the workspace record),
  //              workspace_task (start a worker run in it), and the CHECKOUT
  //              itself (neuron-step producer), which DERIVES
  //              exec:execute@<checkout env> until the checkout is released
  //   - write    workspace_ship (push the checkout's branch, open a PR)
  //   - control  workspace_merge (merge into the base branch)
  workspace_get: { resource: 'workspace', action: 'read', extract: workspaceIdArg, asyncResolve: 'workspace' },
  workspace_for_repo: { resource: 'workspace', action: 'execute', extract: workspaceFromRepoArgs, asyncResolve: 'workspace' },
  workspace_task: { resource: 'workspace', action: 'execute', extract: workspaceIdArg, asyncResolve: 'workspace' },
  get_workspace_task: { resource: 'workspace', action: 'read', extract: () => ({ addresses: [], unscoped: true }), asyncResolve: 'workspace' },
  workspace_ship: { resource: 'workspace', action: 'write', extract: () => ({ addresses: [], unscoped: true }), asyncResolve: 'workspace' },
  workspace_merge: { resource: 'workspace', action: 'control', extract: workspaceFromPullRequest, asyncResolve: 'workspace' },
  ssh_shell: { resource: 'exec', action: 'execute', extract: envId }, // inline (no environmentId) ⇒ unscoped ⇒ needs '*'
  read_file: { resource: 'exec', action: 'execute', extract: envId },
  ssh_copy: { resource: 'exec', action: 'execute', extract: envId },
  desktop_exec: { resource: 'exec', action: 'execute', extract: envId },
  // The environment fs-pack + async-exec tools reach the SAME authority as the
  // ones above — SFTP write/edit MUTATE the remote filesystem, and glob /
  // grep_files / ssh_run_async run arbitrary SSH commands on the environment —
  // so they MUST share the `exec:execute` gate. Omitting them was a real hole:
  // `read_file` (read-only) was gated while the strictly-more-dangerous
  // `write_file` / `edit_file` / `ssh_run_async` bypassed BOTH the capability
  // jail (enforce.ts short-circuits allow for unmapped tools) AND the exec
  // runtime guard (kill switch / rate limit / audit key off this same map).
  // The async-job control/read tools (ssh_kill/ssh_tail/ssh_jobs) address a
  // job on a specific environmentId and belong to the same exec authority.
  // `list_dir` is the SIXTH fs-pack tool (native-registry.ts §fs pack): the
  // read-only SFTP sibling of `read_file` — a single-level `readdir` or a
  // recursive BFS tree-walk of ANY environmentId. It is EXACTLY the same
  // cross-env read authority as `read_file`, so it must share the gate too;
  // leaving it unmapped retained the identical capability-jail bypass (a
  // jailed/unprofiled run could enumerate the directory tree of any env, and
  // it evaded the kill-switch/rate-limit/audit runtime guard).
  write_file: { resource: 'exec', action: 'execute', extract: envId },
  edit_file: { resource: 'exec', action: 'execute', extract: envId },
  glob: { resource: 'exec', action: 'execute', extract: envId },
  grep_files: { resource: 'exec', action: 'execute', extract: envId },
  list_dir: { resource: 'exec', action: 'execute', extract: envId },
  ssh_run_async: { resource: 'exec', action: 'execute', extract: envId },
  ssh_tail: { resource: 'exec', action: 'execute', extract: envId },
  ssh_kill: { resource: 'exec', action: 'execute', extract: envId },
  ssh_jobs: { resource: 'exec', action: 'execute', extract: envId },

  // ── Computer-use: screen + mouse/keyboard (desktop connectors) ────────────
  // FAIL-CLOSED. Grant `computer:control` scoped to the desktop's environmentId.
  desktop_screenshot: { resource: 'computer', action: 'control', extract: envId },
  desktop_screen_info: { resource: 'computer', action: 'control', extract: envId },
  desktop_click: { resource: 'computer', action: 'control', extract: envId },
  desktop_move: { resource: 'computer', action: 'control', extract: envId },
  desktop_type: { resource: 'computer', action: 'control', extract: envId },
  desktop_key: { resource: 'computer', action: 'control', extract: envId },
  desktop_scroll: { resource: 'computer', action: 'control', extract: envId },
  desktop_read_text: { resource: 'computer', action: 'read', extract: envId },
  desktop_find_text: { resource: 'computer', action: 'read', extract: envId },
  desktop_find_image: { resource: 'computer', action: 'read', extract: envId },
  desktop_wait_for: { resource: 'computer', action: 'read', extract: envId },
  desktop_click_text: { resource: 'computer', action: 'control', extract: envId },
  desktop_hover: { resource: 'computer', action: 'control', extract: envId },
  desktop_drag: { resource: 'computer', action: 'control', extract: envId },
  desktop_batch: { resource: 'computer', action: 'control', extract: envId },
  desktop_list_windows: { resource: 'computer', action: 'read', extract: envId },

  // ── Graph tools ───────────────────────────────────────────────────────────
  invoke_graph: { resource: 'graph', action: 'execute', extract: graphId },
  // Editing a graph is a WRITE on that graph, keyed by graphId — a profiled
  // agent may only change the graphs its profile names (`graph:write@<graphId>`,
  // or a prefix/wildcard). publish_graph changes what RUNS, so it is a write
  // too. Before 0.0.295 these were unmapped and therefore ungated even under a
  // profile: a jailed operator could rewrite any graph its user owns.
  graph_patch: { resource: 'graph', action: 'write', extract: graphId },
  update_graph: { resource: 'graph', action: 'write', extract: graphId },
  publish_graph: { resource: 'graph', action: 'write', extract: graphId },
  delete_graph: { resource: 'graph', action: 'delete', extract: graphId },

  // ── Node tools (standalone node documents) ───────────────────────────────
  // Keyed by nodeId under their own `node` resource rather than by "the owning
  // graph": a node document is shared by every graph that references it (system
  // nodes like `context` are in most graphs), and mapping nodeId -> graph would
  // need a DB read inside this synchronous gate. Nodes promoted by publish are
  // named `<graphId>-<nodeInstanceId>`, so `node:write@<graphId>-*` jails an
  // agent to exactly the published nodes of one graph.
  node_patch: { resource: 'node', action: 'write', extract: nodeId },
  update_node: { resource: 'node', action: 'write', extract: nodeId },
  delete_node: { resource: 'node', action: 'delete', extract: nodeId },

  // ── Meta tools ("tool tools") ─────────────────────────────────────────────
  invoke_tool: { resource: 'tool', action: 'execute', extract: toolNameAddress },

  // ── Automations ───────────────────────────────────────────────────────────
  trigger_automation: { resource: 'automation', action: 'execute', extract: automationId },
  // Changing an automation (its graph, trigger, schedule, inputs) or switching
  // it on/off is a WRITE on that automation, keyed by automationId.
  update_automation: { resource: 'automation', action: 'write', extract: automationId },
  enable_automation: { resource: 'automation', action: 'write', extract: automationId },
  disable_automation: { resource: 'automation', action: 'write', extract: automationId },

  // ── Runs ──────────────────────────────────────────────────────────────────
  get_recent_runs: { resource: 'run', action: 'read', extract: recentRunsAddress },
  get_run: { resource: 'run', action: 'read', extract: runAddress },
  get_run_logs: { resource: 'run', action: 'read', extract: runAddress },

  // ── Conversations / Context ───────────────────────────────────────────────
  get_messages: { resource: 'conversation', action: 'read', extract: conversationId },
  get_context_history: { resource: 'conversation', action: 'read', extract: conversationId },
  get_conversation: { resource: 'conversation', action: 'read', extract: conversationId },

  // ── Streams ───────────────────────────────────────────────────────────────
  list_stream_sessions: { resource: 'stream', action: 'read', extract: streamId },
  get_stream_session: { resource: 'stream', action: 'read', extract: streamSessionAddress },

  // ── Communication / Outbound notifications ────────────────────────────────
  send_email: { resource: 'communication', action: 'write', extract: emailRecipient },

  // ── Web / Network ─────────────────────────────────────────────────────────
  fetch_url: { resource: 'web', action: 'read', extract: urlAddress },
  scrape_url: { resource: 'web', action: 'read', extract: urlAddress },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  task_create: { resource: 'task', action: 'create', extract: taskAddress },
  task_list: { resource: 'task', action: 'read', extract: taskAddress },
  task_get: { resource: 'task', action: 'read', extract: taskAddress },
  task_update: { resource: 'task', action: 'write', extract: taskAddress },
  task_complete: { resource: 'task', action: 'write', extract: taskAddress },
};

/** Is this tool name a gated data tool? */
export function isDataTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATA_TOOL_RULES, name);
}

/** Get the rule for a data tool, or undefined if it's not a data tool. */
export function getDataToolRule(name: string): DataToolRule | undefined {
  return DATA_TOOL_RULES[name];
}
