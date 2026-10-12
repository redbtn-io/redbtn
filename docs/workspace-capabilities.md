# Workspace capabilities (engine 0.0.296-alpha; PR-base rule 0.0.297-alpha)

Managed agent workspaces (`ws_…`, one GitHub repository at one base branch, e.g.
`ws_0DA2G6LbYX3t` = `github.com/XiroEx/become@beta`) are a capability resource of their
own. An operator can be granted ONE workspace — look at it, start work in it, ship from
it, merge into it — without `exec:*`.

Code: `src/lib/permissions/workspace-grants.ts` (identities, decisions, derived grants),
`workspace-address.ts` (dispatch-time addressing), `tool-map.ts` (rules),
`nodes/universal/executors/neuronExecutor.ts` (`acquireWorkspaceForStep`: gate + derive),
`tools/native/workspace-{get,task}.ts`, `get-workspace-task.ts`, `ops/workspace-task/`.

## 1. Resource and actions

`resource: "workspace"`, FAIL-CLOSED (an unprofiled run gets none of it — exactly as when
these tools were `exec` tools). Actions form the redOps mode ladder; each is independent,
grant every one you need:

| action | tools / operations |
|---|---|
| `read` | `workspace_get`, `get_workspace_task` |
| `execute` | `workspace_for_repo`, `workspace_task`, and **checking the workspace out** (the neuron-step producer, `state.data.workspaceId`) — which DERIVES exec on that checkout, §4 |
| `write` | `workspace_ship` (push the checkout's branch, open a PR into the workspace's base; another base needs `write` on `<o>/<r>@<thatBase>`, §3b) |
| `control` | `workspace_merge` (merge a PR into its base branch) |

## 2. Selectors

A workspace answers to ALL of its identities; a grant matches when its selector matches
ANY of them. Every identity comes from the workspace's id and its CONFIGURED repository
and base branch. Repo forms are case-insensitive; `ws_` ids are exact.

| identity | example |
|---|---|
| workspaceId | `ws_0DA2G6LbYX3t` |
| canonical name `github.com/<o>/<r>@<base>` | `github.com/XiroEx/become@beta` |
| repo | `github.com/XiroEx/become`, `XiroEx/become` |
| repo at base branch | `XiroEx/become@beta` |

A workspace's free-form `name` is NOT an identity: `workspace_for_repo {name}` lets the
caller choose it, so otherwise a run could create a workspace for any repository and
name it after one it holds a grant on.

Selector syntax is the usual one: exact, `p*` (prefix), `p/*` (prefix jail), `*`, `none`.

## 3. How each call is addressed

| call | identities checked |
|---|---|
| `workspace_get {workspaceId}` | the workspace (+ its repo identities when it exists) |
| `workspace_for_repo {repo, branch?, name?}` | the workspace it finds (judged by its id and its REAL repo/branch, whatever `name` says); if none exists yet, the repo/branch it would be created with: `github.com/<o>/<r>@<branch>`, `github.com/<o>/<r>`, `<o>/<r>`, `<o>/<r>@<branch>` |
| checkout (producer) | the workspace doc (id + configured repo forms) |
| `workspace_task {workspaceId, …}` | the workspace; `ship:true` also needs `write` on it |
| `workspace_ship` | the workspace whose checkout THIS RUN holds in the bridge-pinned `environmentId` — recorded by the producer, or verified in Mongo (`activeCheckouts.$elemMatch {environmentId, runId}`). If `state.data.ws.workspaceId` names a different workspace, or no such checkout exists, the call is unscoped (needs `workspace:write@*`) |
| `workspace_merge {prUrl}` | `github.com/<o>/<r>` + `<o>/<r>` of the PR; if THIS run shipped the PR, also `<o>/<r>@<PR base>`, and — only when the PR targets the workspace's own base — the workspace's identities. So `workspace:control@ws_x` merges what the run shipped into ws_x's base; any other PR needs a repo-level selector |
| `get_workspace_task {runId}` | the task run's workspace |

## 3b. Pull requests into another base branch (0.0.297)

A write grant on the workspace (its ws_ id, or the bare repo) lets a run open pull
requests into the workspace's own base branch (`config.gitBranch`, default `main`) only.
A PR into ANY other branch, via `workspace_ship {base}` or `workspace_task {ship:true, base}`,
also needs a write grant naming that base: `<o>/<r>@<base>` or `github.com/<o>/<r>@<base>`
(or a wildcard / prefix selector covering it). Otherwise the call fails `FORBIDDEN` before
anything is pushed or started, and the denial is audited. `workspace:write@*` and the
legacy `exec:execute@*` are unchanged. A `workspace_task` child shipping into a non-default
base gets exactly `workspace:write@<o>/<r>@<base>` added to its derived profile.

## 4. Derived grants

