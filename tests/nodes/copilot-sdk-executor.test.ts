import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCopilotSdkRuntimeEnv,
  makeCopilotPermissionHandler,
  classifyCopilotSdkFailure,
  runCopilotSdkStep,
  type CopilotSdkDependencies,
} from '../../src/lib/nodes/universal/executors/copilotSdkExecutor';
import { classifyFallbackTrigger } from '../../src/lib/nodes/universal/executors/neuronFallback';

const originalEnv = { ...process.env };
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeHarness(options: { hang?: boolean; usageCount?: number; deltas?: string[]; finalText?: string } = {}) {
  const handlers = new Map<string, (event: any) => void>();
  const session = {
    sessionId: 'fixture-session',
    on: vi.fn((event: string, handler: (event: any) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    }),
    sendAndWait: vi.fn(async () => {
      if (options.hang) return new Promise<never>(() => undefined);
      const content = options.finalText ?? 'fixture answer';
      for (const deltaContent of options.deltas ?? ['fixture ', 'answer']) {
        handlers.get('assistant.message_delta')?.({ agentId: undefined, data: { deltaContent } });
      }
      handlers.get('assistant.message')?.({ agentId: undefined, data: { content } });
      for (let index = 0; index < (options.usageCount ?? 1); index += 1) {
        handlers.get('assistant.usage')?.({
          agentId: undefined,
          data: { model: 'gpt-5', inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
        });
      }
      return { data: { content, model: 'gpt-5' } };
    }),
    abort: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
  };
  const client = {
    start: vi.fn(async () => undefined),
    createSession: vi.fn(async () => session),
    stop: vi.fn(async () => []),
    forceStop: vi.fn(async () => undefined),
  };
  const lease = { startRenewal: vi.fn(), release: vi.fn(async () => undefined) };
  const bridge = {
    mcpConfig: {
      mcpServers: {
        redbtn: {
          type: 'stdio', command: process.execPath, args: ['/private/run-bridge.js'],
          env: { REDBTN_BRIDGE_SOCK: '/private/bridge.sock', REDBTN_BRIDGE_NONCE: 'fixture-nonce' },
        },
      },
    },
    toolNames: ['workspace_read'],
    close: vi.fn(async () => undefined),
  };
  const captured: { clientOptions?: any; sessionConfig?: any; bridgeOptions?: any } = {};
  const dependencies: CopilotSdkDependencies = {
    createClient: vi.fn((clientOptions) => {
      captured.clientOptions = clientOptions;
      return client as never;
    }) as never,
    acquireLease: vi.fn(async () => lease) as never,
    startBridge: vi.fn(async (bridgeOptions) => {
      captured.bridgeOptions = bridgeOptions;
      return bridge as never;
    }) as never,
  };
  client.createSession.mockImplementation(async (sessionConfig: any) => {
    captured.sessionConfig = sessionConfig;
    return session as never;
  });
  return { client, session, lease, bridge, handlers, captured, dependencies };
}

function runRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-run-root-'));
  temporaryRoots.push(root);
  process.env.REDBTN_RUN_DIR_ROOT = root;
  return root;
}

function stepHarness(args: {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  structuredOutput?: unknown;
  secretName?: string;
  hang?: boolean;
} = {}) {
  const root = runRoot();
  const harness = makeHarness({ hang: args.hang });
  const usage = vi.fn();
  const chunks: string[] = [];
  const state = {
    runId: 'copilot-sdk-test-run',
    data: {},
    runPublisher: {
      chunk: vi.fn(async (text: string) => { chunks.push(text); }),
      replaceOutputContent: vi.fn(async () => undefined),
      nodeProgress: vi.fn(async () => undefined),
    },
  };
  const promise = runCopilotSdkStep({
    config: {
      outputField: 'data.answer',
      userPrompt: 'hello',
      systemPrompt: 'Be concise',
      stream: true,
      tools: [],
      timeoutMs: args.timeoutMs ?? 5_000,
      ...(args.structuredOutput ? { structuredOutput: args.structuredOutput } : {}),
    } as never,
    state,
    neuronCfg: {
      provider: 'copilot-sdk', model: 'gpt-5', apiKey: 'placeholder-test-token',
      secretName: args.secretName ?? 'COPILOT_GITHUB_TOKEN',
    },
    neuronId: 'copilot-test', userId: 'unit-test', callRunId: state.runId,
    abortSignal: args.abortSignal,
    emitUsage: usage,
    dependencies: harness.dependencies,
  });
  return { root, harness, usage, chunks, state, promise };
}

