# Run-as-caller delegation

Status: describes shipped behaviour. Written from the code in `redbtn-io/redbtn`
(engine) and `redbtn-io/webapp` (hub) as of engine `0.0.263-alpha`, with
`secretsIdentity` (section 4) added after the 2026-09-16 board-dispatch
incident and the environment file/exec tools aligned with the same table later
that day (section 4, "2026-09-16").

Comments in the engine, the hub and the redrun worker cite this file. It was
never committed until now, so this document is reconstructed from the
implementation rather than from an earlier draft. Where the code and an existing
comment disagree, the code wins and the disagreement is called out.

## 1. Purpose and the rule

An automation belongs to one user (its owner) but may be triggered by someone
else. Without delegation such a run reaches only the owner's accounts, machines
and repositories, which makes a shared or service-owned automation useless for
acting on the triggering user's own resources, and dangerous if it ever did.

The rule, in one sentence:

> **A delegated run uses the caller's resources and the owner's bill.**

Concretely: user OAuth connections, environments and their SSH credentials,
secrets, and managed workspaces (including the GitHub App installation used to
clone, push and merge) resolve as the **caller**. LLM provider access, neuron
tier gating, redToken metering and workspace storage tier stay on the **owner**.

Two invariants hold everywhere:

1. **The identity is never a parameter.** It is derived server-side from the
   caller's verified authentication, in the hub's trigger route, and nowhere
   else.
2. **Caller-scoped resolution is fail-closed.** A resource the caller does not
   have is an error. It never falls back to the owner's copy. That fallback
   would be a cross-tenant credential leak, which is the whole reason this
   mechanism is shaped the way it is.

Secrets are the one resource an automation may take back off the caller, with
`secretsIdentity: 'owner'`, for the case where the declared secrets are the
automation's OWN credentials rather than the caller's. That is a per-automation,
admin-gated choice made up front, not a fallback: section 4, "The one exception:
the automation's own secrets".

## 2. Definitions

**Owner.** `automation.userId`. The account the automation belongs to, the
account the run is recorded under, and the account every billing-shaped decision
keys on. In the hub's trigger route this is the local `ownerUserId`.

**Caller.** The authenticated user who triggered the run, as returned by
`verifyAuth` (`webapp src/lib/auth/auth.ts`). May be the owner, a participant on
the automation, or, for a caller-invokable automation, a non-member.

**Delegated run.** A run carrying a `connectionIdentityUserId`, which the hub
sets whenever the automation opted in with `executionIdentity: 'caller'`. In
practice the interesting case is the one where caller and owner differ; when the
owner triggers their own caller-identity automation the field is still set, but
every resolver in section 4 then returns the same id either way and the audit
marker in section 5 is omitted. Any run without the field is undelegated and
behaves exactly as it did before this mechanism existed.

**`connectionIdentityUserId`.** The wire field. Set by the hub's trigger route on
the `AutomationRun` document and on the BullMQ job; consumed by the engine as
`RunOptions.connectionIdentityUserId`. Its absence means "owner-resolved".
Declared in `webapp src/lib/queue/client.ts` (`SubmitRunJobOptions`),
`webapp src/lib/database/models/automation/AutomationRun.ts` (`IAutomationRun`)
and `engine src/functions/run.ts` (`RunOptions`).

**`callerUserId`.** The run-state field. `buildInitialState`
(`engine src/functions/run.ts`) mirrors `options.connectionIdentityUserId` onto
graph state as top-level `callerUserId` and as `data.callerUserId`. It is a
plain string, so it survives MongoCheckpointer round-trips. It is deliberately a
separate field from `state.userId`, which always remains the owner. The two
mirrors exist because different call sites read state at different depths; every
resolver in this document accepts either.

**`delegatedFromUserId`.** The audit marker. On a delegated run it carries the
**owner** outward onto redrun worker lifecycle jobs, where every identity field
already names the caller. Nothing resolves a credential, a secret or a
repository against it. Produced by `resolveDelegatedFromUserId`
(`engine src/lib/tools/native/workspace-common.ts`) and `delegatedFromUserId`
(`engine src/lib/nodes/universal/executors/neuronExecutor.ts`).

