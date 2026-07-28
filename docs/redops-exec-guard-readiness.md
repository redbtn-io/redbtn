# Red Ops exec-guard readiness — non-capability shadow gates (rate limit + durable audit)

**Board item:** `[P0 security] Red Ops graphs: attach exec capabilities profile + plan ENFORCE_INTERNAL_SERVICE_ORIGIN`
**Work unit:** `redops-exec-guard-readiness` — quantify and close the non-capability shadow-relaxed gates.
**Author:** Red Ops Worker (engine)  **Date generated:** 2026-07-28

A capability profile (the sibling unit) removes only ONE of three shadow-relaxed exec gates. This report
quantifies the other two — the fixed-window **rate limit** (Gate 8b) and the fail-closed **durable audit**
(Gate 7) in `src/lib/permissions/exec-guard.ts` — for the three Red Ops graphs, and lands the config +
test coverage the evidence justifies. **No production env var is changed and no container is recreated by
this unit;** the limit values below are documented (see `.env.example`), for George to apply.

---

## 1. Evidence — durable exec-attempt records

**Source of truth:** `redbtn.execaudits` on the prod MongoDB (`192.168.1.10:27017`), the collection written by
`POST /api/v1/permissions/exec-attempts` (webapp `ExecAudit` model, `collection: 'execaudits'`, 90-day TTL).
Denials (`POST /api/v1/permissions/denials`) land in the separate `capabilitydenials` collection — the
capability gate's shadow record, owned by the sibling unit; the rate/audit gates this unit owns record into
`execaudits`.

**Named window:** `2026-07-01T17:00:02Z → 2026-07-28T06:48:27Z` (~27 days, the full retained collection).
**Query date:** 2026-07-28. **Total records in window:** 20,045 — every one under the single shared Red Ops
principal `userId = 69a0b790a0ae8660290a78da`.

### 1a. Overall, by outcome × blockCode

| outcome | blockCode | count | share |
|---|---|---:|---:|
| allowed | — | 19,133 | 95.45% |
| blocked | `rate_limited` | 902 | 4.50% |
| blocked | `audit_unavailable` | 10 | 0.05% |
| blocked | `shadow_rate` | **0** | 0% |
| blocked | `shadow_capability` | **0** | 0% |

### 1b. The three Red Ops graphs, by outcome × blockCode

| graphId | role | allowed | `rate_limited` | `audit_unavailable` | total |
|---|---|---:|---:|---:|---:|
| `tHXXSTFtOuM9` | Coordinator | 6,442 | 84 | 0 | 6,526 |
| `eCrxF8-glwgW` | Worker | 4,932 | 447 | 4 | 5,383 |
| `red-reviewer` | Reviewer | 6,240 | 371 | 6 | 6,617 |
| **subtotal (3 graphs)** | | **17,614** | **902** | **10** | **18,526** |

The three Red Ops graphs account for **100%** of every `rate_limited` and `audit_unavailable` block in the
collection. The remaining 1,519 records (`tpf-ai` 644, `code-tracker` 525, `cli-agent` 340, and a handful of
others — all the same principal) are **all `allowed`**. No exec attempt in the window carries a `graphId`
outside this principal's graphs.

### 1c. The critical interpretation — these are HARD blocks, not shadow logs