describe('Copilot SDK isolation and authorization', () => {
  it('uses a strict runtime environment and never inherits GH, Copilot, or direct API token variables', () => {
    const env = buildCopilotSdkRuntimeEnv({
      home: '/private/home', dir: '/private/run',
      parentEnv: {
        PATH: '/safe/bin', LANG: 'C', COPILOT_GITHUB_TOKEN: 'parent-copilot',
        GH_TOKEN: 'parent-gh', GITHUB_TOKEN: 'parent-github',
        OPENAI_API_KEY: 'openai', ANTHROPIC_API_KEY: 'anthropic', GOOGLE_API_KEY: 'google',
        REDIS_URL: 'redis', HOME: '/host/home',
      },
    });
    expect(env).toMatchObject({ PATH: '/safe/bin', HOME: '/private/home', TMPDIR: '/private/run' });
    for (const key of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'REDIS_URL']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('runs the SDK in empty mode with only named run-bridge tools and explicit per-session auth', async () => {
    const run = stepHarness();
    const result = await run.promise;
    expect(result['data.answer']).toBe('fixture answer');
    expect(run.chunks.join('')).toBe('fixture answer');
    expect(run.harness.captured.clientOptions.mode).toBe('empty');
    expect(run.harness.captured.clientOptions.useLoggedInUser).toBe(false);
    expect(run.harness.captured.clientOptions.baseDirectory).toContain('/home');
    expect(run.harness.captured.sessionConfig.gitHubToken).toBe('placeholder-test-token');
    expect(run.harness.captured.sessionConfig.mcpServers).toHaveProperty('redbtn');
    expect(Object.keys(run.harness.captured.sessionConfig.mcpServers)).toEqual(['redbtn']);
    expect(run.harness.captured.sessionConfig.mcpServers.redbtn.tools).toEqual(['workspace_read']);
    expect(run.harness.captured.sessionConfig.availableTools.toArray()).toEqual(['mcp:redbtn-workspace_read']);
    expect(run.harness.captured.sessionConfig.excludedTools.toArray()).toContain('builtin:*');
    expect(run.harness.captured.sessionConfig.excludedTools.toArray()).toContain('custom:*');
    expect(run.harness.captured.sessionConfig.skipCustomInstructions).toBe(true);
    expect(run.harness.captured.sessionConfig.enableConfigDiscovery).toBe(false);
    expect(run.harness.captured.sessionConfig.skillDirectories).toEqual([]);
    expect(run.harness.captured.sessionConfig.instructionDirectories).toEqual([]);
    expect(run.harness.captured.sessionConfig.memory).toEqual({ enabled: false });
    expect(run.harness.captured.sessionConfig.mcpOAuthTokenStorage).toBe('in-memory');
    expect(run.harness.captured.sessionConfig.enableSessionStore).toBe(false);
    expect(run.harness.captured.sessionConfig.infiniteSessions).toEqual({ enabled: false });
    expect(run.harness.captured.clientOptions.env).not.toHaveProperty('GH_TOKEN');
    expect(run.harness.captured.clientOptions.env).not.toHaveProperty('GITHUB_TOKEN');
    expect(run.harness.captured.clientOptions.env).not.toHaveProperty('COPILOT_GITHUB_TOKEN');
    expect(run.harness.session.disconnect).toHaveBeenCalledOnce();
    expect(run.harness.client.stop).toHaveBeenCalledOnce();
    expect(run.harness.bridge.close).toHaveBeenCalledOnce();
    expect(run.harness.lease.release).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(run.root, 'copilot-sdk-test-run'))).toBe(false);
  });

  it('approves only the exact named Redbtn bridge MCP tools and rejects every other tool class', () => {
    const denied = vi.fn();
    const permission = makeCopilotPermissionHandler(new Set(['workspace_read']), denied);
    expect(permission({ kind: 'mcp', serverName: 'redbtn', toolName: 'workspace_read' } as never, { sessionId: 's' })).toEqual({ kind: 'approve-once' });
    expect(permission({ kind: 'shell', commands: [] } as never, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
    expect(permission({ kind: 'mcp', serverName: 'other', toolName: 'workspace_read' } as never, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
    expect(permission({ kind: 'mcp', serverName: 'redbtn', toolName: 'workspace_delete' } as never, { sessionId: 's' })).toMatchObject({ kind: 'reject' });
    expect(denied).toHaveBeenCalledTimes(3);
  });

  it('requires the exact RedSecrets secret name and never starts an SDK session on a mismatch', async () => {
    const run = stepHarness({ secretName: 'some-other-secret' });
    await expect(run.promise).rejects.toMatchObject({ code: 'copilot_sdk_bad_secret_name' });
    expect(run.harness.client.start).not.toHaveBeenCalled();
    expect(run.harness.dependencies.acquireLease).not.toHaveBeenCalled();
  });

  it('fails closed if a bridge provider attempts to include an ambient second MCP server', async () => {
    const run = stepHarness();
    (run.harness.bridge.mcpConfig.mcpServers as Record<string, unknown>).other = { type: 'http', url: 'https://invalid.example' };
    await expect(run.promise).rejects.toMatchObject({ code: 'copilot_sdk_bridge_invalid' });
    expect(run.harness.client.start).not.toHaveBeenCalled();
    expect(run.harness.bridge.close).toHaveBeenCalledOnce();
    expect(run.harness.lease.release).toHaveBeenCalledOnce();
  });

  it('rejects structured output before acquiring a lease or creating an SDK client', async () => {
    const run = stepHarness({ structuredOutput: { schema: { type: 'object' } } });
    await expect(run.promise).rejects.toMatchObject({ code: 'copilot_sdk_structured_output_unsupported' });
    expect(run.harness.dependencies.acquireLease).not.toHaveBeenCalled();
    expect(run.harness.dependencies.createClient).not.toHaveBeenCalled();
  });

  it('rejects multimodal flags, image attachments, audio data, and non-text parts before lease acquisition', async () => {
    const cases = [
      {
        config: { imageInput: true },
        state: { data: {} },
      },
      {
        config: {},
        state: { data: { input: { attachments: [{ kind: 'image', mimeType: 'image/png' }] } } },
      },
      {
        config: {},
        state: { data: { input: { audioData: 'fixture-audio-data' } } },
      },
      {
        config: { userPrompt: '{{state.data.messages}}' },
        state: { data: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'fixture://image' } }] }] } },
      },
    ];
    for (const input of cases) {
      const harness = makeHarness();
      const config = { ...input.config, outputField: 'data.answer', tools: [], timeoutMs: 1000 };
      const promise = runCopilotSdkStep({
        config: config as never,
        state: { runId: 'modality-test', data: input.state.data },
        neuronCfg: { model: 'gpt-5', apiKey: 'placeholder-token', secretName: 'COPILOT_GITHUB_TOKEN' },
        neuronId: 'copilot-test', callRunId: 'modality-test', emitUsage: vi.fn(),
        dependencies: harness.dependencies,
      });
      await expect(promise).rejects.toMatchObject({ code: 'copilot_sdk_unsupported_input_modality' });
      expect(harness.dependencies.acquireLease).not.toHaveBeenCalled();
    }
  });
});