**`callerInvokable`.** A separate opt-in on the automation that widens *who may
trigger it* to any authenticated non-member. It does not by itself change any
identity resolution.

**`executionIdentity`.** `'owner' | 'caller'`, default `'owner'`. The opt-in that
turns delegation on. Declared in
`webapp src/lib/database/models/automation/Automation.ts`.

**`secretsIdentity`.** `'caller' | 'owner'`, default `'caller'`. A second
automation-level field, read only on a delegated run, that decides which
identity `secretRefs` resolve against. `'caller'` is the rule in section 1 and
every delegated run behaves as it always has. `'owner'` moves the secrets — and
nothing else — back onto the owner's undelegated path, for an automation whose
declared secrets are the AUTOMATION'S OWN credentials rather than the caller's.
Declared alongside `executionIdentity` in the same model; carried on the BullMQ
job and consumed as `RunOptions.secretsIdentity`. See section 4, "The one
exception: the automation's own secrets".

## 3. How a run becomes delegated

All of this happens in `POST` of
`webapp src/app/api/automations/[automationId]/trigger/route.ts`, in this order.

1. **Rate limit.** `rateLimitAPI(request, RateLimits.STANDARD)`. Called without a
   userId argument, so `getRateLimitIdentifier`
   (`webapp src/lib/rate-limit/rate-limit.ts`) keys on client IP, not on the
   caller. `isRateLimitExempt` skips the check entirely for service-principal
   requests (`x-api-key`, or `x-internal-key` plus `x-user-id`) and for
   fleet-internal traffic.
2. **Authentication.** `verifyAuth(request)`; `401` when it returns null. It
   accepts a personal access token (`rpat_`), an OAuth access token (`rbt_`), or
   a session JWT whose `sid` still resolves to a live session.
3. **Scope.** `checkPATScope(user, 'automations:write')`.
4. **Access.** `verifyAutomationAccess(automationId, user.userId)`
   (`webapp src/lib/auth/automation-access.ts`, which delegates to
   `verifyResourceAccess` in `webapp src/lib/auth/resource-access.ts`). Owners
   and participants pass.
5. **Caller-invokable fallback.** Only when step 4 denied: the route loads the
   automation document directly (`Automation.findOne({ automationId }).lean()`)
   and continues **only** when `automation.callerInvokable === true` **and**
   `automation.executionIdentity === 'caller'` **and** `user.userId` is present.
   Otherwise it returns the access error (`404` unless the access result named
   another status). The safety argument for opening this to strangers is exactly
   the invariant in section 1: a caller can only ever act on their own
   resources.
6. **Per-caller brake.** Still only on the step-5 path:
   `rateLimitAPI(request, RateLimits.STRICT)` (30 requests per 60 seconds). The
   comment at that call describes it as per-caller; because no userId is passed,
   the implementation keys it on client IP like step 1. Its stated purpose is to
   stop a caller-invokable automation being used to drain the owner's ledger,
   since metering stays owner-keyed.
7. **Owner resolution.** `ownerUserId = String(automation.userId)`.
8. **Identity derivation.** `connectionIdentityUserId` is set to
   `String(user.userId)` when `automation.executionIdentity === 'caller'` and
   `user.userId` is present, and left `undefined` otherwise. Note that this test
   does **not** include `callerInvokable`: an `executionIdentity: 'caller'`
   automation delegates for a member caller too. `callerInvokable` only governs
   whether a non-member may reach step 5 at all.
9. **Enablement and shape.** `isEnabled` (`400` when disabled), then the
   `graphId`/`streamId` mutex (`400`, code `graph_stream_mutex`).
