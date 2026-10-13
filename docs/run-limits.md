# Run-length limits (engine 0.0.301)

Every limit that can end or cap a long run, as of 0.0.301 (2026-10-13). The
trigger was a Become Ops CLI run (opus-5, graph a4JcJpRij9DV) that stopped
mid-job at 208 tool calls: the old CLI default of 50 turns gives a bridge
budget of 50*4+8 = 208 calls.

## Unlimited, per step (neuron step config)

| key | value | effect |
|---|---|---|
| `maxToolIterations` | `0` (or `"unlimited"`, `-1`) | API neurons: no tool-loop iteration cap. CLI neurons: no `--max-turns` (claude-code) and no run-bridge call budget. |
| `timeoutMs` | `0` (or `"unlimited"`) | CLI neurons: no per-step wall clock. The run-level timeout still applies. |
| `maxRepeatedToolCalls` | positive number, default `50`; `0` = off | Runaway guard: refuse a call that already returned an identical result for the same tool + identical args N times in a row. API loops end after 3 refusals in a row. |
| graph `config.timeout` (seconds) | `0` or `"unlimited"` | Run gets the platform ceiling: 7 days (`ENGINE_MAX_RUN_TIMEOUT_S`). |
| graph `config.progressIdleTimeoutMs` | ms | Raises the "no progress at all" watchdog (default 30 min) for a graph whose steps can sit silent longer. |

## Audit

| limit | where | value (0.0.301) | was | when hit | configurable |
|---|---|---|---|---|---|
| CLI bridge call budget | `lib/mcp/run-bridge.ts:921` via `lib/neurons/run-limits.ts` `bridgeCallBudget` | turns*4+8 = **2,008** by default; ceiling **20,000**; `Infinity` when unlimited | 208 (50 turns), ceiling 2,000 | further calls answered "tool budget exhausted"; the CLI wraps up | `maxToolIterations` per step |
| claude-code `--max-turns` | `executors/claudeCodeExecutor.ts:1237`, `run-limits.ts:26` | **500**; omitted when unlimited | 50 | CLI stops with `error_max_turns`; partial output returned | `maxToolIterations` |
| API tool-loop iterations | `executors/neuronExecutor.ts:2120`, `run-limits.ts:29` | **25**; `Infinity` when unlimited | 5 | wrap-up message "did not reach a final answer" | `maxToolIterations` |
| Runaway guard | `run-limits.ts:51` (`RepeatedCallGuard`) | **50** identical call + identical result in a row | (none) | that repeat is refused; API loop ends after 3 refusals | `maxRepeatedToolCalls` (0 = off) |
| CLI step wall clock (claude-code, agy, opencode, copilot) | `run-limits.ts:41`, e.g. `agyCliExecutor.ts:179` | **12 h**; none when `timeoutMs: 0` | 2 h claude-code, 30 min the others | child SIGTERM/SIGKILL, step fails | `timeoutMs` |
| Run wall clock | `functions/run.ts:471-472` | default **24 h**, ceiling **7 days** | 12 h / 24 h | run `RUN_CONFIG_TIMEOUT` | graph `config.timeout`, `ENGINE_DEFAULT_RUN_TIMEOUT_S`, `ENGINE_MAX_RUN_TIMEOUT_S`, `RUN_CONFIG_TIMEOUT_MS` |
| Run progress-idle watchdog | `functions/run.ts:451`, `run/types.ts:760` | 30 min with NO progress event | same | run aborted as stalled | graph `config.progressIdleTimeoutMs`, `RUN_PROGRESS_IDLE_TIMEOUT_MS` |
| LLM stream inactivity (one model call) | `neuronExecutor.ts:120` | 120 s without a token | same | that call fails (retry per step error handling) | step `inactivityTimeout` |
| Native/MCP tool idle (graph tool steps) | `executors/toolExecutor.ts:79` | 30 min without output | same | tool step killed | `NATIVE_TOOL_IDLE_TIMEOUT_MS`, `MCP_TOOL_IDLE_TIMEOUT_MS` |
| Bridge concurrency / per-frame / archive deadlines | `run-bridge.ts:177` and module header | 4 in flight, frame and archive-write deadlines | same | per-call refusal, never a run cap | no (security bounds, unchanged) |
| Orphan detection | `run/types.ts:784` (prod env `RUN_ORPHAN_STALE_MS=3600000`) | run with no owning process and stale heartbeat | same | reaped (or requeued on worker boot) | env |
| Workspace checkout lease | `workspaces/WorkspaceLifecycle.ts:48` | 30 min, renewed every 60 s while the step runs | same | only expires if the step/worker dies | no (not a run cap) |
| BullMQ job lock | redworker `src/worker.ts:235` | 10 min lock, renewed every 2 min, `maxStalledCount: 0` | same | only on a dead/blocked worker process | no (not a run cap) |
| Worker redeploy | redworker `src/drain.ts:17` + `ENGINE_DRAIN_TIMEOUT_MS=570000`; RedRun `stopGraceSeconds` (cap 1800 s) | in-flight runs get ~9.5 min to finish, then die | same | run killed; requeue-on-boot only if a booting replica sees it orphaned (recovery record TTL 3 h) | see "Redeploys" |
| redBoard liveness | redBoard `lib/dispatch.ts:338` (10 min) + redbtn `lastProgressAt` check (30 min) | asks redbtn before calling a run dead | same | card run marked blocked | redBoard |
| Context window | provider / CLI | claude-code auto-compacts; API loops keep every message | same | API: provider context error ends the step | keep API loops shorter or use a CLI neuron |
| Hub run SSE | hub `/api/v1/runs/:id/stream` | no idle timer found; a dropped stream does not end the run | n/a | client reconnects | n/a |

## Redeploys and multi-hour runs

A worker redeploy SIGTERMs the old container. The engine pauses intake and
drains for `ENGINE_DRAIN_TIMEOUT_MS` (570 s). RedRun waits `stopGraceSeconds`
(600 s, capped at 1,800 s) inside a redeploy job with a 25-minute deadline,
then kills the container. Anything still running dies. Requeue-on-boot
re-runs an orphan from scratch, and only when a booting replica sees it.
Rolling deploys boot the new replicas before the old one has finished
draining, so runs killed at the end of the drain are usually not requeued.

Options (none is a single PR):
1. **Detached long drain (recommended first).** RedRun: after cutover, stop
   the old container in the background with a long grace for apps that opt
   in (`appConfig.longDrain`, grace up to e.g. 24 h). The redeploy job must not
   wait for it, and the 1,800 s cap stays for everyone else. Worker: raise
   `ENGINE_DRAIN_TIMEOUT_MS` to match. New jobs already go to the new
   replicas (the old one paused intake). Cost: old containers coexist with
   new ones for hours, so CLI slots and memory on the node add up.
2. **Resume on restart.** Persist the CLI session id and the graph checkpoint
   (MongoCheckpointer), and have requeue resume the step with
   `claude --resume` instead of re-running from scratch. Also needs a
   periodic (not boot-only) recovery sweep and a recovery-record TTL as long
   as the run timeout.
3. **Operational.** Deploy only when no card runs are in flight
   (do-not-merge hold until the queue drains, as done for 0.0.300/0.0.301).
