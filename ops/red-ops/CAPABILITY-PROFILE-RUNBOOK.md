# Red Ops capability profile — apply / verify / roll back

**Artifact:** [`red-ops-capability-profile.json`](./red-ops-capability-profile.json)
**Typed source:** [`src/lib/permissions/redops-profile.ts`](../../src/lib/permissions/redops-profile.ts)
**Tests:** [`tests/permissions/redops-exec-profile.test.ts`](../../tests/permissions/redops-exec-profile.test.ts)
**Board item:** `[P0 security] Red Ops graphs: attach exec capabilities profile + plan ENFORCE_INTERNAL_SERVICE_ORIGIN`

Like everything else in `ops/red-ops/`, the JSON here is the source of truth: edit it (via the
typed const it is generated from), run the tests, then apply it. Nothing reads it at runtime.

---

## 1. The problem this fixes

`exec` is a **fail-closed** capability (`src/lib/permissions/enforce.ts:95-109`). A run whose graph
declares no capability profile is denied every `exec` tool call outright. The three Red Ops graphs
declare **no profile**:

| graphId | Name | Published | `capabilities` today |
|---|---|---|---|
| `tHXXSTFtOuM9` | Red Coordinator | ✅ v2 | *(none)* |
| `eCrxF8-glwgW` | Red Worker | ✅ v3 | *(none)* |
| `red-reviewer` | Red Ops Reviewer | ✅ v1 | *(none)* |

All three run the single node `red-ops-pipeline-executor`, whose only tool steps are three
`ssh_shell` calls (step indices 5, 9, 12 — claim, CLI session, completion). Every fleet job the
Coordinator, Worker and Reviewer perform goes through those calls.

They work today **only** because `PERMISSIONS_SHADOW=true` downgrades the denial to a logged
shadow-block (`src/lib/tools/native-registry.ts:348-366`). The day shadow mode is turned off, all
Red Ops SSH stops fleet-wide. Attaching this profile removes that dependency.

Fork-copies inherit config, so fixing these three sources propagates to forks.

### Why the selector must be `*`

`src/lib/permissions/tool-map.ts:107-111` (`envId`) extracts the exec address from the call's
`environmentId` argument and returns `{ addresses: [], unscoped: true }` when there is none. All
three `ssh_shell` steps pass **inline** `host` / `port` / `user` / `sshKey` and **no**
`environmentId`, so every Red Ops exec call is unscoped. `enforce.ts` step 3 requires a true
wildcard grant for an unscoped call and explicitly rejects prefix/exact selectors.

**A per-host selector such as `alphaSystem` would deny 100% of Red Ops SSH** — the exact outage
this profile exists to prevent. That failure mode is pinned by the test
`DENIES the same call under a non-wildcard selector such as "alphaSystem"`.

### Why `state` + `knowledge` are also granted

Attaching **any** profile flips state/knowledge from fail-open (unrestricted) to enforced.
`red-ops-pipeline-executor` calls no State or Knowledge tool today — everything that is not one of
the three `ssh_shell` steps is a `transform` step, which the capability layer does not gate — so an
exec-only profile would work right now. It is still the wrong choice:

- **It would be a silent trap.** The Coordinator carried a triage tier that read/wrote the
  `red-ops/*` State namespaces (see [`README.md`](./README.md)); re-adding any such step under an
  exec-only profile fails closed with no warning at author time.
- **It buys no containment.** `exec:execute` on `*` is arbitrary shell as `alpha` on the fleet
  host, which already subsumes every data path a State jail could protect.

The data grants make attaching this profile a **pure addition of exec authority with zero change to
data behavior**. `computer:control` is deliberately omitted — these graphs call no `desktop_*` tool,
and computer is fail-closed, so withholding it takes nothing away.

---

## 2. Precondition — the API must accept `capabilities` (NOT TRUE YET)

> **This apply step is blocked until the webapp work unit ships.** Verified against the live API on
> 2026-07-28: there is currently **no** supported path that writes a `capabilities` field to a graph.

