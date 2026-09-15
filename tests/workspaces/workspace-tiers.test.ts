/**
 * Storage tiers: the table lookup, the defaults it fills in, and the caps it
 * clamps to.
 *
 * Pure functions over a constant, so nothing here needs Mongo, Redis or a
 * docker socket — the point of keeping the policy out of the repository.
 */
import { describe, it, expect } from 'vitest';
import {
  WORKSPACE_TIER_POLICIES,
  applyTierPolicy,
  clampMaxConcurrentCheckouts,
  clampWorkspaceConfigForTier,
  workspaceTierName,
  workspaceTierPolicy,
  MAX_HOT_IDLE_SECONDS,
} from '../../src/lib/workspaces';

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

describe('workspaceTierPolicy — table lookup', () => {
  it('maps every accountLevel to its tier', () => {
    expect(workspaceTierName(0)).toBe('admin');
    expect(workspaceTierName(1)).toBe('enterprise');
    expect(workspaceTierName(2)).toBe('pro');
    expect(workspaceTierName(3)).toBe('basic');
    expect(workspaceTierName(4)).toBe('free');
  });

  it('gives admin and the top paid tier the long windows', () => {
    for (const tier of [0, 1]) {
      const policy = workspaceTierPolicy(tier);
      expect(policy.warmTtlSeconds).toEqual({ default: 72 * HOUR, max: 7 * DAY });
      expect(policy.hotIdleSeconds).toEqual({ default: 900, max: 3600 });
      expect(policy.maxConcurrentCheckouts.default).toBe(4);
    }
    expect(workspaceTierPolicy(0).tier).toBe('admin');
    expect(workspaceTierPolicy(1).tier).toBe('enterprise');
  });

  it('gives the middle tiers the platform default warm window and a short hot one', () => {
    for (const tier of [2, 3]) {
      const policy = workspaceTierPolicy(tier);
      expect(policy.warmTtlSeconds).toEqual({ default: 24 * HOUR, max: 72 * HOUR });
      expect(policy.hotIdleSeconds).toEqual({ default: 300, max: 900 });
      expect(policy.maxConcurrentCheckouts.default).toBe(2);
    }
  });

  it('gives the lowest tier a short warm window and no hot runner by default', () => {
    const policy = workspaceTierPolicy(4);
    expect(policy.warmTtlSeconds).toEqual({ default: 6 * HOUR, max: 24 * HOUR });
    expect(policy.hotIdleSeconds).toEqual({ default: 0, max: 300 });
    expect(policy.maxConcurrentCheckouts).toEqual({ default: 1, max: 2 });
  });

  it('resolves an absent, negative, fractional or out-of-range tier to the lowest policy', () => {
    for (const tier of [undefined, null, NaN, -1, 9, 4.7, Number.POSITIVE_INFINITY]) {
      const policy = workspaceTierPolicy(tier as number | null | undefined);
      expect(policy.tier).toBe('free');
      // It reports the tier it APPLIED, not the nonsense it was handed.
      expect(policy.accountTier).toBe(4);
    }
  });

  it('never lets a tier cap exceed the subsystem-wide hot-idle ceiling', () => {
    for (const policy of Object.values(WORKSPACE_TIER_POLICIES)) {
      expect(policy.hotIdleSeconds.max).toBeLessThanOrEqual(MAX_HOT_IDLE_SECONDS);
      expect(policy.hotIdleSeconds.default).toBeLessThanOrEqual(policy.hotIdleSeconds.max);
      expect(policy.warmTtlSeconds.default).toBeLessThanOrEqual(policy.warmTtlSeconds.max);
      expect(policy.maxConcurrentCheckouts.default).toBeLessThanOrEqual(
        policy.maxConcurrentCheckouts.max,
      );
    }
  });
});

