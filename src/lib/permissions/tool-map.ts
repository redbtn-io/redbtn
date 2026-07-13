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

/** One or more addresses extracted from a tool call (some tools fan out). */
export interface ExtractedAddress {
  /** Addresses to check. ALL must pass for the call to be allowed. */
  addresses: string[];
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
  const id = str(args.environmentId);
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

  // ── State: writes ─────────────────────────────────────────────────────────
  set_global_state: { resource: 'state', action: 'write', extract: stateNamespace },
  state_patch: { resource: 'state', action: 'write', extract: stateNamespace },

  // ── State: deletes ────────────────────────────────────────────────────────
  delete_global_state: { resource: 'state', action: 'delete', extract: stateNamespace },
  delete_namespace: { resource: 'state', action: 'delete', extract: stateNamespace },

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

  // ── Knowledge: create ─────────────────────────────────────────────────────
  create_library: { resource: 'knowledge', action: 'create', extract: libraryName },
  add_document: { resource: 'knowledge', action: 'write', extract: libraryId },
  upload_to_library: { resource: 'knowledge', action: 'write', extract: libraryId },

  // ── Knowledge: writes (mutate existing) ───────────────────────────────────
  update_library: { resource: 'knowledge', action: 'write', extract: libraryId },
  update_document: { resource: 'knowledge', action: 'write', extract: libraryId },
  reprocess_document: { resource: 'knowledge', action: 'write', extract: libraryId },

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
  ssh_shell: { resource: 'exec', action: 'execute', extract: envId }, // inline (no environmentId) ⇒ unscoped ⇒ needs '*'
  read_file: { resource: 'exec', action: 'execute', extract: envId },
  ssh_copy: { resource: 'exec', action: 'execute', extract: envId },
  desktop_exec: { resource: 'exec', action: 'execute', extract: envId },
  // The rest of the "fs pack" (Env Phase C) — same EnvironmentSession/SFTP
  // authority as read_file above, just missed when the fs pack's other five
  // tools shipped alongside read_file. write_file/edit_file mutate the
  // filesystem directly; glob/grep_files shell out via session.exec(); all
  // five require the exact same `exec:execute` grant read_file does.
  write_file: { resource: 'exec', action: 'execute', extract: envId },
  edit_file: { resource: 'exec', action: 'execute', extract: envId },
  glob: { resource: 'exec', action: 'execute', extract: envId },
  grep_files: { resource: 'exec', action: 'execute', extract: envId },
  list_dir: { resource: 'exec', action: 'execute', extract: envId },
  // The "process pack" (Env Phase D) — ssh_run_async executes an arbitrary
  // shell command (identical authority to run_command/ssh_shell); ssh_kill
  // and ssh_tail both issue their own session.exec() calls against the same
  // pooled SSH session. All three were missed when desktop_exec/run_command/
  // ssh_shell were mapped, leaving them ungated even in profiled runs.
  ssh_run_async: { resource: 'exec', action: 'execute', extract: envId },
  ssh_kill: { resource: 'exec', action: 'execute', extract: envId },
  ssh_tail: { resource: 'exec', action: 'execute', extract: envId },

  // ── Computer-use: screen + mouse/keyboard (desktop connectors) ────────────
  // FAIL-CLOSED. Grant `computer:control` scoped to the desktop's environmentId.
  desktop_screenshot: { resource: 'computer', action: 'control', extract: envId },
  desktop_screen_info: { resource: 'computer', action: 'control', extract: envId },
  desktop_click: { resource: 'computer', action: 'control', extract: envId },
  desktop_move: { resource: 'computer', action: 'control', extract: envId },
  desktop_type: { resource: 'computer', action: 'control', extract: envId },
  desktop_key: { resource: 'computer', action: 'control', extract: envId },
  desktop_scroll: { resource: 'computer', action: 'control', extract: envId },
  // desktop_settings' `op:'set'` can toggle the agent's own computer-use/exec
  // enable flags — a control-plane action over the same desktop connector as
  // the tools above, so it shares their grant.
  desktop_settings: { resource: 'computer', action: 'control', extract: envId },
};

/** Is this tool name a gated data tool? */
export function isDataTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(DATA_TOOL_RULES, name);
}

/** Get the rule for a data tool, or undefined if it's not a data tool. */
export function getDataToolRule(name: string): DataToolRule | undefined {
  return DATA_TOOL_RULES[name];
}
