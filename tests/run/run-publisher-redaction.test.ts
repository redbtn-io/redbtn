import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunPublisher } from '../../src/lib/run/run-publisher';
import { RunKeys } from '../../src/lib/run/types';

function makeRedis() {
  const values = new Map<string, string>();
  const redis: any = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      values.set(key, value);
      return 'OK';
    }),
    pipeline: vi.fn(() => {
      const pipeline: any = {
        rpush: vi.fn(() => pipeline),
        expire: vi.fn(() => pipeline),
        publish: vi.fn(() => pipeline),
        exec: vi.fn(async () => []),
      };
      return pipeline;
    }),
  };
  return { redis, values };
}

describe('RunPublisher persisted-input redaction', () => {
  beforeEach(() => {
    process.env.ARCHIVE_QUEUE_DISABLED = 'true';
  });

  afterEach(() => {
    delete process.env.ARCHIVE_QUEUE_DISABLED;
    vi.restoreAllMocks();
  });

  it('never persists trigger credentials in the run-start log or run state', async () => {
    const { redis, values } = makeRedis();
    const logs: Array<Record<string, unknown>> = [];
    const redlog = {
      log: vi.fn(async (entry: Record<string, unknown>) => {
        logs.push(entry);
      }),
    };
    const input = {
      requestId: 'request-safe-for-debugging',
      _secrets: {
        SSH_KEY: 'test-private-key-marker',
        REDRUN_API_KEY: 'test-api-key-marker',
      },
      // Secret enrichment can duplicate a value under a harmless-looking key.
      sshKey: 'test-private-key-marker',
      atlasToken: 'test-atlas-token-marker',
      nested: {
        api_key: 'test-nested-api-key-marker',
        password: 'test-password-marker',
        safeFlag: true,
      },
    };
    const publisher = new RunPublisher({
      redis,
      runId: 'run-redaction',
      userId: 'user-1',
      log: redlog as any,
    });

    await publisher.init('graph-1', 'Sensitive Graph', input);

    const persistedState = values.get(RunKeys.state('run-redaction'))!;
    const persistedLog = JSON.stringify(logs);
    const secretMarkers = [
      'test-private-key-marker',
      'test-api-key-marker',
      'test-atlas-token-marker',
      'test-nested-api-key-marker',
      'test-password-marker',
    ];
    for (const marker of secretMarkers) {
      expect(persistedState).not.toContain(marker);
      expect(persistedLog).not.toContain(marker);
    }

    const state = JSON.parse(persistedState);
    expect(state.input).toMatchObject({
      requestId: 'request-safe-for-debugging',
      _secrets: '[REDACTED]',
      sshKey: '[REDACTED]',
      atlasToken: '[REDACTED]',
      nested: {
        api_key: '[REDACTED]',
        password: '[REDACTED]',
        safeFlag: true,
      },
    });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      message: 'Run started: Sensitive Graph',
      metadata: {
        hadSensitiveInput: true,
        input: state.input,
      },
    });

    // The original object is still available to the execution path; redaction
    // is limited to diagnostic persistence and does not mutate caller input.
    expect(input._secrets.SSH_KEY).toBe('test-private-key-marker');
    expect(input.sshKey).toBe('test-private-key-marker');
  });

  it('redacts recognizable credential values from later tool log metadata', async () => {
    const { redis } = makeRedis();
    const logs: Array<Record<string, unknown>> = [];
    const credentialMarker = ['rpat', 'synthetic', 'tool', 'credential', '12345678'].join('_');
    const publisher = new RunPublisher({
      redis,
      runId: 'run-tool-redaction',
      userId: 'user-1',
      log: { log: vi.fn(async (entry: Record<string, unknown>) => logs.push(entry)) } as any,
    });

    await publisher.init('graph-1', 'Graph', {});
    await publisher.toolStart('tool-1', 'ssh_shell', 'native', {
      input: { command: `export REDBTN_MCP_PAT=${credentialMarker}` },
    });

    const persistedToolLog = JSON.stringify(logs.find((entry) => entry.message === 'Tool started: ssh_shell'));
    expect(persistedToolLog).not.toContain(credentialMarker);
    expect(persistedToolLog).toContain('[REDACTED]');
  });
});
