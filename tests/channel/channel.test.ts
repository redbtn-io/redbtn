import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bullmqPrefix,
  channelKey,
  isDefaultRedbtnChannel,
  redbtnChannel,
} from '../../src/lib/channel';
import { RunKeys } from '../../src/lib/run/types';
import { jobsHashKey } from '../../src/lib/tools/native/ssh-run-async';
import { redrunBullmqPrefix } from '../../src/lib/workspaces/WorkspaceLifecycle';

const saved: Record<string, string | undefined> = {};
const VARS = ['REDBTN_CHANNEL', 'BULLMQ_PREFIX', 'REDRUN_BULLMQ_PREFIX'];

beforeEach(() => {
  for (const v of VARS) { saved[v] = process.env[v]; delete process.env[v]; }
});
afterEach(() => {
  for (const v of VARS) { if (saved[v] === undefined) delete process.env[v]; else process.env[v] = saved[v]; }
});

describe('release channel keys', () => {
  it('prod (unset) leaves every key name exactly as before', () => {
    expect(redbtnChannel()).toBe('prod');
    expect(isDefaultRedbtnChannel()).toBe(true);
    expect(channelKey('usage:events')).toBe('usage:events');
    expect(channelKey('redlog')).toBe('redlog');
    expect(RunKeys.automationConcurrencyTotal('a1')).toBe('automation:concurrency:{a1}:total');
    expect(RunKeys.automationConcurrencyTrigger('a1', 't1')).toBe('automation:concurrency:{a1}:trigger:t1');
    expect(jobsHashKey('env_x')).toBe('env:env_x:jobs');
    expect(bullmqPrefix()).toBe('bull');
  });

  it('explicit REDBTN_CHANNEL=prod is identical to unset', () => {
    process.env.REDBTN_CHANNEL = ' PROD ';
    expect(channelKey('state:changed')).toBe('state:changed');
    expect(bullmqPrefix()).toBe('bull');
  });

  it('beta prefixes keys and keeps the {hash tag} intact', () => {
    process.env.REDBTN_CHANNEL = 'beta';
    expect(channelKey('usage:events')).toBe('beta:usage:events');
    expect(channelKey('redlog')).toBe('beta:redlog');
    expect(RunKeys.automationConcurrencyTotal('a1')).toBe('beta:automation:concurrency:{a1}:total');
    expect(RunKeys.automationConcurrencyTrigger('a1', 't1')).toBe('beta:automation:concurrency:{a1}:trigger:t1');
    expect(jobsHashKey('env_x')).toBe('beta:env:env_x:jobs');
  });

  it('archive queue prefix: explicit BULLMQ_PREFIX wins, else channel name', () => {
    process.env.REDBTN_CHANNEL = 'beta';
    expect(bullmqPrefix()).toBe('beta');
    process.env.BULLMQ_PREFIX = 'custom';
    expect(bullmqPrefix()).toBe('custom');
  });

  it('workspace lifecycle always targets the shared redRun prefix', () => {
    process.env.REDBTN_CHANNEL = 'beta';
    process.env.BULLMQ_PREFIX = 'beta';
    expect(redrunBullmqPrefix()).toBe('bull');
    process.env.REDRUN_BULLMQ_PREFIX = 'redrun';
    expect(redrunBullmqPrefix()).toBe('redrun');
  });

  it('rejects malformed channel names instead of silently colliding', () => {
    process.env.REDBTN_CHANNEL = 'beta:x';
    expect(() => channelKey('k')).toThrow(/REDBTN_CHANNEL/);
  });
});
