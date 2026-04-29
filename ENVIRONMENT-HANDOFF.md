# Environments — Architecture & Coverage Handoff

**Status:** Specification — ready to be implemented across multiple PRs.
**Owner:** Engine team (multi-agent execution).
**Goal:** Introduce a long-running, self-healing **Environment** primitive for SSH/SFTP targets so coding-agent tools (fs pack, process pack) get connection pooling, drop tolerance, and command buffering "for free." Establishes the foundation for all subsequent system-tier tools that need a remote target.

**Order of work:** Build Environments **before** the remaining tool packs (fs, process, task). Several of those packs depend on the EnvironmentManager existing.

---

## 1. Architecture decisions (already made — do not re-litigate)

### 1.1 What an Environment IS

A persistent, named SSH/SFTP target managed by the engine. Each Environment is a config document in MongoDB plus an in-memory `EnvironmentSession` (managed by the per-process `EnvironmentManager`).

- **Config doc:** `host`, `port`, `user`, `secretRef` (name of the secret holding the SSH key), `workingDir?`, lifecycle/timeout settings, optional `openCommand?` / `closeCommand?`.
- **Runtime session:** `ssh2.Client` + parallel SFTP channel, lifecycle state, command buffer, idle timer, last-used timestamp.

### 1.2 What an Environment is NOT

- **Not a `UserConnection`.** UserConnections are 3rd-party-app integrations (OAuth/API key for Google, Slack, GitHub, etc) managed by `ConnectionManager`. Environments are SSH/system targets — completely separate concept.
- **Not a Stream.** Streams are voice/text provider sessions (Gemini Live, OpenAI Realtime). Environments share *patterns* with Streams (lifecycle, drop tolerance, per-process registry) but serve different purposes.
- **Not a Secret.** Environments USE secrets for the SSH key (via `secretRef`) but are not themselves secret material.

### 1.3 Naming

| Singular | Plural |
|---|---|
| Environment | Environments |
| `environmentId` (string, like `env_abc123`) | — |

UI label: **"Environments"**. Code identifiers: `Environment`, `EnvironmentSession`, `EnvironmentManager`, `IEnvironment`.

### 1.4 Three operating decisions

