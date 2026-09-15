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
  /** Optimistic concurrency version counter (incremented on checkout/release). */
  version: number;
  /** Maximum number of parallel checkouts allowed (default: 8). */
  maxConcurrentCheckouts: number;
  /** List of currently active checkout sessions. */
  activeCheckouts: IWorkspaceCheckout[];

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
}

export interface CreateWorkspaceInput {
  workspaceId?: string;
  userId: string;
  name: string;
  description?: string;
  resticRepository?: string;
  config?: Partial<IWorkspaceConfig>;
  maxConcurrentCheckouts?: number;
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
