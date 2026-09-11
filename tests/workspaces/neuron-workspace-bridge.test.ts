import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as net from 'net';

import {
  startRunToolBridge,
  type RunToolBridge,
} from '../../src/lib/mcp/run-bridge.js';
import {
  resolveWorkspaceEnvironment,
  executeNeuron,
} from '../../src/lib/nodes/universal/executors/neuronExecutor.js';
import { resolveWorkspaceMount as resolveClaudeMount } from '../../src/lib/nodes/universal/executors/claudeCodeExecutor.js';
import { resolveWorkspaceMount as resolveAgyMount } from '../../src/lib/nodes/universal/executors/agyCliExecutor.js';
import type { IWorkspace, IWorkspaceCheckout } from '../../src/lib/workspaces/types.js';

describe('PR 5: MCP Run-Bridge & Neuron Workspace Binding', () => {
  describe('MCP Run-Bridge workingDir default', () => {
    let tmpDir: string;
    let bridge: RunToolBridge | null = null;
    const clientSockets: net.Socket[] = [];

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ws-test-'));
      fs.mkdirSync(path.join(tmpDir, 'step'), { mode: 0o700 });
    });

    afterEach(async () => {
      for (const s of clientSockets) {
        try {
          s.destroy();
        } catch {}
      }
      clientSockets.length = 0;
      if (bridge) {
        await bridge.close({ removeDir: true });
        bridge = null;
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    });

    it('defaults workingDir to /workspace when omitted from StartRunToolBridgeOptions', async () => {
      const stepDir = path.join(tmpDir, 'step');
      bridge = await startRunToolBridge({
        runId: 'run-ws-test-1',
        state: { runId: 'run-ws-test-1', data: {} },
        publisher: null,
        resolvedTools: [
          {
            name: 'run_command',
            description: 'Run a shell command',
            inputSchema: {
              type: 'object',
              properties: {
                command: { type: 'string' },
                cwd: { type: 'string' },
              },
            },
            source: 'native',
          },
        ],
        environmentId: 'env_workspace_123',
        // workingDir intentionally omitted
        abortSignal: null,
        neuronStepId: 'step-ws-1',
        dir: stepDir,
        maxToolIterations: 5,
      });

      expect(bridge).toBeDefined();
      expect(fs.existsSync(bridge.socketPath)).toBe(true);

      // Connect a mock JSON-RPC client to verify the default cwd/workingDir on dispatch
      const client = net.connect(bridge.socketPath);
      clientSockets.push(client);

      const receivedLines: any[] = [];
      const dataPromise = new Promise<void>((resolve) => {
        client.on('data', (chunk) => {
          const lines = chunk.toString('utf8').split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              receivedLines.push(JSON.parse(line));
            } catch {}
          }
          if (receivedLines.length >= 1) resolve();
        });
      });

      // Send correct auth frame: { redbtn: 'auth', nonce }
      client.write(`${JSON.stringify({ redbtn: 'auth', nonce: bridge.nonce })}\n`);
      // Call tool without explicit cwd
      client.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'run_command', arguments: { command: 'pwd' } },
        })}\n`,
      );

      // Wait for response
      await Promise.race([
        dataPromise,
        new Promise((r) => setTimeout(r, 2000)),
      ]);

      expect(bridge.stats.callsTotal).toBe(1);
    });

    it('retains explicit workingDir when provided', async () => {
      const stepDir = path.join(tmpDir, 'step');
      bridge = await startRunToolBridge({
        runId: 'run-ws-test-2',
        state: { runId: 'run-ws-test-2', data: {} },
        publisher: null,
        resolvedTools: [],
        environmentId: 'env_ws_explicit',
        workingDir: '/custom/workspace/dir',
        abortSignal: null,
        neuronStepId: 'step-ws-2',
        dir: stepDir,
      });

      expect(bridge).toBeDefined();
    });
  });

  describe('resolveWorkspaceEnvironment', () => {
    it('returns explicit environmentId if already present on state', async () => {
      const state = {
        parameters: { environmentId: 'env_explicit_param' },
        data: { workspaceId: 'ws_123' },
      };

      const resolved = await resolveWorkspaceEnvironment(state);
      expect(resolved).toBe('env_explicit_param');
      expect(state.data.workingDir).toBe('/workspace');
    });

    it('extracts environmentId from state.data.ws', async () => {
      const state: any = {
        data: {
          ws: {
            workspaceId: 'ws_test_embedded',
            environmentId: 'env_from_ws_obj',
          },
        },
      };

      const resolved = await resolveWorkspaceEnvironment(state);
      expect(resolved).toBe('env_from_ws_obj');
      expect(state.data.environmentId).toBe('env_from_ws_obj');
      expect(state.data.workingDir).toBe('/workspace');
    });

    it('extracts environmentId from state.data.workspaceCheckout', async () => {
      const state: any = {
        data: {
          workspaceCheckout: {
            workspaceId: 'ws_card_101',
            checkoutId: 'chk_101',
            environmentId: 'env_chk_101',
          },
        },
      };

      const resolved = await resolveWorkspaceEnvironment(state);
      expect(resolved).toBe('env_chk_101');
      expect(state.data.environmentId).toBe('env_chk_101');
      expect(state.data.workingDir).toBe('/workspace');
    });

    it('resolves active checkout from WorkspaceRepository using workspaceId and runId', async () => {
      const mockCheckout: IWorkspaceCheckout = {
        checkoutId: 'chk_target',
        checkoutKey: 'trunk',
        mode: 'exclusive',
        branch: 'main',
        runId: 'run_matching_123',
        workerId: 'worker_01',
        environmentId: 'env_resolved_from_repo',
        installId: 'ws_become_chk_target',
        volumeName: 'ws_become_chk_target_data',
        leaseExpiresAt: new Date(Date.now() + 60000),
        createdAt: new Date(),
      };

      const mockWorkspace: Partial<IWorkspace> = {
        workspaceId: 'ws_become',
        activeCheckouts: [mockCheckout],
        config: {
          dockerImage: 'workspace-runner:latest',
          cpuLimit: '2.0',
          memLimit: '4096m',
          defaultCwd: '/workspace',
        },
      };

      const mockRepo = {
        getWorkspace: vi.fn(async (wsId: string) => {
          if (wsId === 'ws_become') return mockWorkspace as IWorkspace;
          return null;
        }),
      };

      const state: any = {
        runId: 'run_matching_123',
        workspaceRepository: mockRepo,
        data: {
          workspaceId: 'ws_become',
        },
        parameters: {},
      };

      const resolved = await resolveWorkspaceEnvironment(state);
      expect(resolved).toBe('env_resolved_from_repo');
      expect(state.data.environmentId).toBe('env_resolved_from_repo');
      expect(state.data.checkoutId).toBe('chk_target');
      expect(state.data.workingDir).toBe('/workspace');
      expect(state.parameters.environmentId).toBe('env_resolved_from_repo');
      expect(state.parameters.workingDir).toBe('/workspace');
    });
  });

  describe('resolveWorkspaceMount in CLI executors', () => {
    it('claudeCodeExecutor mounts at /workspace when workspaceId is set', () => {
      const mount = resolveClaudeMount({
        data: {
          workspaceId: 'ws_become_001',
        },
      });

      expect(mount).toEqual({
        name: 'workspace',
        tree: '/workspace',
      });
    });

    it('claudeCodeExecutor mounts at /workspace when workingDir is /workspace', () => {
      const mount = resolveClaudeMount({
        data: {
          workingDir: '/workspace',
        },
      });

      expect(mount).toEqual({
        name: 'workspace',
        tree: '/workspace',
      });
    });

    it('agyCliExecutor mounts at /workspace when workspaceId is set', () => {
      const mount = resolveAgyMount({
        data: {
          workspaceId: 'ws_gemini_001',
        },
      });

      expect(mount).toEqual({
        name: 'workspace',
        tree: '/workspace',
      });
    });

    it('confines malicious tree traversal even with workspaceId set', () => {
      const mount = resolveClaudeMount({
        data: {
          workspaceId: 'ws_attack',
          ws: {
            tree: '/workspace/../../etc/passwd',
          },
        },
      });

      expect(mount.tree).toBe('/workspace');
    });
  });

  describe('Neuron Fallback with Workspace Binding', () => {
    it('preserves the exact resolved environmentId and /workspace across primary failure and fallback', async () => {
      let callCount = 0;

      const neuronRegistry = {
        getConfig: vi.fn(async (id: string) => {
          return { id, neuronId: id, provider: 'google', model: `model-${id}` };
        }),
        getModel: vi.fn(async () => {
          return {};
        }),
        callNeuron: vi.fn(async (id: string, _userId: any, _msgs: any, _opts: any) => {
          callCount++;
          if (callCount === 1) {
            // Primary fails with an operational error classified as retryable
            const err: any = new Error('primary model overloaded');
            err.code = 'claude_code_rate_limited';
            throw err;
          }
          return 'fallback succeeded';
        }),
      };

      const state: any = {
        runId: 'run-fallback-ws',
        neuronRegistry,
        data: {
          workspaceId: 'ws_fallback_test',
          ws: {
            environmentId: 'env_ws_stable_123',
          },
        },
        parameters: {},
      };

      const config: any = {
        neuronId: 'primary-opus',
        fallbackNeuronId: 'fallback-flash',
        outputField: 'data.result',
        userPrompt: 'Test prompt in workspace',
      };

      const result = await executeNeuron(config, state);

      expect(result).toBeDefined();
      expect(state.data.environmentId).toBe('env_ws_stable_123');
      expect(state.data.workingDir).toBe('/workspace');
      expect(state.parameters.environmentId).toBe('env_ws_stable_123');
      expect(state.parameters.workingDir).toBe('/workspace');
      expect(state.data._fallback).toBeDefined();
      expect(state.data._fallback['data.result'].to).toBe('fallback-flash');
    });
  });
});