10. **Mode split.** `getAutomationMode(automation)`.
    - **Stream mode does not delegate.** The route resolves the stream against
      the owner, creates the `StreamSession` with `userId: ownerUserId`, and
      calls `getSessionManager().createSession(..., ownerUserId, ...)`. The
      caller appears only in the session log line and in `triggeredBy`.
      `connectionIdentityUserId` is not read on this branch.
    - **Graph mode delegates.** `AutomationRun.create` writes
      `userId: ownerUserId`, `triggeredByUserId: user.userId`,
      `triggerData: { triggeredBy, ownerUserId }`, and
      `connectionIdentityUserId` only when it is set. `initializeRunState` is
      keyed on `ownerUserId`. `submitRunJob` then carries `userId: ownerUserId`
      plus `connectionIdentityUserId` when set
      (`webapp src/lib/queue/client.ts`).

**What is never accepted as a parameter.** The request body is read for `input`,
`instanceId`, `resumeFromRunId`, `runId` and `conversationId` only. There is no
body field, header or query parameter anywhere on this route that sets, hints at
or overrides the acting identity. `connectionIdentityUserId` is computed solely
from the `user.userId` that `verifyAuth` returned.

**Where it is turned on.** `executionIdentity`, `callerInvokable` and
`secretsIdentity` are schema fields with defaults `'owner'`, `false` and
`'caller'`. All three are written through one shared gate,
`resolveExecutionIdentityFields` in
`webapp src/lib/automations/execution-identity.ts`, which the create route
(`webapp src/app/api/automations/route.ts`, `POST`) and the update route
(`webapp src/app/api/automations/[automationId]/route.ts`, `PUT`) both call.
The gate is two-layered — OWNER (the routes' own role gate) **and** platform
admin (`accountLevel` 0) — it validates the enum values, treats a supplied
value equal to the stored one as a no-op, and audits every real change as one
`automation_execution_identity_change` event. The settings UI is
`AutomationIdentitySection` on the automation edit page, which shows a non-admin
the same three settings read-only rather than controls that would 403.

**Into the engine.** `RunOptions.connectionIdentityUserId` reaches
`buildInitialState`, which puts `callerUserId` on state, and reaches the
`ConnectionManager` construction inside `run`, which is built with
`userId: options.connectionIdentityUserId ?? options.userId`.
`RunOptions.secretsIdentity` travels the same road: `buildInitialState` records
it at `state.data.secretsIdentity` on delegated runs, and the worker forwards it
into `enrichInput` as `EnrichInputOptions.secretsIdentity` beside
`secretsIdentityUserId`. The step from the BullMQ job to `RunOptions` happens in
the worker (`@redbtn/worker`), a separate repository that was not read for this
document; both fields are forwarded there the same way.

**Through subgraphs.** `engine src/lib/nodes/universal/executors/graphExecutor.ts`
copies `callerUserId` into the subgraph's `subInput` and mirrors it to
`subInput.data.callerUserId`, so a delegated parent cannot spawn an
owner-identity child.

## 4. What resolves as the caller, and what stays on the owner

### Caller-resolved

| Resource | Enforced by |
| --- | --- |
| User OAuth connections (by id and by provider default) | `engine src/functions/run.ts` `run` builds `ConnectionManager` with `userId: options.connectionIdentityUserId ?? options.userId`; `engine src/lib/connections/ConnectionManager.ts` rejects any connection whose `connection.userId` differs from that id. The underlying fetcher, `createConnectionFetcher` in `webapp src/lib/connections/connection-fetcher.ts`, filters every query by `userId`; the worker is what constructs it for a job (see section 3, "Into the engine"). |
| Secrets (`automation.secretNames`, `{{secret:NAME}}` placeholders, `_secrets.NAME` graph references) — **unless the automation sets `secretsIdentity: 'owner'`** | `engine src/lib/run/enrich-input.ts` `enrichInput` (`EnrichInputOptions.secretsIdentityUserId` + `EnrichInputOptions.secretsIdentity`) and `resolveSecrets`. When the delegated identity is present and `secretsIdentity` is `'caller'` (the default), `scope` is forced to `'user'` and both `scopeId` and `userId` become the caller, so the automation bucket and the owner's bucket are unreachable. See the exception below. |
| Environments and their SSH credentials — **every** tool that touches one: the ssh family (`ssh_shell`, `ssh_tail`, `ssh_jobs`, `ssh_kill`, `ssh_run_async`, `ssh_copy`), the file and exec pack (`run_command`, `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep_files`) and the desktop pair (`alert_desktop`, `desktop_computer`'s `desktop_exec` / `desktop_screenshot` / the rest) | `executeViaEnvironment` in `engine src/lib/tools/native/ssh-shell.ts` and `resolveUserId` in `ssh-tail.ts`, `ssh-jobs.ts`, `ssh-kill.ts` and `ssh-run-async.ts` read `state.callerUserId \|\| state.data.callerUserId \|\| state.userId \|\| state.data.userId` inline. Every other tool in the list gets the identical rule from `resolveRunUserId` in `engine src/lib/tools/native/_run-identity.ts` (the desktop pair through their own `resolveUserId`, which adds a legacy `state.options.userId` last resort; `ssh_copy` uses it for the environment **and** for the `X-User-Id` on its Knowledge Library access check). The document lookup, the owner-or-public access check and the `secretRef` resolution are `loadAndResolveEnvironment` in `engine src/lib/environments/loadAndResolveEnvironment.ts`, which resolves the key in the passed identity's own scope with no owner fallback. Covered by `engine tests/security/env-tools-run-as-caller.test.ts`. |
| Managed workspace ownership | `resolveRunUserId` in `engine src/lib/tools/native/workspace-common.ts` (a delegation to the shared `_run-identity.ts`), used by `engine src/lib/tools/native/workspace-for-repo.ts` to find or create the workspace. Because that one call decides `workspace.userId`, every later identity decision follows from it. |
| GitHub App installation (clone, push, merge) | `resolveJobInstallation` in `workspace-common.ts` calling `resolveGithubInstallation` in `engine src/lib/workspaces/github-installations.ts`. `acquireWorkspace` (`engine src/lib/workspaces/WorkspaceLifecycle.ts`) resolves it for `workspace.userId`; `engine src/lib/tools/native/workspace-ship.ts` for `workspace.userId`; `engine src/lib/tools/native/workspace-merge.ts` for `resolveRunUserId`. |
| Lifecycle job ownership (`spawn`, `push`, `merge`, `snapshot`, `destroy`) | `ownerUserId: workspace.userId` on the spawn job in `acquireWorkspace` and on the push job in `workspace-ship.ts`; `ownerUserId: resolveRunUserId(context)` on the merge job in `workspace-merge.ts`; `userId: workspace.userId` on the destroy job in `engine src/lib/workspaces/workspace-destroy.ts`. The field is named `ownerUserId` because that is what the worker reads; on a delegated run the caller **is** the workspace's owner. |
| Subgraph steps | `engine src/lib/nodes/universal/executors/graphExecutor.ts`, which propagates `callerUserId` into the child state. |

### Owner-resolved

| Resource | Enforced by |
| --- | --- |
| LLM provider access and neuron config lookup | `engine src/lib/nodes/universal/executors/neuronExecutor.ts` reads `state.userId \|\| state.data.userId` and passes it to `NeuronRegistry.getConfig` and `NeuronRegistry.callNeuron`. It never reads `callerUserId`. `getConfig` in `engine src/lib/neurons/NeuronRegistry.ts` scopes the document query to that id plus the system-owner branches. |
| Neuron tier gating | `validateAccess` and `getUserTier` in `engine src/lib/neurons/NeuronRegistry.ts`, on the same owner id. (`getUserTier` currently returns a constant free tier in the engine; the gate exists and is owner-keyed regardless.) |
| redToken metering | `emitNeuronUsage` in `neuronExecutor.ts` records `accountId: params.userId`, which is the owner id resolved above. The metering client itself is a process singleton wired in `engine src/functions/run.ts`. |
| Workspace storage tier | `resolveRunAccountTier` in `workspace-common.ts` reads `state.data.accountTier`, which `buildInitialState` fills from the owner's user settings; `workspace-for-repo.ts` passes it to `createWorkspace`. The caller decides which repository is checked out; the owner's plan decides how much of it is retained. |
| Run record, run state and change events | `AutomationRun.userId`, `initializeRunState({ userId: ownerUserId })` and both `emitResourceChange` calls in the trigger route. |
| Global-state refs (`{{state:ns.key}}`) | `resolveStateRefs` in `engine src/lib/run/enrich-input.ts` takes the run `userId` (owner) and has no delegated parameter. |
| Stream sessions | The stream branch of the trigger route; see section 3, step 10. |
| Secrets, **when the automation sets `secretsIdentity: 'owner'`** | `resolveSecrets` in `engine src/lib/run/enrich-input.ts`. See below. |

### The one exception: the automation's own secrets

Caller-scoped secrets assume the secrets in question belong to the caller. For a
personal automation that is right. For a platform BOT it is backwards: the bot's
graph declares the BOT'S OWN credentials as `secretRefs` — the board API token
it posts with, the SSH key its executor uses — and lends them to work it performs
on a tenant's behalf. Under the default rule those names are looked up in the
caller's account, where they cannot exist, and the run dies before its first node
with `SecretsDelegationError`. That is what happened to the board automation on
2026-09-16 (`RED_BOARD_TOKEN`, `SSH_KEY`).

`automation.secretsIdentity: 'owner'` is the opt-out, and it is deliberately
narrow:

- **Only secrets move.** Connections, environments, workspaces, the GitHub App
  installation and every lifecycle job stay caller-resolved exactly as the tables
  above describe. The board dispatch still acts on the *board owner's*
  installation and workspaces via `callerUserId`; only the bot's own keys come
  from the bot.
- **The owner's path is the undelegated path, verbatim.** `resolveSecrets`
  discards the delegated identity for this one lookup, so `scope` /`scopeId` /
  `userId` are what an owner-triggered run would have produced (the automation
  bucket for an automation run, the owner otherwise) — including its graceful
  degradation on a name that does not resolve. Fail-closed
  (`SecretsDelegationError`) belongs to `'caller'` and is unreachable here.
- **It is not a fallback.** There is no "try the caller, then the owner"
  anywhere. The automation picks one identity up front, admin-gated, and that is
  the one used. A `'caller'` automation can still never read the owner's
  secrets.
- **It is announced.** One line per run:
  `[enrich-input] secrets resolved as owner <id> for delegated run <runId> (secretsIdentity=owner)`.

`'caller'` remains the default for every delegated run, including every
automation that predates the field, so nothing already in flight moves.

### 2026-09-16: the file and exec tools joined the ssh family

The table above always put environments on the caller's side. Only the ssh
family implemented it, and production showed exactly what that cost.

Run `run_1789534315735_ixbvhn` (2026-09-16 04:52Z). A board owned by a second
tenant dispatched a card through an automation owned by George.
`workspace_for_repo` correctly created the workspace under the CALLER, and the
runner environment `env_mdFnVzNuxppa` belonged to the CALLER. So:

- **Worked**, because they already resolved `state.callerUserId` first:
  `ssh_run_async`, `ssh_tail`, `ssh_jobs`.
- **Denied**, because they resolved the run OWNER only — every one of them with
  `ENV_ACCESS_DENIED: User 69a0b790a0ae8660290a78da does not have access to
  environment env_mdFnVzNuxppa`: `run_command`, `list_dir`, `glob`, `read_file`,
  `write_file`, `edit_file`, `grep_files`, `ssh_copy`.

One unlocked door, eight locked ones, on the same machine. The agent inside the
run behaved correctly — it declined to funnel a whole card's work through the
single tool that happened to answer, and reported the card blocked — so this
surfaced as a stalled card rather than as a half-done delegated build.

What changed: the precedence
(`state.callerUserId || state.data.callerUserId || state.userId ||
state.data.userId`) now has exactly one definition, `resolveRunUserId` in
`engine src/lib/tools/native/_run-identity.ts`, and every tool in the
environments row reads it — including the desktop pair, which reaches a machine
through an environment like everything else, and `ssh_copy`, whose open item in
section 7 this closes. `ssh_copy` moved at both ends: its Knowledge Library
access check sends the caller as `X-User-Id` too, because an owner-resolved
library read feeding a caller-resolved SFTP write is a path for copying the
owner's private documents onto the caller's host.

`resolveRunOwnerUserId` did not move: tier gating, metering and the redToken
ledger stay owner-keyed, exactly as the Owner-resolved table says. Undelegated
runs carry no `callerUserId` and are byte-for-byte unchanged, which
`engine tests/security/env-tools-run-as-caller.test.ts` asserts for all ten
tools alongside the two delegated shapes.

## 5. Audit trail

**On the run record** (`webapp src/lib/database/models/automation/AutomationRun.ts`):

- `userId` is the owner.
- `triggeredByUserId` is the caller.
- `connectionIdentityUserId` is present only on a delegated run and records the
  identity that caller-scoped resources resolved as.
- `triggerData` carries `{ triggeredBy, ownerUserId }`, and the first log entry
  names the caller.

**On the queue job** (`webapp src/lib/queue/client.ts`, `submitRunJob`): `userId`
is the owner, `connectionIdentityUserId` is added only when set,
`secretsIdentity` is added only on a delegated run, and `trigger.metadata`
carries `triggeredBy` and `ownerUserId`.

**On run state** (`engine src/functions/run.ts`, `buildInitialState`): both
identities are present at once, `state.userId` (owner) and `state.callerUserId`
plus `state.data.callerUserId` (caller). Anything reading state can tell a
delegated run from an undelegated one by the presence of the second.
`state.data.secretsIdentity` is stamped on delegated runs only, with the
effective value (`'caller'` when the automation did not opt out), so a run's own
checkpointed state records which account lent it its secrets.

**On the automation's write path** (`webapp src/lib/automations/execution-identity.ts`,
`logExecutionIdentityChange`): every change to `executionIdentity`,
`callerInvokable` or `secretsIdentity` writes one
`automation_execution_identity_change` audit event naming the automation, its
owner, the admin who made the change and each field's before/after
(`fromSecretsIdentity` / `toSecretsIdentity` for this one).

**On worker lifecycle jobs**: `delegatedFromUserId` carries the owner outward.
It is produced by `resolveDelegatedFromUserId` (`workspace-common.ts`, for the
ship and merge jobs) and by `delegatedFromUserId` (`neuronExecutor.ts`, for the
spawn job via `acquireWorkspaceForStep`), then threaded through
`AcquireOptions.delegatedFromUserId`, `WorkspaceSession` and
`buildReleaseJobData` in `engine src/lib/workspaces/WorkspaceLifecycle.ts`. Both
producers return null when caller and owner are the same, so the key is simply
absent from an undelegated run's jobs.

**In the worker's log**: `credentialIdentityLine` in
`redrun worker/src/lib/github-app.ts` is the single line that says which identity
a job's GitHub credentials resolved as. It prints the job's `ownerUserId` and
either the App installation id or "the owner's own credentials", and appends
`(run-as-caller; delegated from <id>)` when `delegatedFromUserId` is present.
That function is the only reader of `delegatedFromUserId` in the worker process:
no resolution, no allowlist and no secret lookup consults it. Without this line
the owner of a delegated run is unrecoverable once the job has left the engine.

## 6. Failure modes

**Caller has no GitHub App installation for the repository.**
`resolveJobInstallation` turns the hub's `not_installed` or `not_authorized`
answer (`isMissingInstallation`) into a tool error with code `NO_GITHUB_APP`,
whose message comes from `githubInstallMessage` and names the repository and the
App install URL. This is returned even when the **owner** has an installation
that would cover the repository. Borrowing it would hand the caller's agent
every repository the owner granted.

**The hub cannot answer.** `resolveGithubInstallation` is fail-open by design:
`resolver_unavailable` (cold hub, missing `INTERNAL_SERVICE_KEY`, timeout,
non-OK response) and `github_app_not_configured` both yield
`installationId: null` and the job proceeds without one. The worker then falls
back to the job owner's own redsecrets and, for allowlisted owners only, the
platform's credentials. Because `ownerUserId` on a delegated job is the caller,
that allowlist is evaluated against the caller: an automation owner appearing in
`WORKSPACE_GH_APP_FALLBACK_OWNERS` does not let an arbitrary caller's agent
borrow the platform's installation.

**Caller does not hold a referenced secret.** On a `secretsIdentity: 'caller'`
run (the default), `resolveSecrets` throws `SecretsDelegationError` (code
`SECRETS_DELEGATION_MISSING`), whose message names the caller and every missing
secret name and states that there is no fallback to the owner. This fires on
three paths: Mongo unavailable, an underlying resolve failure, and the
post-resolve check for names that did not resolve. On an undelegated run — and
on a `secretsIdentity: 'owner'` run, which takes that same path — all three
degrade gracefully instead, which is the pre-existing behaviour.

If this error names secrets that are the AUTOMATION'S own credentials rather
than anything the caller could hold, the automation wants
`secretsIdentity: 'owner'` (section 4), not a caller who has been told to
duplicate the bot's keys into their account.

There is no `MissingConnections` error class anywhere in the engine or the hub.
`SecretsDelegationError` is the only delegation-specific error that names the
caller, and it is about secrets rather than connections. A missing connection
produces the null described two paragraphs below, not an error of its own.

**Caller cannot use an environment.** `loadAndResolveEnvironment` throws
`EnvironmentAccessDeniedError` (`ENV_ACCESS_DENIED`) when the environment is
neither the resolved identity's nor public, and
`EnvironmentSharedSecretMissingError` (`ENV_SHARED_SECRET_MISSING`) when they
reach a public environment but hold no secret of its `secretRef` name in their
own scope. The second message tells them which secret to create. The owner's key
is never shared. Read the first as "the identity this tool acted as has no such
environment" — when only SOME of a run's tools raise it against ONE environment,
the tools disagree about who they are, which is the 2026-09-16 defect in
section 4.

**Caller does not own a referenced connection.** `ConnectionManager` returns
null for any connection whose `connection.userId` differs from the resolved
identity, so a delegated run gets "no such connection", never the owner's.

**Non-member triggers an automation that is not caller-invokable.** The trigger
route returns the access-check error, `404` by default, and no run is created.

**Undelegated runs are unchanged.** With `connectionIdentityUserId` absent there
is no `callerUserId` on state, so `resolveRunUserId` equals
`resolveRunOwnerUserId`, the ssh resolvers fall through to the owner chain,
`resolveDelegatedFromUserId` returns null, and no delegation key is added to any
job or document. This is asserted directly in
`engine tests/workspaces/workspace-run-as-caller.test.ts`,
`engine tests/workspaces/workspace-spawn-run-as-caller.test.ts` and, for all ten
environment file/exec/desktop tools,
`engine tests/security/env-tools-run-as-caller.test.ts`.

## 7. Non-goals and open questions

### Not delegated today

These are statements about the current code, not judgements about whether they
should change.

- **Stream-mode automations.** The stream branch of the trigger route runs
  entirely as the owner.
- **Trigger types other than the manual/API trigger route.**
  `connectionIdentityUserId` is set in exactly one place in the hub. Webhook,
  schedule and chat paths do not set it.
- **`invoke_graph` child runs.** `engine src/lib/tools/native/invoke-graph.ts`
  resolves its local `callerUserId` from the run publisher and the owner chain,
  never from `state.callerUserId`, and calls `run` with that as `userId` without
  forwarding `connectionIdentityUserId`. A child run spawned by the tool is
  therefore undelegated. (Subgraph *steps*, which go through `graphExecutor`, do
  propagate. The two paths differ.)
- **`get_recent_runs` access checks.**
  `engine src/lib/tools/native/get-recent-runs.ts` has a local variable named
  `callerUserId`, but it is resolved from the publisher identity and the owner
  chain. It does not read `state.callerUserId`, so run listings are access
  checked as the owner. The name collision is a reading hazard, not a
  delegation.
- **Global-state refs**, which resolve against the run's owner.
- **Metering.** Owner-keyed in v1, deliberately, with the per-trigger rate limit
  in section 3 as the compensating control.

### Turning delegation on

Settled. `executionIdentity`, `callerInvokable` and `secretsIdentity` are
written through `resolveExecutionIdentityFields` from both automation write
routes, gated on OWNER **and** platform admin (`accountLevel` 0), audited on
every change, and surfaced in `AutomationIdentitySection` on the automation edit
page (read-only for a non-admin). See section 3, "Where it is turned on".

### Board dispatch identity

Tracked on card `6aa9cc389cd36ab33ad10d76` (referenced from the commit that
landed the workspace half of this mechanism, engine #478, first released in
`0.0.260-alpha`). Two shapes were on the table for how a board dispatch acts on
behalf of whoever moved the card:

1. **Per-tenant automation.** Each tenant owns an
   `executionIdentity: 'caller'` automation, and the dispatch triggers it
   through the gates in section 3. This reuses the verified-caller derivation
   exactly as specified and adds no new trust path, at the cost of one
   automation per tenant to provision and keep in sync.
2. **First-party assertion.** A trusted first-party service asserts the acting
   user directly to the run. This needs no per-tenant provisioning, but it
   introduces an identity path that is asserted by a service rather than derived
   from the acting user's own authentication, which is precisely what invariant
   1 in section 1 currently forbids. It would need its own authentication,
   scoping and audit story.

Shape 1 was taken, and running it in production surfaced what `secretsIdentity`
now fixes: the dispatch must use the BOARD OWNER's connections, installation and
workspaces (which `callerUserId` already gave it) while the platform bot's own
`secretRefs` keep resolving against the automation owner. The dispatch
automation therefore sets `executionIdentity: 'caller'` **and**
`secretsIdentity: 'owner'`. Invariant 1 is untouched — the acting identity is
still derived from the caller's verified authentication, and `secretsIdentity`
is a property of the automation, not something a request can assert.

### What this document could not verify

Two links in the chain live outside the engine and the hub, and are described
here from the comments and from the redrun file named below rather than from
code read in this repository:

- **The BullMQ job to `RunOptions` hop.** The worker (`@redbtn/worker`) is what
  reads `connectionIdentityUserId` off the job, builds the connection fetcher
  with it, and passes it to `run` and into `enrichInput` as
  `secretsIdentityUserId`. `secretsIdentity` rides the same hop, forwarded
  verbatim onto `RunOptions.secretsIdentity` and
  `EnrichInputOptions.secretsIdentity`. Every statement in this document about
  that hop comes from the engine-side and hub-side comments that describe it.
- **The redrun worker's credential resolution.** Section 5 and section 6
  describe `credentialIdentityLine`, `fallbackCredentialOwners` and the
  installation-token path from `redrun worker/src/lib/github-app.ts`, read as a
  single file rather than in the context of its callers.

### If you add a new delegated path

Two rules, both load-bearing:

- Resolve caller-scoped resources fail-closed. Never fall back to the owner.
- Keep anything that spends or records against an account on
  `resolveRunOwnerUserId`, not `resolveRunUserId`.
- Get both from `src/lib/tools/native/_run-identity.ts` rather than writing the
  chain again. Every open-coded copy of it so far has been a copy that fell
  behind (section 4, "2026-09-16").