| # | Decision | Final answer |
|---|---|---|
| 1 | Auth source | Existing `@redbtn/redsecrets` only. Environment doc stores `secretRef: "MY_SSH_KEY"`. The manager resolves it at session-open time via the secret store. NO inline keys, NO new credential storage. |
| 2 | Pooling vs per-call | Pooled per-process. First tool call opens the session; subsequent calls reuse. Idle timer closes after inactivity. |
| 3 | Drop tolerance | Same pattern as Streams reconnect (PR #2): commands queue while degraded, replay on restore. Bounded buffer (e.g., 100 commands or 1MB), oldest-dropped policy. |

### 1.5 Future feature (out of v1 scope, mark in UI)

**Hosted Environments** — redbtn provisions an isolated, secured cloud environment (on the redbtn fleet or a cloud provider) on-demand. User doesn't supply host/key — they request a hosted env, the system spins one up. Lifecycle includes provisioning + teardown of the underlying VM/container.

For v1: only user-supplied SSH targets. UI should display a placeholder "Hosted Environments — coming soon" section. API should reserve a `kind: 'self-hosted' | 'redbtn-hosted'` discriminator on the schema so the future doesn't require a migration.

---

## 2. Scope of work

### Phase A — EnvironmentManager core (engine, one PR)

The in-process subsystem. No HTTP, no UI yet. Only the runtime fabric.

1. New module: `redbtn/src/lib/environments/`
   - `EnvironmentManager.ts` — singleton, manages `Map<environmentId, EnvironmentSession>`
   - `EnvironmentSession.ts` — wraps an `ssh2.Client` + SFTP channel + lifecycle state + command buffer
   - `types.ts` — `IEnvironment`, `EnvironmentLifecycleState`, `EnvironmentSessionEvent`, etc.
   - `index.ts` — public re-exports
2. Lifecycle states (see §3.1)
3. Command buffering during `degraded` state (see §3.4)
4. Idle close after `idleTimeoutMs` (default 5 min)
5. Hard close after `maxLifetimeMs` (default 8 h)
6. Per-environment reconnect with exponential backoff
7. Output log persistence (optional via `archiveOutputLogs` flag — write tail of every exec to a `environmentLogs` archive)
8. Engine version bump (e.g., 0.0.105-alpha)

### Phase B — Schema + REST API + ssh_shell/ssh_copy integration (one PR per repo)

1. **webapp:** `IEnvironment` schema + `environments` collection + `/api/v1/environments` CRUD (mirror `/api/v1/streams` shape)
2. **engine:** `ssh_shell` and `ssh_copy` accept optional `environmentId` arg. When provided, tool uses `EnvironmentManager.acquire(envId)` instead of opening a one-shot session. Backwards-compatible — inline `host`/`user`/`sshKey` still work.
3. **engine:** Engine version bump

### Phase C — fs pack (one PR)

Coding-agent file ops, all targeting an environment via `environmentId`.

| Tool | Inputs | Output |
|---|---|---|
| `read_file` | `environmentId`, `path`, `offset?`, `limit?` | `{ content, lineCount, totalLines, truncated }` |
| `write_file` | `environmentId`, `path`, `content`, `mode? (default '0644')` | `{ ok: true, bytes }` |
| `edit_file` | `environmentId`, `path`, `oldString`, `newString`, `replaceAll? (default false)` | `{ ok: true, replacements }` — rejects ambiguous matches when `replaceAll: false` |
| `glob` | `environmentId`, `pattern`, `basePath?` | `{ paths: [...], total }` |
| `grep_files` | `environmentId`, `pattern`, `path?`, `contextLines? (default 0)`, `maxResults? (default 100)` | `{ matches: [{ file, line, content, context? }] }` |
| `list_dir` | `environmentId`, `path`, `recursive? (default false)`, `ignore?: [string]`, `maxEntries? (default 500)` | `{ entries: [{ name, type, size?, modifiedAt? }] }` |

Uses SFTP channel under the hood (no shell exec) for `read_file`, `write_file`, `list_dir`, `glob` (with manual traversal). `grep_files` uses SSH exec with `rg` if available (fall back to `grep`), parsed into structured output. `edit_file` uses SFTP read+modify+write atomically.

### Phase D — process pack (one PR)

Long-running command management.

| Tool | Inputs | Output |
|---|---|---|
| `ssh_run_async` | `environmentId`, `command`, `cwd?`, `env?` | `{ jobId, startedAt }` — kicks off, returns immediately |
| `ssh_tail` | `environmentId`, `jobId`, `lines? (default 50)`, `follow? (default false)` | `{ stdout, stderr, exitCode?, isRunning }` |
| `ssh_kill` | `environmentId`, `jobId`, `signal? (default 'TERM')` | `{ ok: true, terminatedAt }` |
| `ssh_jobs` | `environmentId` | `{ jobs: [{ jobId, command, startedAt, status, isRunning }] }` |

Backed by per-environment job table in Redis (`env:{envId}:jobs:{jobId}` with TTL). Output captured into rolling buffers in Redis (capped at, say, 1MB of recent output per job).

### Phase E — task pack (one PR, no environment dep)

First-class agent task tracking. Backed by Global State (no new storage).

| Tool | Inputs | Output |
|---|---|---|
| `task_create` | `subject`, `description?`, `parentTaskId?`, `metadata?` | `{ taskId }` |
| `task_list` | `status? ('pending'\|'in_progress'\|'completed')`, `parentTaskId?`, `limit?` | `{ tasks: [...] }` |
| `task_update` | `taskId`, `status?`, `subject?`, `description?` | `{ ok: true }` |
| `task_complete` | `taskId`, `result?` | `{ ok: true }` |
| `task_get` | `taskId` | full task doc |

Storage: Global State namespace `agent-tasks:{runId}` (run-scoped) or `agent-tasks:{conversationId}` (conversation-scoped, configurable). Task IDs are opaque shorts (`task_abc123`).

### Phase F — Studio UI for /environments (one PR)

Mirror `/studio/streams` page:
- List view with status badges (closed/opening/open/degraded/closing)
- Create/edit form (name, host, port, user, secretRef picker, workingDir, idleTimeoutMs, maxLifetimeMs, optional open/close commands, archiveOutputLogs flag)
- Live session indicator + force-close button
- Recent commands tail (if archiveOutputLogs enabled)
- "Hosted Environments — coming soon" placeholder section at bottom

### Phase G — Hosted Environments (FUTURE)

Not part of v1. Marked in UI as "coming soon". Schema reserves `kind: 'self-hosted' | 'redbtn-hosted'` discriminator. v2 work would add provisioning logic (spin up a container/VM on request, generate an ephemeral key, register as a hosted environment, tear down on idle).

---

## 3. Specifications

### 3.1 Lifecycle states

```
        .─── opening ─── (success) ──→ open ───┐
       /                                        │
closed                                          │
       \                                        │
        ↖── closing ←── (idle / explicit) ─── degraded ←──┘
                                                  │     (drop / network error)
                                                  ↓
                                               opening (retry)
```

| State | Meaning | Allowed transitions |
|---|---|---|
| `closed` | No active session | → `opening` (on first use) |
| `opening` | SSH handshake in progress | → `open` (success), → `closed` (failure after retries) |
| `open` | Healthy session, ready for ops | → `degraded` (drop), → `closing` (idle / explicit) |
| `degraded` | Connection lost, reconnect attempts in progress, commands buffered | → `opening` (reconnect attempt), → `closed` (gave up after `reconnect.maxAttempts`) |
| `closing` | Graceful close in progress | → `closed` |

Public API exposes a `status` field. Operators see the same state in the Studio UI.

### 3.2 EnvironmentSession runtime shape

```ts
class EnvironmentSession {
  environmentId: string;
  state: 'closed' | 'opening' | 'open' | 'degraded' | 'closing';
  client: ssh2.Client | null;
  sftp: ssh2.SFTPWrapper | null;
  pendingCommands: PendingCommand[];      // queue during 'degraded'
  idleTimer: NodeJS.Timeout | null;
  maxLifetimeTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  openedAt: Date | null;
  lastUsedAt: Date;
  workingDir: string;
  
  async open(): Promise<void> { ... }
  async exec(command: string, opts?): Promise<ExecResult> { ... }
  async sftpRead(path, opts?): Promise<Buffer> { ... }
  async sftpWrite(path, content, opts?): Promise<void> { ... }
  async sftpStat(path): Promise<Stats> { ... }
  async sftpReaddir(path): Promise<DirEntry[]> { ... }
  async close(reason): Promise<void> { ... }
  
  // Internal
  private resetIdleTimer(): void { ... }
  private onUnexpectedClose(): void { ... }   // → degraded → reconnect
  private async drainPendingCommands(): Promise<void> { ... }  // on reconnect success
}
```

### 3.3 EnvironmentManager (per-process singleton)

```ts
class EnvironmentManager {
  private sessions: Map<string, EnvironmentSession>;
  
  async acquire(environmentId: string, userId: string): Promise<EnvironmentSession> {
    // 1. Look up existing session in this.sessions
    // 2. If not present: load Environment doc, resolve secret, create session, .open()
    // 3. Verify caller has access to this environment
    // 4. Reset idle timer
    // 5. Return session (callers use exec / sftp* methods)
  }
  
  async release(environmentId: string): void {
    // Decrement refcount (no-op for now — idle timer handles close)
  }
  
  async closeAll(): Promise<void> { ... }   // shutdown
  async forceClose(environmentId: string): Promise<void> { ... }  // explicit
  status(environmentId: string): EnvironmentStatus { ... }
}

export const environmentManager = new EnvironmentManager();
```

Singleton per worker process. Each worker holds its own pool — same pattern as `RunControlRegistry` (PR #8).

### 3.4 Drop tolerance / command buffering

When `ssh2.Client` emits `'close'` or `'error'` unexpectedly while `state === 'open'`:

1. Transition `state → 'degraded'`
2. Capture in-flight command (if any) as a pending entry
3. Begin reconnect with backoff: attempt N, wait `min(backoffMs * 2^N, maxBackoffMs)`, max `reconnect.maxAttempts` (default 5)
4. New `exec` / `sftp*` calls during this window: append to `pendingCommands` (bounded), return a Promise that resolves when the command runs after reconnect
5. On reconnect success: transition `state → 'open'`, drain `pendingCommands` in FIFO order, resolve their promises
6. On reconnect failure (max attempts): transition `state → 'closed'`, reject all pending commands with `EnvironmentClosedError`

Buffer bounds:
- `pendingCommands.length` capped at 100 (drop oldest with logged warning)
- Total buffered command-bytes capped at 1MB

### 3.5 Schema — `IEnvironment`

```ts
interface IEnvironment {
  environmentId: string;             // user-facing ID
  userId: string;
  name: string;                       // "Alpha Server"
  description?: string;
  
  // Target
  kind: 'self-hosted';                // discriminator; 'redbtn-hosted' reserved for v2
  host: string;
  port: number;                       // default 22
  user: string;
  secretRef: string;                  // secret name holding the SSH private key (PEM)
  workingDir?: string;                // default cwd for exec
  
  // Lifecycle
  idleTimeoutMs: number;              // default 300000 (5 min)
  maxLifetimeMs: number;              // default 28800000 (8 h)
  reconnect: {
    maxAttempts: number;              // default 5
    backoffMs: number;                // default 2000
    maxBackoffMs: number;             // default 30000
  };
  
  // Optional hooks
  openCommand?: string;               // e.g. "git fetch origin"
  closeCommand?: string;              // e.g. "echo session ended"
  
  // Persistence
  archiveOutputLogs: boolean;         // default true — tail every exec to environmentLogs
  
  // Audit
  isPublic: boolean;                  // default false — only owner can use
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}
```

Routes (mirror `/api/v1/streams`):
```
GET    /api/v1/environments                  list (scoped to caller)
POST   /api/v1/environments                  create
GET    /api/v1/environments/:id              read
PATCH  /api/v1/environments/:id              update
DELETE /api/v1/environments/:id              delete (force-closes if open)
GET    /api/v1/environments/:id/status       live runtime status
POST   /api/v1/environments/:id/close        force-close session
GET    /api/v1/environments/:id/logs         tail of recent commands (if archiveOutputLogs)
```

### 3.6 Secret resolution

When opening a session:
1. Read `Environment.secretRef` (string, e.g. `"ALPHA_SERVER_KEY"`)
2. Resolve via `@redbtn/redsecrets` repository (same machinery `enrich-input.ts` uses)
3. Pass the resolved value as `ssh2.ConnectConfig.privateKey: Buffer.from(value, 'utf8')`
4. NEVER cache the resolved secret — fetch fresh per session-open

Optional: support password auth via a second secretRef (`secretRefPassword`) for rare cases where SSH keys aren't viable.

### 3.7 Output log archive

When `archiveOutputLogs: true`, every `exec` call writes a record to a new `environmentLogs` Mongo collection:

```ts
interface IEnvironmentLog {
  environmentId: string;
  userId: string;
  runId?: string;                     // if invoked from a graph run
  command: string;
  cwd: string;
  stdout: string;                     // truncated to e.g. 64KB tail
  stderr: string;                     // same
  exitCode: number | null;
  durationMs: number;
  startedAt: Date;
  expiresAt: Date;                    // TTL — default 30 days
}
```

Indexed `(environmentId, startedAt: -1)`, `(userId, startedAt: -1)`, `(runId, startedAt: -1)`.

---

## 4. Tool inventory (full specs)

All tools below either REQUIRE `environmentId` (Phase C+D) or accept it OPTIONALLY (existing `ssh_shell` / `ssh_copy`).

### 4.1 fs pack — Phase C (REQUIRES environment)

See §2 Phase C table. Six tools: `read_file`, `write_file`, `edit_file`, `glob`, `grep_files`, `list_dir`. All take `environmentId` + op-specific args. SFTP under the hood for I/O ops; SSH exec for grep/glob with shell tools.

**`edit_file` semantics** (Claude-Code style):
- Reads file via SFTP
- If `replaceAll: false`, requires `oldString` to match exactly once — rejects with `AMBIGUOUS_MATCH` if 0 or >1 matches
- Replaces with `newString`
- Writes back via SFTP atomically
- Preserves file mode and trailing newline behavior

### 4.2 process pack — Phase D (REQUIRES environment)

See §2 Phase D table. Four tools: `ssh_run_async`, `ssh_tail`, `ssh_kill`, `ssh_jobs`.

Each "job" is a long-running shell process started via SSH exec without waiting for completion. The output stream is captured into a Redis-backed rolling buffer keyed by `jobId`. The job's PID is tracked for kill semantics.

Job IDs are short (`job_abc123`). Output buffers cap at 1MB tail per job. Jobs and their buffers expire after 24h (configurable per environment).

### 4.3 task pack — Phase E (NO environment dep)

See §2 Phase E table. Five tools: `task_create`, `task_list`, `task_update`, `task_complete`, `task_get`.

Storage: Global State namespace `agent-tasks:{runId}` by default (run-scoped), or `agent-tasks:{conversationId}` if configured (conversation-scoped). Task data:
```ts
interface AgentTask {
  taskId: string;
  subject: string;
  description?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  parentTaskId?: string;
  result?: any;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}
```

Stored as `{ tasks: AgentTask[] }` in the Global State namespace. `task_list` reads, others append/mutate.

### 4.4 Updates to existing tools (Phase B)

- **`ssh_shell`** — adds optional `environmentId` arg. When provided: uses `EnvironmentManager.acquire()` instead of opening a one-shot session. Existing inline `host`/`user`/`sshKey` args still work — ignored when `environmentId` is set, used otherwise.
- **`ssh_copy`** — same treatment.

Backwards compatibility: every existing graph that uses `ssh_shell` continues to work unchanged.

---

## 5. Migrations

### 5.1 Live node configs

No migrations needed for v1 — existing `ssh_shell` calls still work without `environmentId`. Users opt in by adding `environmentId` to their tool step config when they want pooling.

### 5.2 Personal-voice-stream

Once Environments ship, GOD's `red-personal` / `red-work` / etc. subgraphs can be updated to use a dedicated `alpha-server` environment for any ssh_shell calls — gives instant pooling + drop tolerance without code changes.

---

## 6. Testing requirements

### 6.1 Per-component

| Component | Test type | Coverage |
|---|---|---|
| `EnvironmentSession` | Vitest unit | open/close, exec happy path, exec timeout, drop+reconnect, command buffer drain, idle close, max lifetime close |
| `EnvironmentManager` | Vitest unit | acquire (cold + warm), access check, force-close, closeAll on shutdown |
| `/api/v1/environments` routes | E2E (`tests/e2e-prod/`) | CRUD, auth, access denied, status endpoint, force-close, logs tail |
| `ssh_shell` with environmentId | Integration | confirms pooling (second call doesn't re-handshake) |
| fs pack (Phase C) | Per-tool unit + pack integration | each tool happy path + 2 error cases + a chain test (read→edit→read again to verify) |
| process pack (Phase D) | Integration | start a `sleep 30`, tail output, kill it, verify cleanup |
| task pack (Phase E) | Per-tool unit + pack integration | full lifecycle |
| Drop tolerance | Integration (chaos-style) | deliberately kill the SSH connection mid-command, verify reconnect + replay |

### 6.2 Per-phase smoke

After each phase deploys:
- Phase A: trigger a graph that opens an environment via internal API, verify `EnvironmentSession.state === 'open'`
- Phase B: run `ssh_shell({environmentId, command: 'echo hello'})` twice, verify only one SSH handshake in logs
- Phase C: full file lifecycle on a real repo (read → edit → glob → grep → list_dir)
- Phase D: start a long process, tail it, kill it
- Phase E: agent flow with `task_create` → `task_update` → `task_complete`

---

## 7. PR template

Each phase / pack PR uses this template:

```markdown
## Summary

Part of ENVIRONMENT-HANDOFF.md §<n>. <One-sentence summary>.

## Scope

- <list>

## Migrations

- [ ] <SSH commands or "none">

## Test plan

- [ ] Per-component tests pass
- [ ] Phase smoke test passes

## Post-merge SSH commands

```bash
<the migration commands or "none">
```

## Engine version bump

`0.0.<X>-alpha` → `0.0.<X+1>-alpha`. Webapp + worker bumps follow.
```

---

## 8. Open follow-ups (not blocking)

1. **Hosted Environments (Phase G).** Provisioning logic + ephemeral keys + container/VM teardown. Reserves `kind: 'redbtn-hosted'` discriminator now.
2. **Multi-target environments.** Currently 1 environment = 1 host. A "fleet environment" that fans out a single command to N hosts could be useful for ops work; defer until clear need.
3. **`ssh_tunnel` tool.** Open a port forward through an environment for accessing services on the remote network. Niche but powerful.
4. **Browser/screenshot tools.** Playwright/Puppeteer-driven `take_screenshot`, `browser_action`. Doesn't need an environment but needs its own runtime concept (browser pool). Future work, separate handoff.
5. **Hooks for environment lifecycle events.** "On environment opens, fire graph X" (parallel to `startupGraphId` on streams). Not v1.

---

## 9. Status checklist

Phase A — EnvironmentManager core
- [ ] PR opened
- [ ] Merged to beta
- [ ] Merged to main

Phase B — Schema + REST API + ssh_shell/ssh_copy integration
- [ ] PR opened
- [ ] Merged to beta
- [ ] Merged to main
- [ ] Engine version bumped + published
- [ ] Webapp + worker bumped

Phase C — fs pack
- [ ] PR opened
- [ ] Merged to beta + main
- [ ] Smoke: full file lifecycle on a real repo

Phase D — process pack
- [ ] PR opened
- [ ] Merged to beta + main

Phase E — task pack
- [ ] PR opened
- [ ] Merged to beta + main

Phase F — Studio /environments UI
- [ ] PR opened
- [ ] Merged to beta + main
- [ ] "Hosted Environments — coming soon" placeholder visible

Future (Phase G+)
- [ ] Hosted Environments provisioning
- [ ] Multi-target environments
- [ ] ssh_tunnel
- [ ] Browser/screenshot tools
- [ ] Environment lifecycle hooks
