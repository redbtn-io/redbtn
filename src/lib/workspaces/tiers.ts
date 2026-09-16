/**
 * Storage tiers: what a workspace's warm/hot windows and concurrency default to,
 * and how far a user may push them, as a function of who owns it.
 *
 * `snapshotRetention` (how much restic history a trunk workspace keeps) joins
 * them: every release wrote a snapshot nothing ever forgot, so storage grew
 * until the workspace was deleted. How much history is worth paying to keep is
 * the same question as how long a volume stays warm, and it gets the same
 * answer — the tier.
 *
 * `warmTtlSeconds` (how long the node pin and the warm volume live) and
 * `hotIdleSeconds` (how long a parked runner is held for the next checkout) were
 * flat defaults for everybody: 24 h warm, hot off, 8 parallel checkouts,
 * whoever you are. Both cost real fleet resources — a warm volume is disk on one
 * node, a parked runner is that node's memory held for nobody — so the ceiling
 * has to come from somewhere. It comes from the account tier: the tier sets the
 * default AND the hard cap, and a user who wants a longer window moves up a
 * tier. (Metering per-workspace overage is a later card; this is the floor it
 * will build on.)
 *
 * Tier numbers are `accountLevel` on the redauth user document, which the engine
 * already resolves onto run state as `accountTier` (see `loadUserSettings` in
 * `src/functions/run.ts`): 0 ADMIN, 1 ENTERPRISE, 2 PRO, 3 BASIC, 4 FREE.
 * Anything else — absent, non-numeric, out of range — is treated as FREE, which
 * is the same fallback the run path uses and the safe direction to be wrong in.
 *
 * ALL the numbers live in WORKSPACE_TIER_POLICIES below; nothing else in this
 * file hardcodes a duration. Tuning a tier is editing one row.
 */

import type { IWorkspaceConfig, IWorkspaceSnapshotRetention } from './types.js';

/** Named account tiers, in `accountLevel` order. */
export type WorkspaceTierName = 'admin' | 'enterprise' | 'pro' | 'basic' | 'free';

/** What a tier gives you on one axis: what you get by default, and the ceiling. */
export interface WorkspaceTierLimit {
  /** Applied when the workspace does not ask for a value of its own. */
  default: number;
  /** The hard cap. An explicit value above this is clamped down to it, never refused. */
  max: number;
}

/**
 * The ceiling a tier puts on an EXPLICIT retention ask, which is no longer the
 * same thing as the default it hands out.
 *
 * George, 2026-09-16: "give me the best retention, if possible no time limit,
 * just latest N". The two halves used to be one number each — default and cap at
 * once — so "keep the last 100 and never mind how old they are" could not be
 * said at all: `keepLast` was capped at the default 30 and `keepWithinDays` was
 * floored at 1 day. This is the cap half, split out, so the default can stay
 * modest while the ceiling goes where the plan can afford it.
 */
export interface WorkspaceRetentionLimits {
  /** The largest `keepLast` an explicit ask may reach. */
  keepLast: number;
  /** The largest `keepWithinDays` an explicit ask may reach. */
  keepWithinDays: number;
  /**
   * Whether this plan may ask for `keepWithinDays: 0` — "no time bound, just
   * the latest N". Everyone else is floored at 1 day, because a zero on a tier
   * that did not buy unbounded history is a typo, and reading it as "forever"
   * would grow storage on a slip of the finger.
   */
  allowNoTimeLimit: boolean;
}

export interface WorkspaceTierPolicy {
  /** The tier this policy belongs to. */
  tier: WorkspaceTierName;
  /** Display name for the tier, for UI that tells a user which plan they are on. */
  label: string;
  /**
   * The canonical `accountLevel` of this tier — NOT necessarily the number that
   * was looked up: an unrecognised level resolves to the FREE policy and reports
   * 4, so a caller can echo back the tier it actually applied.
   */
  accountTier: number;
  /** How long the node pin / warm volume may live after a release. */
  warmTtlSeconds: WorkspaceTierLimit;
  /** How long a released runner may stay parked. 0 = off (destroy on release). */
  hotIdleSeconds: WorkspaceTierLimit;
  /** How many checkouts may hold this workspace at once. */
  maxConcurrentCheckouts: WorkspaceTierLimit;
  /**
   * How much snapshot history a release leaves behind BY DEFAULT — what a new
   * workspace that asked for nothing gets.
   */
  snapshotRetention: IWorkspaceSnapshotRetention;
  /**
   * How far an explicit ask may push that default. Asking for more history than
   * the plan pays for is the whole thing the cap exists to stop, and asking for
   * LESS is always allowed.
   */
  snapshotRetentionMax: WorkspaceRetentionLimits;
}

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const MINUTE = 60;