| Path | Accepted fields | `capabilities`? |
|---|---|---|
| `PATCH /api/graphs/{graphId}` (canonical; `/api/v1/graphs/{graphId}` aliases it) | `name, description, nodes, edges, tier, newGraphId, layout, graphType, isPublic, tags, inputSchema, defaultInput, provides` — `src/app/api/graphs/[graphId]/route.ts:205` | ❌ dropped |
| `POST /api/graphs/{graphId}/patch` (`graph_patch` MCP) | ops may only target `/nodes /edges /name /description /tier /tags /layout /graphType /isPublic /inputSchema /defaultInput /provides /parameters` | ❌ rejected |
| `update_graph` MCP | same whitelist as the PATCH route | ❌ dropped |

The webapp unit must add `capabilities` to the destructured body and apply it
(`if (capabilities !== undefined) (graph as any).capabilities = capabilities;`), and/or add
`/capabilities` to the `graph_patch` allowed subtrees.

**The failure mode to guard against is a silent one:** an unrecognised field is ignored, so the
PATCH returns `200 OK` and the profile is simply not there. **Never treat a 2xx as success — step 4's
read-back is the only proof.**

Two facts that make the rest of this work, both pinned by tests:

- **The engine will see the field.** `models/Graph.ts` is `strict: true` and declares neither
  `published` nor `capabilities`, but Mongoose strict governs *writes*, not hydration — non-schema
  fields survive `toObject()`. (This is also why the write must go through the **webapp**, whose
  Graph model is `strict: false`, and never through the engine.)
- **Publishing does not hide it.** `GraphRegistry.getConfig` (`GraphRegistry.ts:110-119`) overrides
  only `nodes`/`edges` from the `published` sub-document and spreads every other top-level field
  through, so a top-level `capabilities` reaches `compiledGraph.config` →
  `resolveCapabilityProfile` → the native-tool gate. **No re-publish is required.**

---

## 3. Apply (idempotent)

Graphs are owned by `george@redbtn.io` (`userId 69a0b790a0ae8660290a78da`). Use a PAT for that
identity; do **not** edit raw Mongo.

```bash
export REDBTN_PAT=<george@redbtn.io PAT>
export PROFILE="$(cat ops/red-ops/red-ops-capability-profile.json)"

for GID in tHXXSTFtOuM9 eCrxF8-glwgW red-reviewer; do
  echo "{\"capabilities\": $PROFILE}" |
    curl -sS -X PATCH "https://app.redbtn.io/api/graphs/$GID" \
      -H "Authorization: Bearer $REDBTN_PAT" \
      -H 'Content-Type: application/json' \
      --data-binary @- | jq -c '{graphId, error}'
done
```

Idempotent by construction: the body is the whole profile object and the handler assigns it
wholesale, so re-running converges to the same state. Re-run freely.

---

## 4. Read back — the actual acceptance check

```bash
for GID in tHXXSTFtOuM9 eCrxF8-glwgW red-reviewer; do
  curl -sS "https://app.redbtn.io/api/graphs/$GID" \
    -H "Authorization: Bearer $REDBTN_PAT" |
    jq --argjson want "$PROFILE" \
       '.graph.graphId as $g | if (.graph.capabilities == $want)
          then "\($g): OK" else "\($g): MISMATCH -> \(.graph.capabilities)" end'
done
```

Expect three `OK` lines. `MISMATCH -> null` means the field was silently dropped → the webapp unit
(§2) has not shipped; **stop here**, the profile is not attached.

Equivalent MCP read-back: `get_graph` for each of the three graphIds, then compare `.capabilities`.

---

## 5. Confirm cache invalidation

Workers cache compiled graphs for 5 minutes (`GRAPH_REGISTRY_CACHE_TTL_MS`), so an attached profile
is not live until caches drop it. Two mechanisms already cover this:

1. The PATCH handler publishes the graphId to the Redis channel `graph:invalidate` on every
   successful save (`src/app/api/graphs/[graphId]/route.ts`, right after `graph.save()`).
2. `GraphRegistry.watchCollection` also invalidates from a Mongo change stream on update/replace.

