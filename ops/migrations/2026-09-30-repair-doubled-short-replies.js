// Repair assistant messages persisted twice by the executeStreaming short-reply bug
// (engine run.ts: a streamed reply of <= 8 chars was published by the on_chain_end
// fallback AND by the post-loop buffer drain -> "4417" stored as "44174417").
//
// A message is repaired ONLY when all hold (exact, verifiable detection):
//   1. role === 'assistant', content is a string of even length <= 16 whose two halves are equal;
//   2. the half is <= 8 chars (the bug only fired for replies that fit the 8-char look-ahead);
//   3. the message's run (metadata.runId) has a runEvents record whose run_complete
//      output.data.response is EXACTLY the half, i.e. the graph really answered `half`.
// Anything else is left alone and counted (no-runEvents / response-mismatch).
//
// Before writing, each conversation's original messages array is copied to
// user_conversation_backups (reason tagged). The update is conditional on the message
// content being unchanged. Re-running after apply finds nothing to do.
// RUN:  { echo 'var APPLY=false;'; cat this.js; } | mongosh <redbtn>   (dry run)
//       { echo 'var APPLY=true;';  cat this.js; } | mongosh <redbtn>   (apply)
if (typeof APPLY === 'undefined') var APPLY = false;
if (typeof USER_IDS === 'undefined') var USER_IDS = ['69a0b790a0ae8660290a78da'];
// var ALL_USERS = true;  -> scan every user's conversations (use with APPLY=false to count).
const REASON = 'repair-doubled-short-replies 2026-09-30';

// userId is stored as an ObjectId on most documents and as a string on a few.
const IDS = USER_IDS.concat(USER_IDS.map((u) => ObjectId(u)));
const candidates = db.user_conversations.aggregate([
  { $match: (typeof ALL_USERS !== 'undefined' && ALL_USERS) ? {} : { userId: { $in: IDS } } },
  { $unwind: { path: '$messages', includeArrayIndex: 'idx' } },
  { $match: { 'messages.role': 'assistant', 'messages.content': { $type: 'string' } } },
  { $match: { $expr: { $and: [
    { $lte: [{ $strLenCP: '$messages.content' }, 16] },
    { $gte: [{ $strLenCP: '$messages.content' }, 2] },
  ] } } },
  { $project: { idx: 1, msg: '$messages', title: 1 } },
]).toArray();

let doubled = 0, fixed = 0, noEvents = 0, mismatch = 0;
const touchedConvs = new Set();
for (const c of candidates) {
  const s = c.msg.content;
  if (s.length % 2 !== 0) continue;
  const half = s.slice(0, s.length / 2);
  if (half + half !== s || half.length > 8) continue;
  doubled++;
  const runId = (c.msg.metadata && c.msg.metadata.runId) || c.msg.runId;
  const re = runId ? db.runEvents.findOne({ runId }, { events: { $elemMatch: { type: 'run_complete' } } }) : null;
  const done = re && re.events && re.events[0];
  const resp = done && done.data && done.data.output && done.data.output.data && done.data.output.data.response;
  if (!done) { noEvents++; print(`SKIP no-runEvents  conv=${c._id} msg=${c.msg.id} run=${runId} content=${JSON.stringify(s)}`); continue; }
  if (resp !== half) { mismatch++; print(`SKIP mismatch      conv=${c._id} msg=${c.msg.id} run=${runId} content=${JSON.stringify(s)} response=${JSON.stringify(resp)}`); continue; }
  print(`${APPLY ? 'FIX ' : 'WOULD FIX'} conv=${c._id} "${c.title || ''}" msg=${c.msg.id} ${JSON.stringify(s)} -> ${JSON.stringify(half)}`);
  if (!APPLY) { fixed++; continue; }
  if (!touchedConvs.has(String(c._id))) {
    const orig = db.user_conversations.findOne({ _id: c._id }, { messages: 1 });
    db.user_conversation_backups.insertOne({ conversationId: c._id, reason: REASON, messages: orig.messages, takenAt: new Date() });
    touchedConvs.add(String(c._id));
  }
  const r = db.user_conversations.updateOne(
    { _id: c._id, messages: { $elemMatch: { id: c.msg.id, content: s } } },
    { $set: { 'messages.$.content': half } },
  );
  if (r.modifiedCount === 1) fixed++;
  else print(`   -> not modified (changed concurrently?)`);
}
print(`${APPLY ? 'APPLY' : 'DRY-RUN'}: short assistant messages scanned=${candidates.length} half+half=${doubled} ` +
  `${APPLY ? 'fixed' : 'would fix'}=${fixed} skipped(no runEvents)=${noEvents} skipped(response mismatch)=${mismatch} conversations=${APPLY ? touchedConvs.size : '-'}`);