/**
 * The whole tier table. Tune here — every default and every cap in the
 * workspace subsystem is one of these numbers.
 *
 * Shape notes:
 *  - warm caps stay inside what the node-side volume reaper will honour; a pin
 *    that outlives the volume points at a node with nothing warm on it.
 *  - hot caps stay at or under MAX_HOT_IDLE_SECONDS (1 h): a park long enough to
 *    outlive the runner's registration token buys a container that cannot
 *    reconnect.
 *  - concurrency keeps headroom above its default so a user who genuinely runs
 *    several cards in parallel can raise it without changing plan; the cap is
 *    what stops one workspace from taking a whole node.
 *  - retention is two rules at once and restic keeps a snapshot matching
 *    EITHER, so `keepLast` protects a burst of releases in one afternoon and
 *    `keepWithinDays` protects a workspace nobody has touched for a fortnight.
 *    It is the one axis whose default and cap differ: `snapshotRetention` is
 *    what a workspace gets, `snapshotRetentionMax` is how far it may be pushed,
 *    and only the top two plans may push `keepWithinDays` all the way to 0 —
 *    "no time limit, just the latest N".
 */
export const WORKSPACE_TIER_POLICIES: Record<WorkspaceTierName, WorkspaceTierPolicy> = {
  admin: {
    tier: 'admin',
    label: 'Admin',
    accountTier: 0,
    warmTtlSeconds: { default: 72 * HOUR, max: 7 * DAY },
    hotIdleSeconds: { default: 15 * MINUTE, max: 60 * MINUTE },
    maxConcurrentCheckouts: { default: 4, max: 8 },
    snapshotRetention: { keepLast: 30, keepWithinDays: 30 },
    snapshotRetentionMax: { keepLast: 100, keepWithinDays: 30, allowNoTimeLimit: true },
  },
  enterprise: {
    tier: 'enterprise',
    label: 'Enterprise',
    accountTier: 1,
    warmTtlSeconds: { default: 72 * HOUR, max: 7 * DAY },
    hotIdleSeconds: { default: 15 * MINUTE, max: 60 * MINUTE },
    maxConcurrentCheckouts: { default: 4, max: 8 },
    snapshotRetention: { keepLast: 30, keepWithinDays: 30 },
    snapshotRetentionMax: { keepLast: 100, keepWithinDays: 30, allowNoTimeLimit: true },
  },
  pro: {
    tier: 'pro',
    label: 'Pro',
    accountTier: 2,
    warmTtlSeconds: { default: 24 * HOUR, max: 72 * HOUR },
    hotIdleSeconds: { default: 5 * MINUTE, max: 15 * MINUTE },
    maxConcurrentCheckouts: { default: 2, max: 4 },
    snapshotRetention: { keepLast: 10, keepWithinDays: 14 },
    snapshotRetentionMax: { keepLast: 10, keepWithinDays: 14, allowNoTimeLimit: false },
  },
  basic: {
    tier: 'basic',
    label: 'Basic',
    accountTier: 3,
    warmTtlSeconds: { default: 24 * HOUR, max: 72 * HOUR },
    hotIdleSeconds: { default: 5 * MINUTE, max: 15 * MINUTE },
    maxConcurrentCheckouts: { default: 2, max: 4 },
    snapshotRetention: { keepLast: 10, keepWithinDays: 14 },
    snapshotRetentionMax: { keepLast: 10, keepWithinDays: 14, allowNoTimeLimit: false },
  },
  free: {
    tier: 'free',
    label: 'Free',
    accountTier: 4,
    warmTtlSeconds: { default: 6 * HOUR, max: 24 * HOUR },
    hotIdleSeconds: { default: 0, max: 5 * MINUTE },
    maxConcurrentCheckouts: { default: 1, max: 2 },
    snapshotRetention: { keepLast: 3, keepWithinDays: 7 },
    snapshotRetentionMax: { keepLast: 3, keepWithinDays: 7, allowNoTimeLimit: false },
  },
};