`exec-guard.ts` only emits blockCode `shadow_rate` when `PERMISSIONS_SHADOW=true` relaxes the rate gate (and
then the call is **allowed through**). It emits the bare `rate_limited` / `audit_unavailable` codes only when
the gate actually **threw `ExecBlockedError`** and the call was **denied** (recorded by
`native-registry.ts` callTool's catch). Across 20,045 records:

- **Zero** `shadow_rate` and **zero** `shadow_capability` records exist.
- **902** attempts were denied with the hard `rate_limited` code, and **10** with hard `audit_unavailable`.

⇒ For the rate and audit gates, **"shadow-off" is not a hypothetical — it is already the operative
condition.** These 912 attempts were real exec calls that were actually blocked in production. The rate gate
at its current effective configuration has already hard-blocked Red Ops exec 902 times.

### 1d. When the blocks happened

`rate_limited` by day (UTC): `07-20`: 92 · `07-21`: 34 · `07-22`: 528 · `07-23`: 248 · (none after).
`audit_unavailable` by day: `07-22`: 3 · `07-23`: 7 · (none otherwise).

The rate blocks stop after 2026-07-23, coinciding with `redhub.pipeline_settings.maxConcurrent` being
throttled to **1** on 2026-07-22 (`updatedBy: "george@redbtn.io (via claude, quota conservation)"`). The
blocks are a direct function of concurrency: raise `maxConcurrent` again and, at the default cap, they
return. The 10 `audit_unavailable` events are two short webapp-sink outages, not a systemic auth failure
(0.05% of attempts; see §3).

---

## 2. Rate-limit sizing (arithmetic)

**Binding constraint = the per-USER cap (`EXEC_RATE_MAX`).** All Red Ops runs share ONE principal, so the
per-user window governs the *aggregate* exec rate of Coordinator + Worker + Reviewer combined. The per-ENV
cap (`EXEC_RATE_MAX_ENV`) is **never engaged** by Red Ops: 20,042 of 20,045 records have `address = '*'`
(no `environmentId` is passed to `ssh_shell`), and `exec-guard.ts` only increments the per-env bucket
`if (envId)`.

**Observed peak concurrency** (per aligned 60s bucket = `floor(epoch/60)`, exactly the gate's bucket), for
the shared principal:

| metric | value |
|---|---|
| busiest 60s bucket | **514 calls/min** (2026-07-23 22:21 UTC) |
| next busiest buckets | 297, 148, 133, 122, 107, 104, 79, 75, 59 calls/min |
| mean over 5,885 active minutes | 3.41 calls/min |
| minutes > 30/min (default cap) | 30 |
| minutes > 60 / > 90 / > 120 | 9 / 7 / 5 |

**Arithmetic:**

- Each executor run issues **3 `ssh_shell` calls**; Coordinator/Reviewer add liveness + setup SSH.
- Default `EXEC_RATE_MAX = 30` per `EXEC_RATE_WINDOW_S = 60` ⇒ 30 exec calls/min ⇒ only **10 executor-runs'
  worth of SSH per minute for the entire fleet** (30 ÷ 3). Observed peak = 514/min ≈ **171 run-equivalents**
  — 17× the default. Hence the 902 hard blocks.
- Size to cover the empirical peak with growth headroom while still bounding a runaway:
  `EXEC_RATE_MAX = ceil(514 × 1.45) ≈ 745 → round to` **`750`** ` / 60s`.
  At 750/60s (12.5 calls/s) a genuine runaway `ssh` loop is still bounded (vs. unbounded today), so the
  gate keeps its purpose.
- `EXEC_RATE_WINDOW_S` = **60** (retain default): the observed bursts are minute-scale (the 514 peak is a
  single aligned minute); a shorter fixed window would clip legitimate coordinator fan-out at window
  boundaries. Justified by the per-minute histogram above.
- `EXEC_RATE_MAX_ENV` = **120** / 60s (up from default 60): does **not** gate Red Ops today (address `'*'`),
  but a per-environment exec session could legitimately host a fan-out too; 120 keeps per-machine blast
  radius bounded well under the per-user 750 while giving env-scoped exec users 2× the default headroom.
  The largest single-env burst observed was 4 calls, so this is conservative. If Red Ops ever migrates to
  per-environment sessions, this becomes binding and must track `EXEC_RATE_MAX`.

**Recommended (documented, NOT applied):**

```
EXEC_RATE_MAX=750        # per-user per window; sized to observed 514/min peak × 1.45 headroom
EXEC_RATE_WINDOW_S=60    # retain; bursts are minute-scale
EXEC_RATE_MAX_ENV=120    # per-env; not a Red Ops constraint today (address='*')
```

---

## 3. Durable-audit gate — does it authenticate for an engine run?

**Yes.** The 19,133 `allowed` records are themselves proof: `POST /api/v1/permissions/exec-attempts` returns
2xx (and thus a record exists) **only** after the webapp's `getUserFromRequest` authenticates the caller.
Engine/worker runs carry **no user Bearer token**; they authenticate as a **service principal**
(`X-Internal-Key` + `X-User-Id`, per `persist-denial.ts` `buildAuthHeaders`), which the webapp honors as
`internal@redbtn.io`. A 99.95% audit success rate (19,133 of 19,143 non-rate attempts) confirms
`auditAttempt` reliably authenticates in the real Red Ops engine context. The 10 `audit_unavailable` events
are transient sink outages (two windows on 07-22/07-23), correctly failing closed at the time.

Test coverage added in `tests/permissions/exec-guard.test.ts` pins both directions:

- `auditAttempt` returns **true** and sends `X-Internal-Key` + `X-User-Id` (no `Authorization`) for a
  representative engine context (`state.userId` set, no `authToken`, `INTERNAL_SERVICE_KEY` present) — the
  exact shape every Red Ops run uses.
- `auditAttempt` returns **false** and never POSTs when neither a Bearer token nor an internal key is
  available — deliberately exercising the fail-closed trigger.
- `runExecGuard` allows a Red Ops engine run end-to-end when the service principal audits, and **denies**
  (`audit_unavailable`) with shadow OFF when the service credential is missing.

---

## 4. Go / No-Go at shadow-off — one sentence each

- **Rate-limit gate:** **WOULD BLOCK** Red Ops at the current default `EXEC_RATE_MAX=30` — it already has, 902
  times in 27 days — so `EXEC_RATE_MAX` must be raised to **750/60s** (per §2) before/with any concurrency
  increase, after which observed peaks clear.
- **Durable-audit gate:** **WOULD NOT BLOCK** — `auditAttempt` authenticates as a service principal on the
  engine run context (19,133 successful audits, 99.95%), so no config change is needed for the audit gate
  and its fail-closed path only trips on a genuine sink outage — **provided `WEBAPP_URL` stays a
  fleet-internal origin (see §5)**.

---

## 5. WEBAPP_URL ↔ ENFORCE_INTERNAL_SERVICE_ORIGIN — coordination note (hand-off to the origin-enforcement unit)

The audit sink base is `resolveWebappBase()` = `WEBAPP_URL`, and the engine posts to it with
`X-Internal-Key` + `X-User-Id`. The webapp's `getUserFromRequest` (`src/lib/auth/auth.ts:241-247`) rejects
the service-key principal when `ENFORCE_INTERNAL_SERVICE_ORIGIN=true` **and** the request is not
fleet-internal (`isInternalOriginRequest`: `cf-connecting-ip` absent AND client IP private/absent).

**The exec-attempts POST is therefore a fail-closed internal caller.** Because the audit gate is fail-closed
(Gate 7 denies when `auditAttempt` returns false, shadow off), the following is a hard dependency for the
origin flip:

- **If the prod engine's `WEBAPP_URL` reaches the webapp via Cloudflare (`app.redbtn.io`)**, the POST carries
  `cf-connecting-ip` ⇒ after the flip `getUserFromRequest` returns null ⇒ 401 ⇒ `auditAttempt` returns false
  ⇒ **every Red Ops exec is denied fleet-wide.** → **NO-GO until `WEBAPP_URL` is repointed to an internal
  origin.**
- **If `WEBAPP_URL` already resolves to a fleet-internal address** (private IP / WG / host-internal, no CF),
  audits keep authenticating and the flip is safe for this caller. → **GO for this caller.**

The 19,133 successful audits prove the header is honored **today**, but that is under the default
`ENFORCE_INTERNAL_SERVICE_ORIGIN=false`, so it does **not** by itself reveal whether the route is internal or
CF. The determinant is the runtime value of the prod engine/worker's `WEBAPP_URL` — the **same configuration
the origin-enforcement unit inventories**. Exact check for that unit to run against the deployed engine
container:

```
# On the host running the redbtn engine/worker container:
docker exec <engine-or-worker-container> printenv WEBAPP_URL
# GO if it is an internal/private host (e.g. http://10.100.0.x:3000, http://192.168.1.x:3000, a container
#    name, or localhost); NO-GO if it is https://app.redbtn.io (Cloudflare) until repointed.
```

**Action for the origin-enforcement unit:** add the engine → `/api/v1/permissions/exec-attempts` POST (and
the twin `/api/v1/permissions/denials` POST) to the caller inventory as **fail-closed internal callers**, and
gate the flip on `WEBAPP_URL` being a non-Cloudflare origin.
