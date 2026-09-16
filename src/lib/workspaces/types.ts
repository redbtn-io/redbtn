/**
 * Workspace subsystem types.
 *
 * Workspaces provide containerized, isolated, stateful filesystem substrates
 * for agent executions (CLI neurons), supporting both exclusive trunk checkouts
 * and parallel branch checkouts for multi-card Redboard workers.
 */

export type CheckoutMode = 'exclusive' | 'branch';

export type WorkspaceStatus =
  | 'idle'
  | 'provisioning'
  | 'ready'
  | 'active'
  | 'snapshotting'
  | 'archived'
  | 'error';

export interface IWorkspaceCheckout {
  /** Unique checkout identifier, e.g. "chk_a1b2c3d4e5". */
  checkoutId: string;
  /**
   * Deduplication key to prevent concurrent executions of the same task.
   * e.g. "trunk" for exclusive main checkouts, or "card-101" for a Redboard card.
   */
  checkoutKey: string;
  /** Checkout concurrency mode. */
  mode: CheckoutMode;
  /** Git branch targeted by this checkout (e.g. "main" or "task/card-101"). */
  branch: string;
  /** Automation or engine run ID holding the checkout. */
  runId: string;
  /** Worker process or pod ID holding the checkout. */
  workerId: string;
  /**
   * Dedicated Environment ID assigned to this checkout session.
   * Matches env_<12chars> and routes to DesktopAgentSession.
   */
  environmentId: string;
  /**
   * Stable install ID passed to redbtn connect.
   * Evaluates to ws_${workspaceId}_${checkoutId}.
   */
  installId: string;
  /**
   * Named Docker volume mounted at /workspace for this checkout.
   * Evaluates to ws_${workspaceId}_${checkoutId}_data.
   */
  volumeName: string;
  /**
   * The fleet node whose redrun worker holds this checkout's container and named
   * volume. Snapshot and reap jobs MUST be routed back to it: a snapshot taken
   * elsewhere finds nothing and silently loses the working copy.
   * Written by `bindCheckoutRuntime` after the spawn returns.
   */
  nodeId?: string;
  /** Container name on `nodeId`, for operator diagnostics. */
  containerName?: string;
  /** Expiration time of the current checkout lease, heartbeated periodically. */
  leaseExpiresAt: Date;
  /** When the checkout was acquired. */
  createdAt: Date;
  /**
   * What this checkout shipped, as the shipping tools report it.
   *
   * Written mid-checkout by `WorkspaceRepository.noteCheckoutShip` — the only
   * moment the pull request is known — and copied into the history entry when
   * the checkout releases. A checkout that never shipped has no `pr` at all.
   */
  pr?: ICheckoutPullRequest;
}

/** The pull request a checkout opened, and the commit it became if it merged. */
export interface ICheckoutPullRequest {
  /** https://github.com/<owner>/<repo>/pull/<n> */
  url: string;
  /** The squashed commit on the base branch, once `workspace_merge` merged it. */
  mergedSha?: string;
}

/**
 * One finished checkout, kept on the workspace so a person can see that their
 * workspace ran: when, on which node, for how long, and what it shipped.
 *
 * Nothing else records this. `activeCheckouts` describes only what is live and
 * the entry is dropped on release, and the run archive (`runEvents`) is keyed
 * by run, not by workspace — so after a run ended the workspace itself had no
 * memory of it. Appended by `releaseWorkspace`, capped at the newest
 * CHECKOUT_HISTORY_LIMIT, oldest first.
 */
export interface ICheckoutHistoryEntry {
  checkoutId: string;
  runId: string;
  mode: CheckoutMode;
  checkoutKey: string;
  branch: string;
  /** The fleet node that held the container and volume, when the spawn bound one. */
  nodeId?: string;
  acquiredAt: Date;
  releasedAt: Date;
  /** `releasedAt - acquiredAt`, precomputed so the UI never has to subtract dates. */
  durationMs: number;
  /** Whether the release ran clean, or the snapshot failed and it released anyway. */
  outcome: 'released' | 'error';
  /** The node deleted the working copy (branch checkouts always do). */
  volumeRemoved?: boolean;
  /** The node kept the runner alive for the next checkout (hot tier). */
  parked?: boolean;
  /** The snapshot this release committed to the trunk, when it took one. */
  snapshotId?: string | null;
  /** What it shipped, copied off the checkout at release. */
  pr?: ICheckoutPullRequest;
}

/**
 * How much snapshot history a workspace keeps.
 *
 * Every release of a trunk checkout writes an UNTAGGED restic snapshot into the
 * workspace's own repository, and until this existed nothing ever removed one:
 * the history grew for the life of the workspace and was only ever collected
 * when the workspace itself was deleted. These two numbers are the forget
 * policy the node applies right after a successful backup — restic keeps a
 * snapshot that satisfies EITHER rule, so a busy day is not pruned down to
 * `keepLast` and a quiet month still keeps something.
 *
 * Both come from the owner's storage tier (see ./tiers.ts), which supplies the
 * default AND the ceiling.
 */