/** The policy applied to anyone we cannot place — absent, unknown or out-of-range tier. */
export const DEFAULT_WORKSPACE_TIER: WorkspaceTierName = 'free';

const TIER_BY_LEVEL: readonly WorkspaceTierName[] = [
  'admin',
  'enterprise',
  'pro',
  'basic',
  'free',
];

/** `accountLevel` → tier name, with everything unrecognised landing on FREE. */
export function workspaceTierName(accountTier?: number | null): WorkspaceTierName {
  if (typeof accountTier !== 'number' || !Number.isFinite(accountTier)) {
    return DEFAULT_WORKSPACE_TIER;
  }
  const level = Math.floor(accountTier);
  return TIER_BY_LEVEL[level] ?? DEFAULT_WORKSPACE_TIER;
}

/**
 * The tier policy for an account level. This is the only entry point callers
 * need: `workspaceTierPolicy(user.accountLevel)`.
 */
export function workspaceTierPolicy(accountTier?: number | null): WorkspaceTierPolicy {
  return WORKSPACE_TIER_POLICIES[workspaceTierName(accountTier)];
}

/** A policy, or the account level to look one up from. */
export type TierOrPolicy = WorkspaceTierPolicy | number | null | undefined;

function resolvePolicy(tier: TierOrPolicy): WorkspaceTierPolicy {
  if (tier && typeof tier === 'object' && 'maxConcurrentCheckouts' in tier) return tier;
  return workspaceTierPolicy(typeof tier === 'number' ? tier : null);
}

/**
 * One value against one limit: absent/unusable → the tier default, otherwise
 * floored into `[floor, limit.max]`.
 *
 * `floor` is 1 for a duration nobody wants set to zero and 0 for the hot window,
 * where zero is a meaningful setting (park nothing).
 */
function clampToLimit(
  value: unknown,
  limit: WorkspaceTierLimit,
  floor: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return limit.default;
  const asked = Math.floor(value);
  if (asked <= floor) return floor;
  return Math.min(asked, limit.max);
}

/**
 * Fill a workspace config's tier-governed fields: anything the caller left out
 * takes the tier default, anything it asked for is clamped to the tier cap.
 *
 * Three fields — the warm window, the hot window and the snapshot retention.
 * Retention is the one whose cap is not its default: `snapshotRetentionMax` is
 * what an explicit ask is measured against, so a create that names
 * `{ keepLast: 100, keepWithinDays: 0 }` on an admin account keeps it, while
 * one that names nothing still gets the modest 30/30 default.
 *
 * Everything else on the config (image, cpu, memory, git) is passed through
 * untouched.
 */
export function applyTierPolicy<T extends Partial<IWorkspaceConfig>>(
  config: T | null | undefined,
  policy: WorkspaceTierPolicy,
): T & {
  warmTtlSeconds: number;
  hotIdleSeconds: number;
  snapshotRetention: IWorkspaceSnapshotRetention;
} {
  const source = (config ?? {}) as T;
  return {
    ...source,
    warmTtlSeconds: clampToLimit(source.warmTtlSeconds, policy.warmTtlSeconds, 1),
    hotIdleSeconds: clampToLimit(source.hotIdleSeconds, policy.hotIdleSeconds, 0),
    snapshotRetention: clampSnapshotRetention(source.snapshotRetention, policy),
  };
}

/**
 * How much history this tier lets a workspace that asked for `value` keep.
 *
 * Absent or unusable → the tier's own defaults. A partial ask ({keepLast} with
 * no window, say) fills the other half from the tier rather than inventing a
 * zero, because a half-stated policy is not a policy. Each half is capped at
 * `snapshotRetentionMax`, so a user may always keep LESS than their plan pays
 * for and never more.
 *
 * The one asymmetry is zero. `keepWithinDays: 0` means "no time bound — keep
 * the latest `keepLast`, however old they are", which is a real setting and the
 * one George asked for; on every other tier zero is still floored to 1 day,
 * because there it is a typo rather than a purchase. `keepLast: 0` is a typo
 * everywhere — it would forget the snapshot the release just took — so it is
 * floored to 1 on all five plans.
 */
