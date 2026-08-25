#!/usr/bin/env node
/**
 * Verify that a live red-ops MCP node's deployed fullConfig still has a
 * `config` object on every step. Catches the 2026-07-19 class of incident:
 * something replaced `red-ops-reviewer`'s live steps with a schema-only
 * shape (stepIndex/type/configurable, no config), which is exactly what
 * get_node/GET /api/v1/nodes returns for `steps` (by design) but is fatal
 * if it's ever written BACK as the node's `steps`. Every run then failed
 * instantly on step 1 with "Cannot read properties of undefined (reading
 * 'operation')" -- 1060+ runs, fleet-wide reviewer outage -- before anyone
 * noticed. This script is the cheap check that would have caught it in
 * one call instead of via a pile of unreviewed PRs.
 *
 * Usage:
 *   REDBTN_PAT=rpat_... node ops/red-ops/verify-deployed.js [nodeId ...]
 *
 * Exits non-zero (and prints which steps are broken) if any checked node's
 * live fullConfig is missing config on one or more steps, or if the live
 * step count doesn't match the committed ops/red-ops/<nodeId>.node.json.
 */

const fs = require('node:fs');
const path = require('node:path');

const API_BASE = process.env.REDBTN_API_BASE || 'https://app.redbtn.io';
const PAT = process.env.REDBTN_PAT;

const DEFAULT_NODE_IDS = ['red-ops-triage', 'red-ops-reviewer'];

async function fetchLiveNode(nodeId) {
  const res = await fetch(`${API_BASE}/api/v1/nodes/${nodeId}`, {
    headers: { Authorization: `Bearer ${PAT}` },
  });
  if (!res.ok) {
    throw new Error(`GET /api/v1/nodes/${nodeId} -> HTTP ${res.status}`);
  }
  return res.json();
}

function loadCommittedStepCount(nodeId) {
  const file = path.join(__dirname, `${nodeId}.node.json`);
  if (!fs.existsSync(file)) return null;
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return doc.config.steps.length;
}

async function verifyNode(nodeId) {
  const live = await fetchLiveNode(nodeId);
  const fullConfig = live.fullConfig || [];
  const missing = fullConfig
    .map((step, i) => (step && step.config && Object.keys(step.config).length > 0 ? null : i))
    .filter((i) => i !== null);

  const committedCount = loadCommittedStepCount(nodeId);
  const countMismatch =
    committedCount !== null && committedCount !== fullConfig.length
      ? { committedCount, liveCount: fullConfig.length }
      : null;

  return { nodeId, liveStepCount: fullConfig.length, missing, countMismatch };
}

async function main() {
  if (!PAT) {
    console.error('REDBTN_PAT env var is required.');
    process.exit(2);
  }
  const nodeIds = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_NODE_IDS;
  let failed = false;

  for (const nodeId of nodeIds) {
    const result = await verifyNode(nodeId);
    const ok = result.missing.length === 0 && !result.countMismatch;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${nodeId} (${result.liveStepCount} live steps)`);
    if (result.missing.length > 0) {
      failed = true;
      console.log(`  missing config at step index: ${result.missing.join(', ')}`);
    }
    if (result.countMismatch) {
      failed = true;
      console.log(
        `  step count drift: committed ops/red-ops/${nodeId}.node.json has ${result.countMismatch.committedCount}, live has ${result.countMismatch.liveCount}`,
      );
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(2);
});
