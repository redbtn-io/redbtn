# Automation Concurrency Limits

Atomic, zombie-aware concurrency control for automation runs.
Module: [`src/lib/run/automation-concurrency.ts`](../src/lib/run/automation-concurrency.ts).

## Why

Automations previously supported only a binary per-trigger knob:

- `skip` — cap 1, drop overflow.
- `allow` — unlimited.

On **2026-07-15** the coordinator webhook (`allow`) let a delivery burst spawn
9–17 concurrent runs, which OOM-restarted the engine and mass-interrupted every
in-flight run (killing several Red Ops worker runs mid-task). Two root causes:

1. **No numeric cap** — `allow` meant literally unlimited.
2. Any naive fix (read the running count, then start if under the cap) is
   **racy**: a thundering herd of near-simultaneous triggers all read "0
   running" before any registers, and all start. Enforcement must be **atomic**.

## Model

`automation.concurrency` and `automation.triggers[].concurrency` accept either
the legacy bare-mode string **or** the numeric object form:

```jsonc
// TOTAL scope, across ALL triggers of the automation
"concurrency": { "mode": "skip", "max": 3 }

// PER-TRIGGER override (tighter than total), on a specific trigger
"triggers": [{ "id": "webhook-1", "concurrency": { "mode": "queue", "max": 1 } }]
```

- `mode`: `allow` (never blocks) · `skip` (drop at cap) · `queue` (caller
  enqueues) · `interrupt` (make room by cancelling the oldest in-flight run(s),
  then start).
- `max`: positive integer cap. Ignored for `allow`. Omitted with a blocking mode
  → the legacy cap of **1** (so `"skip"` still means cap-1).

A run is admitted only when **both** the total scope and the applicable
per-trigger scope have room. A missing per-trigger override means that trigger is
bounded solely by the total cap. Legacy strings normalise exactly to the old
behaviour, so existing automations are unchanged until reconfigured.

### Interrupt is per-scope, cap-aware, and atomic

`interrupt` is evaluated **independently per scope**, inside the same acquire
script — it is *not* a blanket "cancel everything and start":

- Each scope's `interrupt` frees only **its own** scope: a per-trigger
  `interrupt` interrupts that trigger's runs; a total `interrupt` interrupts
  across the automation. (Previously a per-trigger `interrupt` at cap wrongly
  reported `skip`, and a total `interrupt` ignored per-trigger caps.)
- It evicts only the **oldest** runs needed to bring the scope down to `cap-1`,
  so the new run lands exactly at the cap — `max` is respected (interrupt no
  longer means "cancel all").
- A blocking (`skip`/`queue`) cap on the **other** scope is a hard ceiling that
  `interrupt` cannot bypass; when any scope hard-blocks, **nothing** is evicted.
- Target selection **and** eviction happen inside `ACQUIRE_LUA`, so there is no
  read-then-act window (zombies are pruned first, so a crashed run is never
  reported as an interrupt target). The admission returns `interruptRunIds` — the
  runs already removed from tracking that the caller must cancel.

## Atomicity (requirement 1)

`tryAcquireAutomationSlot` runs a single Redis **Lua** script (`ACQUIRE_LUA`)
that prunes zombies, counts, checks both caps, and conditionally registers the
run — one indivisible step. Two triggers racing for the last slot cannot both
win. The total and per-trigger keys share an `{automationId}` hash tag so they
sit in one Redis Cluster slot and the script can mutate both.

## Zombie exclusion (requirement 2)

Each slot is a sorted-set member (`member = runId`) scored by the run's
`lastProgressAt` heartbeat (epoch ms), under
`automation:concurrency:{automationId}:total` and
`:{automationId}:trigger:{triggerId}`. Before counting, the script prunes every
member older than `RunConfig.AUTOMATION_CONCURRENCY_STALE_MS` (30 min, = the
run-progress stale window). So:

- A **live** run refreshes its score via `heartbeatAutomationSlot` and holds its
  slot indefinitely while it makes progress.
- A **crashed** engine's runs stop heartbeating, age out, and free their slots —
  they never permanently hold cap slots, and `countActive` / `listActiveSlots`
  never report them ("Active Runs shows phantom runs forever" fix).

`RunPublisher` wires this automatically for runs the engine executes: it
heartbeats the slot on progress (throttled ~15s) and releases it on
complete/fail/interrupt. Release is best-effort; the stale-window prune is the
correctness backstop when the process dies first.

## Integration contract

**Engine (this repo) — done.** Primitive + type + normaliser +
`RunPublisher`/`run()` heartbeat & release wiring + the `update_automation`
native-tool schema/validation. Exported from the package root.

**Webapp (`@redbtn/webapp`) — remaining, tracked in the PR:**

1. **Webhook receiver** (`api/v1/automations/[automationId]/trigger`) and
   **cron scheduler**: replace the `skip`/`allow` branch with a call to
   `tryAcquireAutomationSlot(redis, { automationId, triggerId, runId,
   concurrency, triggerConcurrency })` **before** creating the run. Honour the
   returned `decision`: `allow` → proceed · `skip` → drop · `queue` → enqueue ·
   `interrupt` → cancel `interruptRunIds` then proceed. Pass the acquired slot
   into `run()` via `options.concurrencySlot`.
2. **Automation model / type** (`Automation.ts`, `types/automation.ts`): widen
   `concurrency` to `mode: skip|queue|allow(|interrupt), max?` + per-trigger
   override (accept the legacy string for back-compat).
3. **Automation editor UI**: expose total `{ mode, max }` + per-trigger override.
