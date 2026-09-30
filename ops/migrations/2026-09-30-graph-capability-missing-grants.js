// Idempotent migration: add the MINIMAL missing capability grants a profiled graph's own nodes need.
//
// WHY: engine 0.0.250 (#425, 2026-09-11) mapped get_context_history/get_messages/get_conversation
// (conversation:read), invoke_graph (graph:execute), fetch_url/scrape_url (web:read), task_* (task),
// get_run* (run:read), stream sessions (stream:read), send_email (communication:write), invoke_tool,
// trigger_automation into DATA_TOOL_RULES. A graph that carries ANY `capabilities` profile is enforced
// fail-closed for every mapped resource, so profiles written before that (notably the auto-generated
// "exec-migration" profiles, which only listed exec/computer/state/knowledge) silently lost access to
// the newly-mapped resources. Symptom: the `context` node's get_context_history tool step fails with
// "Permission denied: agent profile 'exec-migration' ... has no conversation read grants" and the run dies.
//
// WHAT: static scan of every profiled graph (tool steps, neuron tool lists, loops/conditionals, and
// unprofiled subgraphs reached through `graph` steps). A gap is a mapped native tool whose resource+action
// has no grant in the profile.
//   HARD gap  = a deterministic `tool` step (the graph cannot work without it)      -> always granted
//   SOFT gap  = a tool in a neuron's tool list (the model MAY call it), or a tool step that swallows its
//               own error (errorHandling.onError != throw)                          -> granted only for
//               PRESERVE_PROFILES (auto-generated `exec-migration` = "preserves prior access", and the
//               "Full execution and platform access" gemini-37 profile); for real jails soft gaps are
//               REPORTED, never widened.
// Grants are added at selector '*' (the tool steps address the run's own conversation/namespace etc via
// templates, i.e. any address). If the profile already has a '*' grant for the resource, the action is
// appended to it instead of adding a new grant.
//
// SAFE: dry-run by default; before each write the previous `capabilities` is saved to
// <db>.graph_capability_backups; the update is conditional on `capabilities` being unchanged; re-running
// after apply reports 0 changes.
// RUN:   { echo 'var APPLY=false;'; cat this.js; } | mongosh ... --file   (dry run)
//        { echo 'var APPLY=true;';  cat this.js; } | mongosh ...          (apply)
// AFTER: redis PUBLISH graph:invalidate <graphId> for each changed graph (printed at the end).
// ROLLBACK: var MODE='rollback'; restores the latest backup with reason REASON for every graph.
if (typeof APPLY === 'undefined') var APPLY = false;
if (typeof DBS === 'undefined') var DBS = ['redbtn', 'redbtn-beta'];
if (typeof MODE === 'undefined') var MODE = 'migrate';
const REASON = 'capability-missing-grants 2026-09-30';
// Profiles whose documented intent is "preserve prior / full access" (not a jail). Soft gaps are granted
// for these too: 'exec-migration' = webapp scripts/migrate-exec-capabilities.js ("preserves prior access"),
// 'gemini-37-agent-capabilities' = "Full execution and platform access".
if (typeof PRESERVE_PROFILES === 'undefined') var PRESERVE_PROFILES = ['exec-migration', 'gemini-37-agent-capabilities'];
const TOOL_RULES = {"get_global_state":["state","read"],"list_global_state":["state","read"],"get_global_schema":["state","read"],"get_state_record":["state","read"],"query_state_records":["state","read"],"set_global_state":["state","write"],"state_patch":["state","write"],"state_atomic":["state","write"],"create_state_record":["state","write"],"update_state_record":["state","write"],"delete_global_state":["state","delete"],"delete_namespace":["state","delete"],"delete_state_record":["state","delete"],"get_document":["knowledge","read"],"list_documents":["knowledge","read"],"create_library":["knowledge","create"],"add_document":["knowledge","write"],"upload_to_library":["knowledge","write"],"update_library":["knowledge","write"],"update_document":["knowledge","write"],"reprocess_document":["knowledge","write"],"restore_library":["knowledge","write"],"restore_document":["knowledge","write"],"delete_library":["knowledge","delete"],"delete_document":["knowledge","delete"],"run_command":["exec","execute"],"workspace_ship":["exec","execute"],"workspace_for_repo":["exec","execute"],"workspace_merge":["exec","execute"],"ssh_shell":["exec","execute"],"read_file":["exec","execute"],"ssh_copy":["exec","execute"],"desktop_exec":["exec","execute"],"write_file":["exec","execute"],"edit_file":["exec","execute"],"glob":["exec","execute"],"grep_files":["exec","execute"],"list_dir":["exec","execute"],"ssh_run_async":["exec","execute"],"ssh_tail":["exec","execute"],"ssh_kill":["exec","execute"],"ssh_jobs":["exec","execute"],"desktop_screenshot":["computer","control"],"desktop_screen_info":["computer","control"],"desktop_click":["computer","control"],"desktop_move":["computer","control"],"desktop_type":["computer","control"],"desktop_key":["computer","control"],"desktop_scroll":["computer","control"],"desktop_read_text":["computer","read"],"desktop_find_text":["computer","read"],"desktop_find_image":["computer","read"],"desktop_wait_for":["computer","read"],"desktop_click_text":["computer","control"],"desktop_hover":["computer","control"],"desktop_drag":["computer","control"],"desktop_batch":["computer","control"],"desktop_list_windows":["computer","read"],"invoke_graph":["graph","execute"],"invoke_tool":["tool","execute"],"trigger_automation":["automation","execute"],"get_recent_runs":["run","read"],"get_run":["run","read"],"get_run_logs":["run","read"],"get_messages":["conversation","read"],"get_context_history":["conversation","read"],"get_conversation":["conversation","read"],"list_stream_sessions":["stream","read"],"get_stream_session":["stream","read"],"send_email":["communication","write"],"fetch_url":["web","read"],"scrape_url":["web","read"],"task_create":["task","create"],"task_list":["task","read"],"task_get":["task","read"],"task_update":["task","write"],"task_complete":["task","write"],"list_namespaces":["state","read"],"list_libraries":["knowledge","read"],"search_documents":["knowledge","read"],"search_all_libraries":["knowledge","read"],"parse_document":["knowledge","read"]};

