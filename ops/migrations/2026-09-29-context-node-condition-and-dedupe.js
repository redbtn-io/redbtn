// Idempotent migration for the conversation-context loader nodes.
// Run with mongosh (authSource=admin). Prepend flags:
//   var APPLY = false|true;           // default false = dry run
//   var PARTS = ["condition","dedupe"]; // which fixes to apply
//   var DBS   = ["redbtn","redbtn-beta"];
//
// PART "condition" (item 2): system `context` node conditional
//   "{{state.data.contextMessages.length}}" > "0"  ->  "{{state.data.contextMessages.messages.length}}" > "0"
//   get_context_history(llm) returns a {messages,metadata} envelope; `.length` never resolves.
//   Safe on any engine: old engine evaluates both forms as "always true"; engine PR #540 evaluates the new form correctly.
// PART "dedupe" (item 1): god-context / coder-ctx-chat concat steps
//   (inputField data.contextMessages.messages + concatWith data.messages) get `dedupeMessages: true`
//   so the dispatch path's pre-persisted current user turn isn't sent twice.
//   REQUIRES engine PR #539 in the prod worker (older engines ignore the flag -> no-op, still harmless).
// HOW TO RUN item 1 once #539 is released + the prod worker pins it (check:
//   docker exec <redrun-app-69abb66540ce-*> grep version node_modules/@redbtn/redbtn/package.json  on .3):
//   { echo 'var APPLY=false; var PARTS=["dedupe"];'; cat migrate-context-nodes.js; } | mongosh "$MONGODB_URI_ADMIN"   # dry run
//   { echo 'var APPLY=true;  var PARTS=["dedupe"];'; cat migrate-context-nodes.js; } | mongosh "$MONGODB_URI_ADMIN"   # apply
// Rollback: restore steps from <db>.node_backups (latest doc for the nodeId with reason 'context-node migration ...').
// Every changed node's previous `steps` are saved to <db>.node_backups (reason tagged) before the write.
if (typeof APPLY === "undefined") var APPLY = false;
if (typeof PARTS === "undefined") var PARTS = ["condition", "dedupe"];
if (typeof DBS === "undefined") var DBS = ["redbtn", "redbtn-beta"];

const OLD_COND = '"{{state.data.contextMessages.length}}" > "0"';
const NEW_COND = '"{{state.data.contextMessages.messages.length}}" > "0"';
const TARGETS = {
  condition: ["context"],
  dedupe: ["god-context", "coder-ctx-chat"],
};

function fixCondition(steps) {
  let n = 0;
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o.type === "conditional" && o.config && o.config.condition === OLD_COND) { o.config.condition = NEW_COND; n++; }
    for (const k in o) walk(o[k]);
  })(steps);
  return n;
}
function fixDedupe(steps) {
  let n = 0;
  (function walk(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(walk);
    const c = o.config;
    if (o.type === "transform" && c && c.operation === "concat" &&
        c.inputField === "data.contextMessages.messages" && c.concatWith === "data.messages" &&
        c.dedupeMessages !== true) { c.dedupeMessages = true; n++; }
    for (const k in o) walk(o[k]);
  })(steps);
  return n;
}

print(`mode=${APPLY ? "APPLY" : "DRY-RUN"} parts=${PARTS.join(",")} dbs=${DBS.join(",")}`);
for (const dbn of DBS) {
  const d = db.getSiblingDB(dbn);
  for (const part of PARTS) {
    for (const nodeId of TARGETS[part]) {
      const node = d.nodes.findOne({ nodeId });
      if (!node) { print(`${dbn} ${nodeId}: not present, skip`); continue; }
      const before = JSON.parse(JSON.stringify(node.steps));
      const steps = JSON.parse(JSON.stringify(node.steps));
      const changed = part === "condition" ? fixCondition(steps) : fixDedupe(steps);
      if (!changed) { print(`${dbn} ${nodeId} [${part}]: already migrated (0 changes)`); continue; }
      print(`${dbn} ${nodeId} [${part}]: ${changed} step(s) to change`);
      if (!APPLY) continue;
      d.node_backups.insertOne({ nodeId, reason: `context-node migration ${part} ${new Date().toISOString().slice(0,10)}`, steps: before, takenAt: new Date() });
      const r = d.nodes.updateOne({ _id: node._id, steps: before }, { $set: { steps, updatedAt: new Date() } });
      print(`  -> modified=${r.modifiedCount}`);
    }
  }
}
