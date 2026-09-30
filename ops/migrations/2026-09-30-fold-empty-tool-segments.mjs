// Fold empty tool-only assistant segments into the reply that follows them.
//
// Turn-by-turn segmentation (RunPublisher.ensureSegment) persists a reply as
// [assistant "" (metadata.kind 'tool', toolExecutions), assistant "text"
// (metadata.kind 'content')]. The empty segment carries no text; context
// loaders now skip it (memory.getContextForConversation), so this repair is
// OPTIONAL cleanup of stored history.
//
// A message is folded ONLY when all hold:
//   1. role === 'assistant' and its content is empty/whitespace;
//   2. the NEXT message is an assistant message with non-empty content;
//   3. both carry the same metadata.runId (same run).
// Folding appends its toolExecutions (and thinking, when the next message has
// none) to the next message, then removes it. Everything else is left alone.
//
// Before writing, each conversation's original messages array is copied to
// user_conversation_backups (reason tagged). The write is conditional on the
// messages array being unchanged since it was read. Re-running finds nothing.
//
// RUN (dry run by default):
//   MONGODB_URI=... node ops/migrations/2026-09-30-fold-empty-tool-segments.mjs --db redbtn
//   ... --apply                 write
//   ... --user <userId>         limit to one user (repeatable)
//   ... --verbose               print every fold
import { MongoClient } from 'mongodb';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const APPLY = argv.includes('--apply');
const VERBOSE = argv.includes('--verbose');
const USERS = argv.flatMap((a, i) => (a === '--user' ? [argv[i + 1]] : []));
const REASON = 'fold-empty-tool-segments 2026-09-30';

export function isBlank(content) {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  if (Array.isArray(content)) {
    return !content.some((p) => (typeof p === 'string' ? p.trim() : p && (p.type !== 'text' || (p.text || '').trim())));
  }
  return false;
}

const runIdOf = (m) => (m && m.metadata && m.metadata.runId) || (m && m.runId) || null;

/** Pure fold: returns { messages, folded } without mutating the input. */
export function foldEmptyToolSegments(messages) {
  // Walk backwards so a run of several empty segments all fold into the reply.
  const out = [];
  let folded = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const next = out[0];
    const run = runIdOf(m);
    if (
      m && m.role === 'assistant' && isBlank(m.content) &&
      next && next.role === 'assistant' && !isBlank(next.content) &&
      run && runIdOf(next) === run
    ) {
      const merged = { ...next };
      const tools = [...(Array.isArray(m.toolExecutions) ? m.toolExecutions : []), ...(Array.isArray(next.toolExecutions) ? next.toolExecutions : [])];
      if (tools.length) merged.toolExecutions = tools;
      if (!merged.thinking && typeof m.thinking === 'string' && m.thinking.trim()) merged.thinking = m.thinking;
      out[0] = merged;
      folded++;
      continue;
    }
    out.unshift(m);
  }
  return { messages: out, folded };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI is required'); process.exit(1); }
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const db = client.db(arg('--db') || undefined);
    const { ObjectId } = await import('mongodb');
    const match = USERS.length
      ? { userId: { $in: [...USERS, ...USERS.filter((u) => ObjectId.isValid(u)).map((u) => new ObjectId(u))] } }
      : {};
    const convs = db.collection('user_conversations');
    let scanned = 0, touched = 0, folds = 0, notModified = 0;
    for await (const c of convs.find({ ...match, 'messages.role': 'assistant' }, { projection: { messages: 1, title: 1, userId: 1 } })) {
      scanned++;
      const original = Array.isArray(c.messages) ? c.messages : [];
      const { messages, folded } = foldEmptyToolSegments(original);
      if (!folded) continue;
      touched++;
      folds += folded;
      if (VERBOSE || !APPLY) console.log(`${APPLY ? 'FOLD' : 'WOULD FOLD'} conv=${c._id} user=${c.userId} "${c.title || ''}" folds=${folded}`);
      if (!APPLY) continue;
      await db.collection('user_conversation_backups').insertOne({ conversationId: c._id, reason: REASON, messages: original, takenAt: new Date() });
      const r = await convs.updateOne({ _id: c._id, messages: original }, { $set: { messages } });
      if (r.modifiedCount !== 1) { notModified++; console.log(`   -> not modified (changed concurrently?) conv=${c._id}`); }
    }
    console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'} db=${db.databaseName}: conversations scanned=${scanned} ` +
      `with empty tool segments=${touched} segments ${APPLY ? 'folded' : 'to fold'}=${folds}${APPLY ? ` not-modified=${notModified}` : ''}`);
  } finally {
    await client.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