Confirm subscribers received it — watch the channel while re-running the PATCH from §3:

```bash
# terminal 1 — fleet Redis is on .3
redis-cli -h 10.100.0.3 -a "$REDIS_PASSWORD" psubscribe 'graph:invalidate'
# terminal 2 — re-run the §3 apply loop; expect one message per graphId
```

Worker-side confirmation (each engine logs the clear):

```
[GraphRegistry] Cache invalidated via pub/sub for graph: tHXXSTFtOuM9 (N entries cleared)
```

Manual fallback if a subscriber missed it:

```bash
for GID in tHXXSTFtOuM9 eCrxF8-glwgW red-reviewer; do
  redis-cli -h 10.100.0.3 -a "$REDIS_PASSWORD" publish graph:invalidate "$GID"
done
```

Worst case, waiting 5 minutes for the TTL achieves the same thing.

---

## 6. Verify the shadow-blocks stop

Capability shadow-blocks are recorded in **two** places by
`native-registry.ts:348-366` — do not confuse them with the rate/audit gates the sibling unit owns:

| Signal | Where | Written by |
|---|---|---|
| `shadow_capability` exec attempts | `redbtn.execaudits` | `auditAttempt(...)` |
| Capability denial records | `redbtn.capabilitydenials` | `persistDenial(...)` → `POST /api/v1/permissions/denials` |
| Worker stdout | engine logs | `[NativeRegistry] capability SHADOW-DENY: tool=ssh_shell resource=exec ...` |

**Capture a baseline BEFORE applying** (an "after" count of zero proves nothing on its own), then
re-check after a few Red Ops runs have completed. Scope every query by time and cap it —
ad-hoc unbounded queries on the prod Mongo have COLLSCAN-blocked clients before:

```js
// pre- and post-apply, same window length
db.execaudits.countDocuments(
  { blockCode: 'shadow_capability', graphId: { $in: ['tHXXSTFtOuM9','eCrxF8-glwgW','red-reviewer'] },
    createdAt: { $gte: ISODate('<window start>') } },
  { maxTimeMS: 5000 })
```

The cheapest live signal needs no DB at all: grep an engine's logs for `SHADOW-DENY` and
`resource=exec` after a Red Ops run. Zero occurrences across all three roles is the acceptance
condition.

Only once that holds is it safe to consider turning `PERMISSIONS_SHADOW` off — and note that flip
also un-shadows the **rate-limit** gate, which is a separate readiness question owned by
[`docs/redops-exec-guard-readiness.md`](../../docs/redops-exec-guard-readiness.md).

---

## 7. Roll back

Remove the field; the graphs return to UNPROFILED (and to depending on shadow mode):

```bash
for GID in tHXXSTFtOuM9 eCrxF8-glwgW red-reviewer; do
  curl -sS -X PATCH "https://app.redbtn.io/api/graphs/$GID" \
    -H "Authorization: Bearer $REDBTN_PAT" -H 'Content-Type: application/json' \
    -d '{"capabilities": null}'
done
```

Then re-run §4 (expect `null`) and §5. Rollback is only safe while `PERMISSIONS_SHADOW=true`; with
shadow off it stops the fleet.

---

## 8. Observations recorded while writing this

- **`red-coordinator.graph.after.json` in this directory is stale.** It describes a three-node
  `gate → triage → coordinator` graph; live `tHXXSTFtOuM9` (published v2, 2026-07-20) is a single
  `executor` node running `red-ops-pipeline-executor`. The profile applies to the live graph either
  way — top-level `capabilities` is independent of nodes/edges — but the rollback artifact that
  README points at no longer matches production. Worth a follow-up card.
- **The sibling readiness doc reports zero `shadow_capability` rows** in `execaudits` across 20,045
  records, which sits oddly beside the premise that Red Ops exec survives only via shadow. The two
  gates write different collections (`capabilitydenials` vs `execaudits`), so the capability-side
  baseline in §6 should be taken from `capabilitydenials` as well before concluding anything. Left
  as evidence to gather at apply time rather than a claim.