describe('applyTierPolicy — defaults filled, explicit values clamped', () => {
  it('fills both windows from the tier when the config asks for nothing', () => {
    const applied = applyTierPolicy({ dockerImage: 'x:1' }, workspaceTierPolicy(0));
    expect(applied.warmTtlSeconds).toBe(72 * HOUR);
    expect(applied.hotIdleSeconds).toBe(900);
    // Everything it has no opinion about survives untouched.
    expect(applied.dockerImage).toBe('x:1');
  });

  it('fills from the lowest tier for an undefined config and an unknown tier', () => {
    const applied = applyTierPolicy(undefined, workspaceTierPolicy(undefined));
    expect(applied.warmTtlSeconds).toBe(6 * HOUR);
    expect(applied.hotIdleSeconds).toBe(0);
  });

  it('keeps an explicit value that is inside the tier cap', () => {
    const applied = applyTierPolicy(
      { warmTtlSeconds: 2 * HOUR, hotIdleSeconds: 120 },
      workspaceTierPolicy(2),
    );
    expect(applied.warmTtlSeconds).toBe(2 * HOUR);
    expect(applied.hotIdleSeconds).toBe(120);
  });

  it('clamps an explicit value above the tier cap down to it, rather than refusing', () => {
    const applied = applyTierPolicy(
      { warmTtlSeconds: 30 * DAY, hotIdleSeconds: 6 * HOUR },
      workspaceTierPolicy(4),
    );
    expect(applied.warmTtlSeconds).toBe(24 * HOUR);
    expect(applied.hotIdleSeconds).toBe(300);
  });

  it('treats zero as "park nothing" for the hot window but never zeroes the warm one', () => {
    const applied = applyTierPolicy(
      { warmTtlSeconds: 0, hotIdleSeconds: 0 },
      workspaceTierPolicy(1),
    );
    expect(applied.hotIdleSeconds).toBe(0);
    expect(applied.warmTtlSeconds).toBe(1);
  });
});

describe('clampMaxConcurrentCheckouts', () => {
  it('defaults per tier and caps what a workspace asks for', () => {
    expect(clampMaxConcurrentCheckouts(undefined, workspaceTierPolicy(0))).toBe(4);
    expect(clampMaxConcurrentCheckouts(undefined, workspaceTierPolicy(4))).toBe(1);
    expect(clampMaxConcurrentCheckouts(32, workspaceTierPolicy(4))).toBe(2);
    expect(clampMaxConcurrentCheckouts(32, workspaceTierPolicy(0))).toBe(8);
    expect(clampMaxConcurrentCheckouts(3, workspaceTierPolicy(0))).toBe(3);
  });
});

describe('clampWorkspaceConfigForTier — updates', () => {
  it('clamps only the fields the update actually mentions', () => {
    const out = clampWorkspaceConfigForTier({ warmTtlSeconds: 30 * DAY }, 2);
    expect(out).toEqual({ warmTtlSeconds: 72 * HOUR });
    expect('hotIdleSeconds' in out).toBe(false);
    expect('maxConcurrentCheckouts' in out).toBe(false);
  });

  it('returns nothing for an empty or absent patch, so a rename changes no limits', () => {
    expect(clampWorkspaceConfigForTier({}, 0)).toEqual({});
    expect(clampWorkspaceConfigForTier(undefined, 0)).toEqual({});
    expect(clampWorkspaceConfigForTier(null, undefined)).toEqual({});
  });

  it('accepts a policy object as well as an account level', () => {
    const byLevel = clampWorkspaceConfigForTier({ hotIdleSeconds: 9999 }, 3);
    const byPolicy = clampWorkspaceConfigForTier({ hotIdleSeconds: 9999 }, workspaceTierPolicy(3));
    expect(byLevel).toEqual({ hotIdleSeconds: 900 });
    expect(byPolicy).toEqual(byLevel);
  });

  it('ignores non-numeric values instead of writing garbage into the config', () => {
    const out = clampWorkspaceConfigForTier(
      { warmTtlSeconds: NaN, hotIdleSeconds: undefined, maxConcurrentCheckouts: 5 } as any,
      1,
    );
    expect(out).toEqual({ maxConcurrentCheckouts: 5 });
  });
});
