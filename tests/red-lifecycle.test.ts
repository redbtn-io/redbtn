/**
 * Red lifecycle baseline: constructor/setup isolation and load/invocation guard.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Red } from '../src/index';

const {
  startHeartbeatMock,
  stopHeartbeatMock,
  getActiveNodesMock,
  redisCtorMock,
  createOpenAIMock,
  createGeminiMock,
  redLogCreateMock,
  orphanStartupMock,
  orphanStartMock,
  orphanStopMock,
  orphanMarkShutdownInFlightMock,
  orphanReaperCtorMock,
  graphRegistryCtorMock,
  neuronRegistryCtorMock,
  mcpRegistryCtorMock,
} = vi.hoisted(() => {
  const mocks = {
    startHeartbeatMock: vi.fn(),
    stopHeartbeatMock: vi.fn(async () => undefined),
    getActiveNodesMock: vi.fn(async () => []),
    redisCtorMock: vi.fn(function(this: Record<string, unknown>) {
      Object.assign(this, {
        setex: vi.fn(async () => 1),
        set: vi.fn(async () => 1),
        del: vi.fn(async () => 1),
        keys: vi.fn(async () => []),
        on: vi.fn(() => this),
      });
    }),
    createOpenAIMock: vi.fn(() => ({ provider: 'openai' })),
    createGeminiMock: vi.fn(() => ({ provider: 'gemini' })),
    redLogCreateMock: vi.fn(() => ({ publish: vi.fn() })),
    orphanStartupMock: vi.fn(async () => undefined),
    orphanStartMock: vi.fn(),
    orphanStopMock: vi.fn(),
    orphanMarkShutdownInFlightMock: vi.fn(async () => 0),
    orphanReaperCtorMock: null as unknown as any,
    graphRegistryCtorMock: vi.fn(function(this: Record<string, unknown>) {
      Object.assign(this, {
        initialize: vi.fn(async () => undefined),
        getGraph: vi.fn(async () => null),
        getConfig: vi.fn(async () => ({})),
        clearCache: vi.fn(async () => undefined),
        getCacheStats: vi.fn(() => ({ config: { size: 0, max: 0 }, compiled: { size: 0, max: 0 } })),
        getUserGraphs: vi.fn(async () => []),
        subscribeToInvalidations: vi.fn(async () => undefined),
      });
    }),
    neuronRegistryCtorMock: vi.fn(function(this: Record<string, unknown>) {
      Object.assign(this, {
        initialize: vi.fn(async () => undefined),
        getModel: vi.fn(async () => ({ invoke: vi.fn(), stream: vi.fn() } as any)),
        getModelByConfig: vi.fn(async () => ({ invoke: vi.fn(), stream: vi.fn() } as any)),
        getConfig: vi.fn(async () => ({})),
        getNeurons: vi.fn(async () => []),
        upsertNeuron: vi.fn(async () => ({})),
        deleteNeuron: vi.fn(async () => undefined),
        clearCache: vi.fn(async () => undefined),
      });
    }),
    mcpRegistryCtorMock: vi.fn(function(this: Record<string, unknown>) {
      Object.assign(this, {
        registerServer: vi.fn(),
        unregisterServer: vi.fn(),
        hasServer: vi.fn(() => false),
        getServer: vi.fn(() => undefined),
        registerTool: vi.fn(),
        unregisterTool: vi.fn(),
        hasTool: vi.fn(() => false),
        getTool: vi.fn(() => undefined),
        listTools: vi.fn(() => []),
        disconnectAll: vi.fn(async () => undefined),
        disconnectServer: vi.fn(async () => undefined),
      });
    }),
  };

  mocks.orphanReaperCtorMock = vi.fn(function(this: Record<string, unknown>) {
    Object.assign(this, {
      startupReconcile: mocks.orphanStartupMock,
      start: mocks.orphanStartMock,
      stop: mocks.orphanStopMock,
      markShutdownInFlight: mocks.orphanMarkShutdownInFlightMock,
    });
  });

  return mocks;
});

vi.mock('../src/functions/background', () => ({
  startHeartbeat: startHeartbeatMock,
  stopHeartbeat: stopHeartbeatMock,
  getActiveNodes: getActiveNodesMock,
}));
vi.mock('ioredis', () => ({ default: redisCtorMock }));
vi.mock('../src/lib/models', () => ({
  createOpenAIModel: createOpenAIMock,
  createGeminiModel: createGeminiMock,
}));
vi.mock('@redbtn/redlog', () => ({
  RedLog: {
    create: redLogCreateMock,
  },
}));
vi.mock('../src/lib/run/orphan-reaper', () => ({
  OrphanReaper: orphanReaperCtorMock,
}));
vi.mock('../src/lib/graphs/GraphRegistry', () => ({
  GraphRegistry: graphRegistryCtorMock,
}));
vi.mock('../src/lib/neurons/NeuronRegistry', () => ({
  NeuronRegistry: neuronRegistryCtorMock,
}));
vi.mock('../src/lib/mcp/registry', () => ({
  McpRegistry: mcpRegistryCtorMock,
}));

function buildConfig() {
  return {
    redisUrl: 'redis://127.0.0.1:6379/0',
    databaseUrl: 'mongodb://127.0.0.1:27017/red',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Red lifecycle baseline', () => {
  it('throws the documented error when _invoke is called before load()', async () => {
    const red = new Red(buildConfig());

    await expect(
      (red as any)._invoke('cognitionGraph', {}),
    ).rejects.toThrow('Red instance is not loaded. Please call load() before invoking a graph.');
  });

  it('initializes baseState once and does not reinitialize on subsequent load() calls', async () => {
    const red = new Red(buildConfig());

    await red.load('node-primary');

    const firstBaseState = (red as any).baseState;
    const firstRedis = (red as any).redis;
    expect(firstBaseState).toEqual({
      loadedAt: expect.any(Date),
      nodeId: 'node-primary',
    });
    expect(startHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(startHeartbeatMock).toHaveBeenCalledWith('node-primary', firstRedis);
    expect(orphanReaperCtorMock).toHaveBeenCalledTimes(1);
    expect(orphanStartupMock).toHaveBeenCalledTimes(1);
    expect(orphanStartMock).toHaveBeenCalledTimes(1);

    const firstLoadedAt = firstBaseState.loadedAt.getTime();

    await red.load('node-should-not-override');

    const secondBaseState = (red as any).baseState;
    expect(secondBaseState).toBe(firstBaseState);
    expect(secondBaseState.nodeId).toBe('node-primary');
    expect(secondBaseState.loadedAt.getTime()).toBe(firstLoadedAt);
    expect(startHeartbeatMock).toHaveBeenCalledTimes(1);
    expect(orphanReaperCtorMock).toHaveBeenCalledTimes(1);
    expect(orphanStartMock).toHaveBeenCalledTimes(1);
  });
});