export interface IWorkspaceSnapshotRetention {
  /** Always keep this many of the most recent snapshots. Never 0. */
  keepLast: number;
  /**
   * Also keep every snapshot taken within this many days.
   *
   * `0` means NO TIME BOUND: keep the latest `keepLast` and nothing else,
   * however old they are. Only the tiers whose `snapshotRetentionMax` says
   * `allowNoTimeLimit` may be clamped to it (see `clampSnapshotRetention`); on
   * every other plan a zero is floored to 1 day.
   */
  keepWithinDays: number;
}

export interface IWorkspaceConfig {
  /** Docker image used for the workspace container runner. */
  dockerImage: string;
  /** CPU limit passed to container runtime, e.g. "2.0". */
  cpuLimit: string;
  /** Memory limit passed to container runtime, e.g. "4096m". */
  memLimit: string;
  /** Default working directory. Strictly "/workspace". */
  defaultCwd: string;
  /** Optional Git repository URL to clone on initialization. */
  gitRepoUrl?: string;
  /** Default Git branch to clone or track (default: "main"). */
  gitBranch?: string;
  /**
   * How long the node pin stays warm after a checkout releases, in seconds
   * (default 86400). It tracks the node-side volume reaper's TTL: once that has
   * deleted the idle volume there is nothing warm left to go back to, and a pin
   * that outlives it only sends the next run to a node that must restore from
   * scratch — or, if the node has left the fleet, to a queue nobody consumes.
   */
  warmTtlSeconds?: number;
  /**
   * How long the CONTAINER stays alive after a checkout releases, in seconds
   * (default 0 — off). Above zero the release parks the runner instead of
   * destroying it and the next checkout on that node adopts it, paying neither
   * the container start nor the runner's registration; the working copy is warm
   * either way. Capped at an hour: a parked runner holds this node's memory for
   * nobody at all.
   */
  hotIdleSeconds?: number;
  /**
   * How many snapshots the trunk repository keeps, and for how long (default:
   * the owner's tier, filled at create). ABSENT means "forget nothing" — every
   * workspace created before retention existed has no value here, and pruning a
   * paying account's history on a guess is not a default worth having. Those
   * documents pick one up the next time their config is saved.
   */
  snapshotRetention?: IWorkspaceSnapshotRetention;
}

/**
 * The runner a release left alive, and what the next checkout needs to take it
 * over: the install id its environment is registered under, and where it is.
 *
 * Only a hint — the park marker inside the volume is what the node actually
 * decides on — but it is what lets the engine skip the registration wait and
 * send the spawn to the node holding the warm container.
 */
export interface IParkedCheckout {
  /** The checkout that parked it. */
  checkoutId: string;
  /** The install id the parked runner registered under; the adopting checkout inherits it. */
  installId: string;
  environmentId: string;
  containerName: string;
  nodeId: string;
  /** Past this, the node reaps the container and the record means nothing. */
  parkedUntil: Date;
}

export interface IWorkspaceStats {
  /** Byte size of latest restic snapshot on trunk. */
  snapshotSizeBytes: number;
  /** Timestamp of the last successful restic snapshot. */
  lastSnapshotAt: Date | null;
  /** File count in the workspace at last snapshot. */
  fileCount: number;
  /** Total number of checkouts and runs completed. */
  totalRunCount: number;
  /** Cumulative compute duration across all checkouts. */
  totalComputeSeconds: number;
  /**
   * When a release last ran the forget pass over this workspace's restic
   * repository.
   *
   * Absent on a workspace whose releases never carried a policy: its history has
   * never been pruned, which is a different thing from pruned and nothing went.
   */
  lastSnapshotRetentionAt?: Date;
  /**
   * How many snapshots that pass removed.
   *
   * `null` is "it ran, restic's output did not say how much" — the worker
   * distinguishes that from `0`, which is a real "nothing was old enough", and
   * so does this. Reading null as zero would report a repository as trimmed when
   * nobody knows whether it was.
   */
  lastSnapshotRetentionRemoved?: number | null;
}

export interface IWorkspace {
  /** User-facing ID, e.g. "ws_f7XnBy4Gon0Y". */
  workspaceId: string;
  /** Owner user ID. */
  userId: string;
  /** Display name (e.g. "Become", "Zeta Project"). */
  name: string;
  /** Optional human-readable description. */
  description?: string;

  // --- Storage & Restic baseline ---
  /** S3/MinIO restic repository URI. */
  resticRepository: string;
  /** Hash of the latest restic snapshot on the default branch (main). */
  currentSnapshotId: string | null;

  /** Container and runtime configuration. */
  config: IWorkspaceConfig;
  /** Workspace usage and snapshot statistics. */
  stats: IWorkspaceStats;

