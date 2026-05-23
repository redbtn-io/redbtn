# Run Progress Heartbeat Contract

`lastProgressAt` is the shared liveness signal for graph runs. It answers one
question only: has this run made real progress recently?

It is independent of total runtime. A six-hour run is healthy if this heartbeat
keeps advancing; a five-minute run is hung if the heartbeat stops advancing past
the stale window.

## Writers

The engine refreshes `lastProgressAt` whenever it observes real progress:

- a graph node or universal-node step advances
- user-visible content or tool-output events are published
- tool progress/output is emitted

Status-only bookkeeping does not count as progress.

## Storage

- Redis run state: `run:{runId}` stores `RunState.lastProgressAt` as an ISO
  string. This is the active worker/watchdog source.
- Mongo `automationruns`: stores `lastProgressAt` as a `Date`, mirrored from the
  same heartbeat so scheduler concurrency checks and reapers can determine
  liveness without trusting `status: "running"` alone.
- Mongo `generations`: stores `lastProgressAt` as a `Date` when archive/recovery
  paths mirror run progress. Recovery and diagnostics read it with the same
  staleness semantics.
- Published run events keep their own `timestamp`; event publication refreshes
  the run heartbeat rather than creating a separate liveness clock.

## Readers

- Active workers and run watchdogs read Redis run state.
- Scheduler concurrency checks read `automationruns.lastProgressAt`.
- Reaper/recovery paths read Redis run state, `automationruns`, `generations`,
  and run locks.
- UI/API readers may display the field, but must not use elapsed runtime as a
  liveness substitute.

## Staleness

The shared default stale window is `RunConfig.RUN_PROGRESS_STALE_MS`
currently set to 30 minutes.

Callers that need stricter behavior may pass a smaller explicit window, but the
classification rule is shared:

- missing run state is stale
- missing `lastProgressAt` is stale
- null or unparsable `lastProgressAt` is stale
- `now - lastProgressAt >= staleAfterMs` is stale
- otherwise the run is alive

Use `classifyRunProgressStaleness()` for Mongo records and
`readRunProgress()` for Redis-backed run state.