When a run whose effective profile allows `workspace:execute` on a workspace checks it out
(the producer acquires a checkout, or binds to one Mongo says this run holds), the engine
adds `{resource:"exec", actions:["execute"], selector:"<checkout environmentId>"}` to the
profile scope in force (the run's, or a trusted subgraph's) and **drops it when the step
releases the checkout**. File and command tools (`run_command`, `read_file`, `write_file`,
`edit_file`, `glob`, `grep_files`, `list_dir`, `ssh_run_async`/`ssh_tail`/`ssh_kill`/
`ssh_jobs`) then work inside the checkout and nowhere else; every other environment stays
denied (exec is fail-closed). Grants are never derived from an `environmentId` that run
state merely claims. Derived state is per worker process and per run.

## 5. `workspace_task` / `get_workspace_task`

`workspace_task {workspaceId, brief, ship?, base?, neuronId?}` starts a child run of the
system graph `workspace-task` (`ops/workspace-task/`, seeded with `seed.mjs`) and returns
`{runId, workspaceId, checkoutKey, ship, status: "queued"}` at once.

- Identity: the parent's owner, with the parent's run-as-caller delegation
  (`connectionIdentityUserId` / `secretsIdentity`), so the workspace, its GitHub
  installation and the checkout are the caller's.
- Profile: ENGINE-DERIVED, never broader than the parent —
  `workspace:read+execute@<workspaceId>` (+ `write` when `ship`, + `write@<o>/<r>@<base>` when
  shipping into a non-default base the parent may target, §3b), constrained by the worker
  graph's declared ceiling (`workspace:read/execute/write@*`). No `control`, no
  state/knowledge/exec grants; exec comes only from §4 on its own checkout. The override is
  a `run()` option only in-process engine code can set (`RunOptions.capabilityProfileOverride`).
- Worker: a CLI neuron (default `sonnet-5`, any neuron the owner has via `neuronId`) with
  the file/command tools (+ `workspace_ship` when shipping) given through `toolsFrom`,
  branch-mode checkout keyed `task-…`.
- **Not durable:** the child runs in-process (like `invoke_graph` wait:false). A worker
  redeploy kills it like any in-flight run and nothing requeues it.

`get_workspace_task {runId}` → `queued | working | shipped | completed | failed |
interrupted | unknown`, `prUrl`, `summary` (tail of the worker's report), timestamps.
`interrupted` = the run was interrupted, or made no progress for 15 minutes (none since it
started, or since its last heartbeat: a killed worker): start the task again. Only
`workspace-task` runs of the same owner are visible.

## 6. Backward compatibility

- `exec:execute@*` passes every workspace action on every workspace (it could already do
  all of this): redboard-red, red-coder-ws-jail, red-ops-fleet-exec, exec-migration,
  redscan-pipeline, gemini-37-agent keep working unchanged.
- Unprofiled runs: workspace tools denied (as before, fail-closed); the producer still
  checks out (exec stays fail-closed for them, as before).
- Workspace tools stay under the exec runtime guard (kill switch, rate limit, durable
  audit; `workspace_for_repo`/`workspace_merge` audit-exempt as before) and are recorded in
  the hub's exec-attempt ledger as `exec`.

## 7. Declaring it on a graph (redOps "Workspace" attachment)

```json
{ "capabilities": { "name": "redops-op_…", "capabilities": [
  { "resource": "workspace", "actions": ["read"],    "selector": "ws_0DA2G6LbYX3t" },
  { "resource": "workspace", "actions": ["execute"], "selector": "ws_0DA2G6LbYX3t" },
  { "resource": "workspace", "actions": ["execute"], "selector": "github.com/XiroEx/become@beta" },
  { "resource": "workspace", "actions": ["write"],   "selector": "ws_0DA2G6LbYX3t" },
  { "resource": "workspace", "actions": ["control"], "selector": "github.com/XiroEx/become" }
]}}
```
View = read · Work = + execute (the id, plus the repo@branch form for
`workspace_for_repo`) · Ship = + write · Merge = + control. No `exec` grant is needed
for workspaces.

The hub accepts `workspace` grants once it pins engine 0.0.296. Like exec / computer /
environment they are PRIVILEGED: checking a workspace out runs an agent with a shell in
its container, so only an admin (accountLevel 0) can attach them to a graph, and a
non-admin's fork drops them unless their own user-level grants cover them.

## 7b. Desktop target hardening (same release)

Desktop tools resolve only the address the gate checked (`environmentId || machine`): an
`environmentId` that fails to resolve never falls back to `machine`; `environmentId` plus a
`machine` naming a different desktop is refused; a machine-only call under a scoped grant
needs an exact environmentId / installId / name (case-insensitive) match — fuzzy prefix /
substring lookup only for `'*'` grants, unprofiled runs or ungated tools.
