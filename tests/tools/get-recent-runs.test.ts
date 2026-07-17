/**
 * Vitest for native tool: get_recent_runs
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NativeToolContext } from '../../src/lib/tools/native-registry';
import getRecentRunsTool from '../../src/lib/tools/native/get-recent-runs';

interface CollectionFixture {
  resource: Record<string, unknown> | null;
  runEvents: Record<string, unknown>[];
}

const mockState: CollectionFixture = {
  resource: null,
  runEvents: [],
};

const mocks = vi.hoisted(() => ({
  graphsCollection: vi.fn(),
  runEventsCollection: vi.fn(),
}));

vi.mock('mongoose', () => {
  const fake = {
    connection: {
      db: {
        collection(name: string) {
          if (name === 'graphs') return mocks.graphsCollection();
          if (name === 'runEvents') return mocks.runEventsCollection();
          return {
            findOne: vi.fn(async () => null),
            find: vi.fn(() => ({
              sort: vi.fn(() => ({
                limit: vi.fn(() => ({
                  toArray: vi.fn(async () => []),
                })),
              })),
            })),
          };
        },
      },
    },
    mongo: { GridFSBucket: class {} },
  };
  return { default: fake, ...fake };
});

function buildCollections() {
  const findOne = vi.fn(async (_query: Record<string, unknown>) => mockState.resource);
  const runEventsFind = vi.fn(() => ({
    sort: vi.fn(() => ({
      limit: vi.fn(() => ({
        toArray: vi.fn(async () => mockState.runEvents),
      })),
    })),
  }));

  mocks.graphsCollection.mockReturnValue({ findOne });
  mocks.runEventsCollection.mockReturnValue({ find: runEventsFind });
}

function setFixtures(opts: Partial<CollectionFixture>) {
  mockState.resource = opts.resource ?? mockState.resource;
  mockState.runEvents = opts.runEvents ?? mockState.runEvents;
  buildCollections();
}

function makeMockContext(overrides?: Partial<NativeToolContext>): NativeToolContext {
  return {
    publisher: null,
    state: {},
    runId: 'test-run-' + Date.now(),
    nodeId: 'test-node',
    toolId: 'test-tool-' + Date.now(),
    abortSignal: null,
    ...overrides,
  };
}

describe('get_recent_runs — user identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setFixtures({
      resource: {
        graphId: 'graph-secure',
        userId: 'graph-owner',
        participants: [],
      },
      runEvents: [
        {
          runId: 'run-owner-1',
          status: 'completed',
          startedAt: '2026-07-17T00:00:00.000Z',
          completedAt: '2026-07-17T00:01:00.000Z',
          conversationId: null,
          automationId: null,
          trigger: 'invoke',
          events: [],
        },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('prefers trusted publisher identity over state.userId', async () => {
    const r = await getRecentRunsTool.handler(
      { graphId: 'graph-secure' },
      makeMockContext({
        publisher: { user: 'attacker' } as NativeToolContext['publisher'],
        state: { userId: 'graph-owner' },
      }),
    );

    expect(r.isError).toBe(true);
    const body = JSON.parse(r.content[0].text);
    expect(body.error).toMatch(/Forbidden/);
  });

  test('falls back to state.userId when publisher identity is unavailable', async () => {
    const r = await getRecentRunsTool.handler(
      { graphId: 'graph-secure' },
      makeMockContext({
        state: { userId: 'graph-owner' },
      }),
    );

    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.content[0].text);
    expect(body.graphId).toBe('graph-secure');
    expect(body.count).toBe(1);
    expect(body.runs[0].runId).toBe('run-owner-1');
  });
});