  // --- Concurrency & Checkouts ---
  /**
   * The node whose docker daemon holds this workspace's named volume, recorded
   * after each successful spawn. The next checkout prefers it so the working
   * copy is reused rather than restored from object storage.
   */
  nodeId?: string;
  /**
   * When the `nodeId` pin stops being worth following, refreshed on every spawn
   * and release. Past it the volume is assumed reaped and the next checkout is
   * placed fresh. Absent on records written before the warm window existed;
   * those keep today's behaviour until they release once.
   */
  nodePinnedUntil?: Date | null;
  /**
   * The runner still alive on `nodeId` from the last release, when the
   * workspace runs a hot tier (`config.hotIdleSeconds`). Consumed by the next
   * acquire and cleared whenever the node does not hand it back.
   */
  parkedCheckout?: IParkedCheckout | null;
  /** Optimistic concurrency version counter (incremented on checkout/release). */
  version: number;
  /** Maximum number of parallel checkouts allowed (default: 8). */
  maxConcurrentCheckouts: number;
  /** List of currently active checkout sessions. */
  activeCheckouts: IWorkspaceCheckout[];
  /**
   * Finished checkouts, oldest first, capped at CHECKOUT_HISTORY_LIMIT by the
   * `$slice` on the push. Absent on documents written before the history
   * existed, and on a workspace that has never released a checkout.
   */
  checkoutHistory?: ICheckoutHistoryEntry[];

  createdAt: Date;
  updatedAt: Date;
}

export interface ICheckoutOptions {
  workspaceId: string;
  runId: string;
  workerId: string;
  /** Deduplication key (e.g. "trunk", "card-101"). Defaults to "trunk". */
  checkoutKey?: string;
  /** Checkout concurrency mode. Defaults to "exclusive". */
  mode?: CheckoutMode;
  /** Git branch to checkout. Defaults to "main" or "task/<checkoutKey>". */
  branch?: string;
  /** Lease duration in milliseconds. Defaults to DEFAULT_LEASE_DURATION_MS (30 min). */
  leaseDurationMs?: number;
}

export interface IReleaseOptions {
  workspaceId: string;
  checkoutId: string;
  runId: string;
  /**
   * Only consulted when `enforceVersion` is set. The release is guarded on the
   * checkout itself (checkoutId + runId), because `version` is bumped by every
   * concurrent checkout — see WorkspaceRepository.releaseWorkspace.
   */
  expectedVersion?: number;
  /** Opt in to the stricter whole-document version CAS. */
  enforceVersion?: boolean;
  /** Whether changes should update the parent workspace trunk snapshot. */
  commitTrunkSnapshot?: boolean;
  /** Snapshot metadata if a new snapshot was taken. */
  snapshotMeta?: {
    snapshotId: string;
    snapshotSizeBytes: number;
    fileCount: number;
    computeSeconds: number;
  };
  /**
   * How this checkout ended, for the history entry. Defaults to `released`;
   * `error` means the release went through but something on the way (the
   * snapshot, the spawn it is unwinding) did not.
   */
  outcome?: 'released' | 'error';
  /** The node reported deleting the working copy. Recorded on the entry. */
  volumeRemoved?: boolean;
  /** The node reported keeping the runner alive. Recorded on the entry. */
  parked?: boolean;
  /**
   * What the node's forget pass did, as the snapshot job reported it.
   *
   * Absent leaves `stats.lastSnapshotRetention*` exactly as they were: a release
   * that carried no policy, a worker too old to report one, and a snapshot that
   * never came back are all "this release says nothing about retention", and
   * stamping them over the last real answer would erase it.
   */
  retention?: IReleaseRetention;
}

/**
 * The outcome of one restic forget, off the snapshot job result.
 *
 * `removed: null` means the forget ran and the count is unknown — restic's
 * output held no number, or the forget itself failed and the worker swallowed it
 * because the snapshot had already succeeded.
 */
export interface IReleaseRetention {
  keepLast: number;
  /** As `IWorkspaceSnapshotRetention.keepWithinDays`: 0 is "no time bound". */
  keepWithinDays: number;
  removed: number | null;
}

export interface CreateWorkspaceInput {
  workspaceId?: string;
  userId: string;
  name: string;
  description?: string;
  resticRepository?: string;
  config?: Partial<IWorkspaceConfig>;
  maxConcurrentCheckouts?: number;
  /**
   * The owner's account tier (`accountLevel`, 0 = admin), which decides the
   * workspace's warm/hot windows and concurrency — see `./tiers.ts`. Absent
   * means "we do not know who this is", which resolves to the lowest tier; every
   * caller that has a user in hand should pass it, or it hands out a Free
   * workspace to a paying account.
   */
  accountTier?: number;
}

// --- Errors ---

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

export class WorkspaceNotFoundError extends WorkspaceError {
  constructor(workspaceId: string) {
    super(`Workspace "${workspaceId}" not found`);
    this.name = 'WorkspaceNotFoundError';
  }
}

export class WorkspaceLockedError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLockedError';
  }
}

export class WorkspaceLeaseLostError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceLeaseLostError';
  }
}

export class WorkspaceVersionConflictError extends WorkspaceError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceVersionConflictError';
  }
}