describe('Copilot SDK typed events, usage, and lifecycle', () => {
  it('classifies only explicit operational SDK failures for possible fallback', () => {
    const cases: Array<[unknown, string]> = [
      [{ status: 429, message: 'quota exhausted' }, 'copilot_sdk_rate_limited'],
      [{ status: 503, message: 'service unavailable' }, 'copilot_sdk_http_5xx'],
      [{ code: 'ECONNRESET', message: 'network reset' }, 'copilot_sdk_network'],
      [new Error('Copilot runtime not found'), 'copilot_sdk_runtime_unavailable'],
      [new Error('request timed out'), 'copilot_sdk_timeout'],
      [new Error('service overloaded'), 'copilot_sdk_capacity'],
    ];
    for (const [error, code] of cases) {
      expect(classifyCopilotSdkFailure(error).code).toBe(code);
    }
    expect(classifyCopilotSdkFailure({ status: 400, message: 'bad request' }).code).toBe('copilot_sdk_http_4xx');
    expect(classifyCopilotSdkFailure({ status: 401, message: 'invalid token' }).code).toBe('copilot_sdk_auth_failed');
    expect(classifyCopilotSdkFailure(new Error('opaque failure')).code).toBe('copilot_sdk_failed');
    for (const [message, code] of [
      ['HTTP 403 rate limit exceeded', 'copilot_sdk_auth_failed'],
      ['HTTP 401 unauthorized rate limit', 'copilot_sdk_auth_failed'],
      ['HTTP 400 quota exceeded', 'copilot_sdk_http_4xx'],
    ] as const) {
      const classified = classifyCopilotSdkFailure(new Error(message));
      expect(classified.code).toBe(code);
      expect(classifyFallbackTrigger(classified)).toBeNull();
    }
  });

  it('maps typed usage events into bounded Redbtn usage metadata', async () => {
    const run = stepHarness();
    await run.promise;
    expect(run.usage).toHaveBeenCalledOnce();
    expect(run.usage.mock.calls[0][0]).toEqual({
      usage_metadata: {
        input_tokens: 10, output_tokens: 4, total_tokens: 14,
        uncached_input_tokens: 7,
        input_token_details: { cache_creation: 1, cache_read: 2 },
      },
    });
    expect(run.usage.mock.calls[0][1]).toBe('copilot-sdk/gpt-5');
    expect((run.state.data as { _cli: Record<string, { provider: string }> })._cli['data.answer'].provider).toBe('copilot-sdk');
  });

  it('never publishes a token split across multiple assistant delta events', async () => {
    const token = 'placeholder-test-token';
    const visibleText = `before ${token} after`;
    const harness = makeHarness({
      finalText: visibleText,
      deltas: ['before place', 'holder-', 'test-', 'token after'],
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-sdk-redaction-'));
    temporaryRoots.push(root);
    process.env.REDBTN_RUN_DIR_ROOT = root;
    const chunks: string[] = [];
    const replacements: string[] = [];
    const state = {
      runId: 'copilot-sdk-redaction',
      data: {},
      runPublisher: {
        chunk: vi.fn(async (chunk: string) => { chunks.push(chunk); }),
        replaceOutputContent: vi.fn(async (content: string) => { replacements.push(content); }),
      },
    };
    const result = await runCopilotSdkStep({
      config: { outputField: 'data.answer', userPrompt: 'hello', stream: true, tools: [], timeoutMs: 5_000 } as never,
      state,
      neuronCfg: { provider: 'copilot-sdk', model: 'gpt-5', apiKey: token, secretName: 'COPILOT_GITHUB_TOKEN' },
      neuronId: 'copilot-test', callRunId: state.runId, emitUsage: vi.fn(),
      dependencies: harness.dependencies,
    });
    expect(chunks.join('')).not.toContain(token);
    expect(replacements.join('')).not.toContain(token);
    expect(result['data.answer']).not.toContain(token);
    expect(result['data.answer']).toContain('[REDACTED:COPILOT_GITHUB_TOKEN]');
  });

  it('bounds captured usage events while retaining exact aggregate accounting', async () => {
    const harness = makeHarness({ usageCount: 300 });
    const root = runRoot();
    const usage = vi.fn();
    const result = await runCopilotSdkStep({
      config: { outputField: 'data.answer', userPrompt: 'hello', stream: false, tools: [], timeoutMs: 5_000 } as never,
      state: { runId: 'copilot-sdk-bounded-usage', data: {} },
      neuronCfg: { provider: 'copilot-sdk', model: 'gpt-5', apiKey: 'placeholder-test-token', secretName: 'COPILOT_GITHUB_TOKEN' },
      neuronId: 'copilot-test', callRunId: 'copilot-sdk-bounded-usage', emitUsage: usage,
      dependencies: harness.dependencies,
    });
    expect(result['data.answer']).toBe('fixture answer');
    expect(usage).toHaveBeenCalledOnce();
    const metadata = usage.mock.calls[0][0] as { usage_metadata: { input_tokens: number; output_tokens: number } };
    expect(metadata.usage_metadata.input_tokens).toBe(10 * 256);
    expect(metadata.usage_metadata.output_tokens).toBe(4 * 256);
    const cli = (result['data._cli'] as Record<string, any>)['data.answer'];
    expect(cli.usage[0].calls).toBe(256);
    expect(cli.usageEventsDropped).toBe(44);
    expect(fs.existsSync(path.join(root, 'copilot-sdk-bounded-usage'))).toBe(false);
  });

  it('aborts and force-stops the runtime on cancellation, then releases the bridge, private state, and lease', async () => {
    const controller = new AbortController();
    const run = stepHarness({ hang: true, abortSignal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(run.promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(run.harness.session.abort).toHaveBeenCalledOnce();
    expect(run.harness.client.forceStop).toHaveBeenCalledOnce();
    expect(run.harness.bridge.close).toHaveBeenCalledOnce();
    expect(run.harness.lease.release).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(run.root, 'copilot-sdk-test-run'))).toBe(false);
  });

  it('enforces the turn timeout and force-stops the SDK runtime', async () => {
    const run = stepHarness({ hang: true, timeoutMs: 100 });
    await expect(run.promise).rejects.toMatchObject({ code: 'copilot_sdk_timeout' });
    expect(run.harness.session.abort).toHaveBeenCalledOnce();
    expect(run.harness.client.forceStop).toHaveBeenCalledOnce();
    expect(run.harness.lease.release).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(run.root, 'copilot-sdk-test-run'))).toBe(false);
  });
});
