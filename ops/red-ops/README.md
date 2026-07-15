# Red Ops — quiet-tick triage gate (Phase 1)

The Red Coordinator (graph `tHXXSTFtOuM9`) fires every 15 minutes — 96 ticks/day — and each
tick was a full CLI session over SSH. Most ticks have nothing to do. This directory holds the
**deployed** config for the triage node that ends those ticks before the session starts, plus
the before/after of the graph it was wired into.

These configs live in MongoDB, not in the engine's runtime. They are committed here because
they are the graph that dispatches the fleet: this gives them review, history, a rollback
artifact, and — via `tests/red-ops/triage-node.test.ts` — actual tests. **The JSON here is the
source of truth: edit it, run the tests, then deploy it.** Nothing reads these files at runtime.

## The tier

```
__start__ → gate ──data.route=run──→ triage ──data.triageRoute=run──→ coordinator → __end__
              │                        │
              └── fallback __end__     └── fallback __end__   ← quiet tick ends here, for free
```

`gate` (`red-ops-gate`) and `coordinator` (`red-ops-coordinator`) are **unchanged**. The only
graph edit was retargeting the gate's `run` branch at `triage` and adding the triage edge.

## What triage costs

Three tiers, cheapest first — the neuron is the *last* resort, not the first:

1. **Free / deterministic.** Fetch `/api/board` (open statuses **plus done** — see below) and
   `red-ops/state`, diff both against the `red-ops/triage` baseline, and probe in-flight runs
   with `get_run`. Clear cases never reach an LLM:
   - **run** — operator directive, a failed worker run, a finished worker run to reconcile, an
     inbox card with capacity, a **new human comment** on any card.
   - **stop** — nothing new on the board and every dispatched run is still running. This is the
     common case and it costs zero tokens.
2. **~$0.0002 / gemini-2.5-flash.** Only genuinely *ambiguous* changes (agent chatter on a
   changed card, a blocked/needs-input thread) go to the `become-gemma` neuron, which answers
   one question: is anything actionable this tick?
3. **The CLI coordinator.** Reached only when tier 1 or 2 says so.

A verdict of "not actionable" is memoised against the card's `(status, commentCount, updatedAt)`
signature, so an unchanged `needs-input` card waiting on George is **not** re-adjudicated 96
times a day. Any change to that card re-opens the question.

## Fail open — the load-bearing invariant

A false skip stalls the fleet silently; a false run costs one session. So every uncertainty
routes to the coordinator, exactly as before this change:

| Situation | Route |
|---|---|
| `/api/board` fetch failed | run |
| No baseline yet (first tick) | run |
| More changed cards / in-flight runs than the fetch caps | run |
| Neuron returned garbage, or its step errored | run |
| Gemini daily budget blown | run (neuron skipped) |
| `triage: false` in `red-ops/config` | run (kill switch) |

## Guardrails

- **Gemini spend.** The key is pay-per-use and fails open, so the node meters itself: every
  neuron call adds its estimated cost to `red-ops/triage.spend` (day-rolling). Past
  `geminiDailyBudgetUsd` (default $1) **or** `geminiDailyCallCap` (default 300), the neuron is
  switched off for the rest of the day, an `@george —` note is posted **once**, and triage
  degrades to deterministic-only (still saving most quiet ticks) rather than failing shut.
  Both limits are overridable live in `red-ops/config`.
- **Iteration caps.** Both fetch loops are bounded: `maxRunProbes` (8) and `maxCommentFetches`
  (4). Exceeding the comment cap fails open rather than triaging a truncated view of the board.
  The neuron itself carries `maxToolIterations: 1` and `maxTokens: 512`.

## Done is not deaf

`red-ops/config` STANDING 1 makes a George comment on a recently-**done** card real direction.
The board fetch therefore asks for `done` as well as the open statuses, and done cards inside
`triageDoneWindowHours` (default 168h) are diffed like any other. A gate that only looked at
open cards would have silently swallowed that direction on every quiet tick.

