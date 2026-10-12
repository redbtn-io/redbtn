// Install / update the platform worker graph `workspace-task` (used by the
// `workspace_task` native tool, engine 0.0.296+) as a SYSTEM graph.
//
// RUN (dry run by default):
//   MONGODB_URI=... node ops/workspace-task/seed.mjs --db redbtn [--db redbtn-beta]
//   ... --apply      write
// AFTER: redis PUBLISH graph:invalidate workspace-task (or wait the 5-minute GraphRegistry TTL).
// Idempotent: an unchanged graph is left alone; a changed one is replaced (nodes, edges,
// description, capabilities), the previous document saved to graph_seed_backups.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { MongoClient } from 'mongodb';

const SYSTEM_USER_ID = '000000000000000000000001';
const here = path.dirname(fileURLToPath(import.meta.url));
const graph = JSON.parse(readFileSync(path.join(here, 'workspace-task.graph.json'), 'utf8'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const DBS = argv.flatMap((a, i) => (a === '--db' ? [argv[i + 1]] : [])).filter(Boolean);
const uri = process.env.MONGODB_URI;
if (!uri || DBS.length === 0) {
  console.error('usage: MONGODB_URI=... node ops/workspace-task/seed.mjs --db <name> [--db <name>] [--apply]');
  process.exit(2);
}

const managed = ['name', 'description', 'graphType', 'tier', 'isPublic', 'isSystem', 'tags', 'capabilities', 'nodes', 'edges'];
const client = new MongoClient(uri);
await client.connect();
try {
  for (const dbn of DBS) {
    const col = client.db(dbn).collection('graphs');
    const existing = await col.findOne({ graphId: graph.graphId });
    const desired = Object.fromEntries(managed.map((k) => [k, graph[k]]));
    if (existing) {
      const same = managed.every((k) => JSON.stringify(existing[k]) === JSON.stringify(desired[k]));
      if (same) { console.log(`${dbn}: ${graph.graphId} up to date`); continue; }
      console.log(`${dbn}: ${graph.graphId} differs -> ${APPLY ? 'updating' : 'would update'}`);
      if (APPLY) {
        await client.db(dbn).collection('graph_seed_backups').insertOne({ graphId: graph.graphId, at: new Date(), previous: existing });
        await col.updateOne({ graphId: graph.graphId }, { $set: { ...desired, userId: SYSTEM_USER_ID, updatedAt: new Date() }, $unset: { draft: '', published: '' } });
      }
    } else {
      console.log(`${dbn}: ${graph.graphId} missing -> ${APPLY ? 'inserting' : 'would insert'}`);
      if (APPLY) {
        await col.insertOne({ graphId: graph.graphId, userId: SYSTEM_USER_ID, ...desired, isDefault: false, isImmutable: false, version: '1.0.0', layout: {}, createdAt: new Date(), updatedAt: new Date() });
      }
    }
  }
} finally {
  await client.close();
}