export function clampSnapshotRetention(
  value: unknown,
  policy: WorkspaceTierPolicy,
): IWorkspaceSnapshotRetention {
  const fallback = policy.snapshotRetention;
  const limits = policy.snapshotRetentionMax;
  if (!value || typeof value !== 'object') return { ...fallback };
  const asked = value as Partial<IWorkspaceSnapshotRetention>;
  const half = (n: unknown, fallbackValue: number, max: number, floor: number): number => {
    if (typeof n !== 'number' || !Number.isFinite(n)) return fallbackValue;
    return Math.min(Math.max(floor, Math.floor(n)), max);
  };
  return {
    keepLast: half(asked.keepLast, fallback.keepLast, limits.keepLast, 1),
    keepWithinDays: half(
      asked.keepWithinDays,
      fallback.keepWithinDays,
      limits.keepWithinDays,
      limits.allowNoTimeLimit ? 0 : 1,
    ),
  };
}

/**
 * The retention in words, for anything that has to show a user what their
 * workspace keeps.
 *
 * Exported because "no time limit" cannot be rendered by a template that always
 * prints a day count — `keepWithinDays: 0` would read as "within 0 days", i.e.
 * the exact opposite of what it means. One sentence, two shapes, one place.
 */
export function describeSnapshotRetention(
  retention: IWorkspaceSnapshotRetention | null | undefined,
): string {
  if (!retention || typeof retention !== 'object') return 'keep everything';
  const { keepLast, keepWithinDays } = retention;
  if (typeof keepLast !== 'number' || !Number.isFinite(keepLast) || keepLast < 1) {
    return 'keep everything';
  }
  const last = `keep the last ${Math.floor(keepLast)}`;
  if (typeof keepWithinDays !== 'number' || !Number.isFinite(keepWithinDays) || keepWithinDays < 1) {
    return last;
  }
  const days = Math.floor(keepWithinDays);
  return `${last}, within ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** How many parallel checkouts this tier allows a workspace that asked for `value`. */
export function clampMaxConcurrentCheckouts(
  value: unknown,
  policy: WorkspaceTierPolicy,
): number {
  return clampToLimit(value, policy.maxConcurrentCheckouts, 1);
}

/** The subset of a workspace update that a tier has an opinion about. */
export interface WorkspaceTierPatch {
  warmTtlSeconds?: number;
  hotIdleSeconds?: number;
  maxConcurrentCheckouts?: number;
  snapshotRetention?: IWorkspaceSnapshotRetention;
}

/**
 * Clamp an UPDATE to a tier.
 *
 * Unlike `applyTierPolicy` this fills nothing in: a field the patch does not
 * mention comes back absent, because an update that silently rewrote the two
 * fields the user did not touch would reset them to the tier default every time
 * somebody renamed a workspace. Only what was asked for is returned, capped.
 */
export function clampWorkspaceConfigForTier(
  patch: WorkspaceTierPatch | null | undefined,
  tier: TierOrPolicy,
): WorkspaceTierPatch {
  const policy = resolvePolicy(tier);
  const out: WorkspaceTierPatch = {};
  if (!patch) return out;

  if (typeof patch.warmTtlSeconds === 'number' && Number.isFinite(patch.warmTtlSeconds)) {
    out.warmTtlSeconds = clampToLimit(patch.warmTtlSeconds, policy.warmTtlSeconds, 1);
  }
  if (typeof patch.hotIdleSeconds === 'number' && Number.isFinite(patch.hotIdleSeconds)) {
    out.hotIdleSeconds = clampToLimit(patch.hotIdleSeconds, policy.hotIdleSeconds, 0);
  }
  if (
    typeof patch.maxConcurrentCheckouts === 'number' &&
    Number.isFinite(patch.maxConcurrentCheckouts)
  ) {
    out.maxConcurrentCheckouts = clampMaxConcurrentCheckouts(patch.maxConcurrentCheckouts, policy);
  }
  // An update is also how a workspace older than retention acquires one — and,
  // since 2026-09-16, how an existing one is moved to "latest N, no time limit":
  // the patch says `snapshotRetention` and the tier decides how much of it is
  // allowed. Still nothing is filled in for a patch that stays silent.
  if (patch.snapshotRetention && typeof patch.snapshotRetention === 'object') {
    out.snapshotRetention = clampSnapshotRetention(patch.snapshotRetention, policy);
  }
  return out;
}