## Files

| File | What it is |
|---|---|
| `red-ops-triage.node.json` | The `red-ops-triage` node, exactly as deployed. |
| `red-ops-reviewer.node.json` | The `red-ops-reviewer` node, exactly as deployed. |
| `red-coordinator.graph.after.json` | Graph `tHXXSTFtOuM9` as it is now. |
| `red-coordinator.graph.before.json` | Graph as it was — the rollback target. |

## The reviewer node (`red-ops-reviewer`)

The INDEPENDENT last gate before prod: given a PR it re-runs CI, reviews the diff,
squash-merges to base, promotes `beta`→`main`, verifies the deploy, and flags
`@george` on any failure. Like the triage node it is entirely `{{...}}` templates,
so `tests/red-ops/reviewer-result-parser.test.ts` drives the ACTUAL step
expressions in `red-ops-reviewer.node.json` through the engine's own `resolveValue`
— the test guards the shipping logic, not a copy.

**Merge guard never overwrites the model's reason.** When the guard blocks a real
failure it PRESERVES the model's own `reason` verbatim and records its own decision
in separate fields (`guardVerdict` / `guardReason`), so the coordinator and board
see the actionable reason (e.g. "promotion PR conflicting") — not a generic guard
label. Any AUTO-MERGE block that is not a clean merged / verify-pending state also
sets `needsGeorge`. The live MCP node embeds this same JS as template strings; this
JSON is the source of truth and the two are kept in sync (deploy with the same
`PUT /api/v1/nodes/red-ops-reviewer` used for the triage node, or `node_patch`).

**Promotion must never delete the base branch (2026-07-15).** The AUTO-MERGE step
used to run `gh pr merge <pr> --squash --delete-branch` unconditionally. A promote
`beta`→`main` PR's HEAD ref **is** `beta`, so `--delete-branch` deleted `refs/heads/beta`
outright — twice on 2026-07-15 (PR #455, #457), which broke the "workers branch from
beta" convention and RedRun's beta-track autoDeploy. Two guards now prevent this:

1. **Prompt rule (prevention).** Step 5 forbids `--delete-branch` on any *permanent*
   branch (`beta`/`main`/`master`/`prod`); a permanent head is merged with the plain
   `gh pr merge --squash --match-head-commit` form. Only disposable feature branches
   are cleaned up.
2. **Branch-protection guard (self-heal).** After the merge guard confirms a merge, a
   deterministic `data.betaGuardCommand` / `data.betaGuard` / `data.result` triple
   checks whether the merged PR's permanent head branch still exists and, if it was
   deleted, **recreates it at the base-branch tip** (a create-ref — it never deletes)
   and sets `needsGeorge` with `betaGuardStatus=RECREATED`. `tests/red-ops/reviewer-result-parser.test.ts`
   covers both guards.

## Deploying / rolling back

Deploy the node (`nodeId` at the top level, config fields flattened alongside it):

```bash
jq '{nodeId} + .config' ops/red-ops/red-ops-triage.node.json |
  curl -sX POST https://app.redbtn.io/api/v1/nodes \
    -H "Authorization: Bearer $REDBTN_PAT" -H 'Content-Type: application/json' --data-binary @-
```

(Use `PUT /api/v1/nodes/red-ops-triage` to update an existing one.)

**Roll back with `update_graph`, not `graph_patch`.** `graph_patch` currently rejects any patch
to a graph with conditional-edge `targets` — it reads them back as an empty Mongoose Map and
fails its own validation with `CONDITIONAL_MISSING_TARGETS`. That is a pre-existing webapp bug
(it reproduces on a graph freshly written by `update_graph`), and it means the patch tool cannot
be used to undo this. `update_graph` with the full `edges` array from
`red-coordinator.graph.before.json` works and is the tested rollback path.