function toolNamesOfNeuron(cfg) {
  const out = [];
  for (const t of (Array.isArray(cfg.tools) ? cfg.tools : [])) {
    if (typeof t === 'string') out.push(t);
    else if (t && typeof t.name === 'string' && (!t.source || t.source === 'native')) out.push(t.name);
  }
  return out;
}

function main(d, dbn) {
  const nodes = new Map(d.nodes.find({}, { nodeId: 1, steps: 1 }).toArray().map((n) => [n.nodeId, n.steps || []]));
  const graphs = new Map(d.graphs.find({}, { graphId: 1, name: 1, userId: 1, nodes: 1, capabilities: 1 }).toArray().map((g) => [g.graphId, g]));
  const hasProfile = (g) => !!(g && g.capabilities && Array.isArray(g.capabilities.capabilities));

  // needs: key "resource:action" -> { hard: Set(tool@where), soft: Set(tool@where) }
  function collect(g, needs, seen, via) {
    if (seen.has(g.graphId)) return; seen.add(g.graphId);
    for (const gn of (g.nodes || [])) {
      const cfg = gn.config || {};
      const steps = Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : (nodes.get(cfg.nodeId) || []);
      const where = via + (cfg.nodeId || gn.id);
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) return o.forEach(walk);
        const c = o.config || {};
        if (o.type === 'tool' && typeof c.toolName === 'string' && TOOL_RULES[c.toolName]) {
          // A tool step that swallows its own failure (errorHandling.onError continue/skip/fallback) is
          // optional to the graph: treat it like a neuron tool (soft) so hand-written jails are not widened.
          const onErr = c.errorHandling && c.errorHandling.onError;
          add(needs, c.toolName, (onErr && onErr !== 'throw') ? 'soft' : 'hard', where);
        }
        if (o.type === 'neuron') for (const t of toolNamesOfNeuron(c)) if (TOOL_RULES[t]) add(needs, t, 'soft', where);
        if (o.type === 'graph' && typeof c.graphId === 'string') {
          const sub = graphs.get(c.graphId);
          // A subgraph that declares its OWN profile runs under it (graphExecutor scopes it); otherwise it
          // inherits the parent's profile, so its needs are the parent's needs.
          if (sub && !hasProfile(sub)) collect(sub, needs, seen, where + '>' + c.graphId + ':');
        }
        for (const k in o) walk(o[k]);
      })(steps);
    }
  }
  function add(needs, tool, kind, where) {
    const [r, a] = TOOL_RULES[tool];
    const k = r + ':' + a;
    if (!needs[k]) needs[k] = { hard: new Set(), soft: new Set() };
    needs[k][kind].add(tool + '@' + where);
  }
  const granted = (caps, r, a) => caps.some((c) => c && c.resource === r && Array.isArray(c.actions) && c.actions.includes(a) && typeof c.selector === 'string' && c.selector.trim() && c.selector.trim() !== 'none');

  const changed = [];
  let reported = 0;
  for (const g of graphs.values()) {
    if (!hasProfile(g)) continue;
    const needs = {};
    collect(g, needs, new Set(), '');
    const caps = g.capabilities.capabilities;
    const isAuto = PRESERVE_PROFILES.includes(g.capabilities.name);
    const add = [], reportOnly = [];
    for (const k of Object.keys(needs).sort()) {
      const [r, a] = k.split(':');
      if (granted(caps, r, a)) continue;
      const n = needs[k];
      if (n.hard.size || isAuto) add.push({ k, r, a, hard: [...n.hard], soft: [...n.soft] });
      else reportOnly.push({ k, soft: [...n.soft] });
    }
    if (!add.length && !reportOnly.length) continue;
    reported++;
    print(`${dbn} ${g.graphId} [profile ${g.capabilities.name}] "${g.name || ''}" user=${g.userId || '-'}`);
    for (const x of add) print(`   ADD ${x.k.padEnd(20)} hard=${JSON.stringify(x.hard)} soft=${JSON.stringify(x.soft)}`);
    for (const x of reportOnly) print(`   GAP ${x.k.padEnd(20)} (jail; optional use only, NOT widened) soft=${JSON.stringify(x.soft)}`);
    if (!add.length) continue;
    const next = JSON.parse(JSON.stringify(caps));
    for (const x of add) {
      const star = next.find((c) => c && c.resource === x.r && typeof c.selector === 'string' && c.selector.trim() === '*' && Array.isArray(c.actions));
      if (star) { if (!star.actions.includes(x.a)) star.actions.push(x.a); }
      else next.push({ resource: x.r, actions: [x.a], selector: '*' });
    }
    changed.push(g.graphId);
    if (!APPLY) continue;
    d.graph_capability_backups.insertOne({ graphId: g.graphId, reason: REASON, capabilities: g.capabilities, takenAt: new Date() });
    const r = d.graphs.updateOne(
      { graphId: g.graphId, 'capabilities.capabilities': caps },
      { $set: { 'capabilities.capabilities': next, updatedAt: new Date() } },
    );
    print(`   -> modified=${r.modifiedCount}`);
  }
  print(`${dbn}: ${reported} graphs with gaps, ${changed.length} ${APPLY ? 'changed' : 'would change'}`);
  if (changed.length) print(`${dbn} INVALIDATE: ${changed.join(' ')}`);
}

function rollback(d, dbn) {
  const ids = d.graph_capability_backups.distinct('graphId', { reason: REASON });
  for (const id of ids) {
    const b = d.graph_capability_backups.find({ graphId: id, reason: REASON }).sort({ takenAt: 1 }).limit(1).next();
    print(`${dbn} ${APPLY ? 'RESTORE' : 'WOULD RESTORE'} ${id}`);
    if (APPLY) d.graphs.updateOne({ graphId: id }, { $set: { capabilities: b.capabilities, updatedAt: new Date() } });
  }
}

print(`mode=${MODE} ${APPLY ? 'APPLY' : 'DRY-RUN'} dbs=${DBS.join(',')}`);
for (const dbn of DBS) (MODE === 'rollback' ? rollback : main)(db.getSiblingDB(dbn), dbn);
