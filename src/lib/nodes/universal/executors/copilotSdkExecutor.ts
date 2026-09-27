/**
 * GitHub Copilot SDK subscription-backed neuron.
 *
 * Each turn owns a `@github/copilot-sdk` client in `mode: "empty"`, a private
 * COPILOT_HOME/base directory, a private working directory, and one per-run
 * Redbtn MCP bridge. The SDK gets the resolved RedSecrets credential as the
 * session's explicit `gitHubToken`; its runtime environment is an allowlist
 * and never inherits GH_TOKEN, GITHUB_TOKEN, or direct model API keys.
 */
import {
  CopilotClient,
  ToolSet,
  type CopilotClientOptions,
  type CopilotSession,
  type MCPStdioServerConfig,
  type PermissionRequest,
  type SessionConfig,
} from '@github/copilot-sdk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { NeuronStepConfig } from '../types';
import { renderTemplate, getNestedProperty } from '../templateRenderer';
import {
  startRunToolBridge,
  isForbiddenForBridge,
  BRIDGE_SERVER_NAME,
  type RunToolBridge,
  type RunBridgeToolRef,
  type RunBridgePublisher,
} from '../../../mcp/run-bridge';
import { getRunPublisher } from '../../../run/contextLookup';
import { runControlRegistry } from '../../../run/RunControlRegistry';
import { resolveTools, partitionToolRefs } from '../../../tools/tool-resolver';
import { runDirRoot, sanitizeSegment, resolveWorkspaceMount } from './claudeCodeExecutor';
import { acquireCopilotLease, type CopilotLeaseHandle } from './copilotSdkLease';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObject = Record<string, any>;

export const DEFAULT_TIMEOUT_MS = 1_800_000;
export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
export const MAX_ASSISTANT_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_USAGE_EVENTS = 256;
export const MAX_USAGE_MODELS = 32;
export const STDERR_TAIL_BYTES = 2048;
const RUN_POLL_INTERVAL_MS = 60_000;
const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'interrupted']);

export class CopilotSdkError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CopilotSdkError';
    this.code = code;
  }
}

export interface CopilotSdkUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  uncached_input_tokens: number;
  input_token_details: { cache_creation: number; cache_read: number };
}

interface UsageBucket {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  calls: number;
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED:COPILOT_GITHUB_TOKEN]') : text;
}

/** Child runtime environment; the SDK uses this as-is instead of inheriting process.env. */
export function buildCopilotSdkRuntimeEnv(params: {
  home: string;
  dir: string;
  parentEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  const parent = params.parentEnv ?? process.env;
  return {
    PATH: parent.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: params.home,
    TMPDIR: params.dir,
    XDG_CONFIG_HOME: path.join(params.home, '.config'),
    XDG_CACHE_HOME: path.join(params.home, '.cache'),
    LANG: parent.LANG || 'C.UTF-8',
    TZ: 'UTC',
    TERM: 'dumb',
    NO_COLOR: '1',
  };
}

export function resolveCopilotSdkModel(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'gpt-5';
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new CopilotSdkError('copilot_sdk_bad_model', `Invalid Copilot SDK model identifier: ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolveCopilotToolFilter(serverName: string, toolNames: string[]): ToolSet {
  const tools = new ToolSet();
  for (const name of toolNames) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(name)) {
      throw new CopilotSdkError('copilot_sdk_bridge_invalid', `Invalid MCP bridge tool name: ${JSON.stringify(name)}`);
    }
    // The SDK's canonical MCP tool id is `${serverKey}-${toolName}`.
    tools.addMcp(`${serverName}-${name}`);
  }
  return tools;
}

function buildBridgeServer(bridge: RunToolBridge): Record<string, unknown> {
  const map = bridge.mcpConfig?.mcpServers;
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new CopilotSdkError('copilot_sdk_bridge_invalid', 'Run bridge did not provide an MCP server map');
  }
  const entries = Object.entries(map as AnyObject);
  if (entries.length !== 1 || entries[0][0] !== BRIDGE_SERVER_NAME) {
    throw new CopilotSdkError('copilot_sdk_bridge_invalid', 'Refusing to configure anything except the private Redbtn run bridge');
  }
  const config = entries[0][1] as AnyObject;
  if (!config || typeof config.command !== 'string' || !Array.isArray(config.args) || !config.env || typeof config.env !== 'object') {
    throw new CopilotSdkError('copilot_sdk_bridge_invalid', 'Private Redbtn MCP bridge configuration is incomplete');
  }
  return {
    type: 'local',
    command: config.command,
    args: config.args,
    env: config.env,
    tools: bridge.toolNames.slice(),
    timeout: 30_000,
  };
}

export function buildCopilotSdkClientOptions(params: {
  home: string;
  cwd: string;
  dir: string;
  parentEnv?: NodeJS.ProcessEnv;
}): CopilotClientOptions {
  return {
    mode: 'empty',
    baseDirectory: params.home,
    workingDirectory: params.cwd,
    env: buildCopilotSdkRuntimeEnv(params),
    // Prevent fallback to a local Copilot/gh login. The actual credential is
    // scoped to createSession({ gitHubToken }) for this one run only.
    useLoggedInUser: false,
    enableRemoteSessions: false,
    logLevel: 'none',
  };
}

export function buildCopilotSdkSessionConfig(params: {
  token: string;
  model: string;
  systemPrompt: string;
  cwd: string;
  toolNames: string[];
  bridgeServer: Record<string, unknown>;
  streaming: boolean;
  permissionHandler: NonNullable<SessionConfig['onPermissionRequest']>;
}): SessionConfig {
  return {
    model: params.model,
    gitHubToken: params.token,
    workingDirectory: params.cwd,
    systemMessage: { content: params.systemPrompt },
    streaming: params.streaming,
    mcpServers: { [BRIDGE_SERVER_NAME]: params.bridgeServer as unknown as MCPStdioServerConfig },
    availableTools: resolveCopilotToolFilter(BRIDGE_SERVER_NAME, params.toolNames),
    // Defense in depth: availableTools is the positive allowlist; these broad
    // source exclusions explicitly rule out built-in shell/filesystem/network
    // tools and custom tools while leaving the individually-listed MCP tools.
    excludedTools: new ToolSet().addBuiltIn('*').addCustom('*'),
    skipCustomInstructions: true,
    enableConfigDiscovery: false,
    skillDirectories: [],
    pluginDirectories: [],
    instructionDirectories: [],
    includedBuiltinSkills: [],
    disabledMcpServers: [],
    mcpOAuthTokenStorage: 'in-memory',
    memory: { enabled: false },
    enableSessionStore: false,
    infiniteSessions: { enabled: false },
    enableFileChangeTracking: false,
    enableSessionTelemetry: false,
    onPermissionRequest: params.permissionHandler,
  };
}

export function makeCopilotPermissionHandler(
  allowedNames: ReadonlySet<string>,
  onDenied: (request: PermissionRequest) => void = () => undefined,
): NonNullable<SessionConfig['onPermissionRequest']> {
  return (request: PermissionRequest) => {
    if (request.kind === 'mcp' && request.serverName === BRIDGE_SERVER_NAME) {
      const rawName = request.toolName;
      const canonicalName = `${BRIDGE_SERVER_NAME}-${rawName}`;
      if (allowedNames.has(rawName) || allowedNames.has(canonicalName)) return { kind: 'approve-once' };
    }
    onDenied(request);
    return { kind: 'reject', feedback: 'This session may use only the current run’s explicitly configured Redbtn MCP tools.' };
  };
}

async function auditPermissionDenials(
  publisher: AnyObject | undefined,
  stepId: string,
  names: string[],
  controlled: <T>(operation: Promise<T>) => Promise<T>,
): Promise<void> {
  if (!publisher?.toolStart || !publisher?.toolError) return;
  for (const [index, name] of names.slice(0, 20).entries()) {
    const id = `tool_copilot_sdk_denied_${Date.now()}_${index}`;
    try {
      await controlled(Promise.resolve(publisher.toolStart(id, name, 'native', {
        triggeredBy: 'neuron', neuronStepId: stepId, copilotSdk: true, denied: true,
      })));
      await controlled(Promise.resolve(publisher.toolError(id, `copilot-sdk permission denial: ${name}`, {
        triggeredBy: 'neuron', neuronStepId: stepId,
      })));
    } catch (error) {
      console.warn('[CopilotSdk] permission denial audit failed:', error);
      if (error instanceof Error && error.name === 'AbortError') return;
      if ((error as Error & { code?: string })?.code === 'copilot_sdk_timeout') return;
    }
  }
}

function buildPrompts(config: NeuronStepConfig, state: AnyObject, tree: string): { system: string; user: string } {
  const system = [
    `Your only tools are the explicitly enabled '${BRIDGE_SERVER_NAME}' MCP tools. They act on the run workspace at ${tree}. You have no shell, host filesystem, built-in tools, or general network access.`,
  ];
  if (typeof state?.systemPrefix === 'string' && state.systemPrefix) system.push(state.systemPrefix);
  if (config.systemPrompt) system.push(renderTemplate(config.systemPrompt, state));
  if (typeof state?.data?.workspaceInstructions === 'string' && state.data.workspaceInstructions.trim()) {
    system.push(state.data.workspaceInstructions);
  }
  const match = config.userPrompt?.match(/^\{\{state\.([\w.]+)\}\}$/);
  const messages = match ? getNestedProperty(state, match[1]) : undefined;
  const user = Array.isArray(messages)
    ? messages.map((message: AnyObject) => {
        const content = typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? message.content.map((part: AnyObject) => typeof part === 'string' ? part : part?.type === 'text' ? part.text ?? '' : '').join('')
            : String(message?.content ?? '');
        return `${message?.role || 'user'}: ${content}`;
      }).join('\n\n')
    : renderTemplate(config.userPrompt, state);
  return { system: system.join('\n\n'), user };
}

function containsNonTextPart(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsNonTextPart(entry, seen, depth + 1));
  const object = value as AnyObject;
  const type = typeof object.type === 'string' ? object.type.toLowerCase() : '';
  if (type && !['text', 'output_text', 'human', 'user', 'assistant'].includes(type)) return true;
  if (['image', 'image_url', 'input_audio', 'audio', 'media', 'video', 'file_data', 'inline_data'].some((key) => key in object)) return true;
  if (typeof object.mimeType === 'string' && /^(image|audio|video)\//i.test(object.mimeType)) return true;
  if (typeof object.mime_type === 'string' && /^(image|audio|video)\//i.test(object.mime_type)) return true;
  if ('content' in object && containsNonTextPart(object.content, seen, depth + 1)) return true;
  return false;
}

/** Reject multimedia before any message parts are flattened into plain text. */
export function assertCopilotTextOnlyInput(config: NeuronStepConfig, state: AnyObject): void {
  const cfg = config as AnyObject;
  const input = state?.data?.input ?? {};
  const attachments = Array.isArray(input.attachments) && input.attachments.length
    ? input.attachments
    : state?.data?._trigger?.metadata?.attachments;
  const hasMediaAttachment = Array.isArray(attachments) && attachments.some((attachment: AnyObject) => {
    const kind = typeof attachment?.kind === 'string' ? attachment.kind.toLowerCase() : '';
    const mime = typeof attachment?.mimeType === 'string' ? attachment.mimeType : attachment?.mime_type;
    return ['image', 'audio', 'video', 'document', 'file'].includes(kind) ||
      (typeof mime === 'string' && !/^text\/plain(?:;|$)/i.test(mime));
  });
  const hasPromptMediaPart = [cfg.userPrompt, cfg.systemPrompt]
    .filter((prompt): prompt is string => typeof prompt === 'string')
    .some((prompt) => {
      const refs = prompt.matchAll(/\{\{state\.([\w.]+)\}\}/g);
      for (const match of refs) {
        if (containsNonTextPart(getNestedProperty(state, match[1]))) return true;
      }
      return false;
    });
  if (
    cfg.multimodal === true || cfg.imageInput === true || cfg.audioInput === true ||
    Boolean(input.audioData) || hasMediaAttachment || hasPromptMediaPart
  ) {
    throw new CopilotSdkError(
      'copilot_sdk_unsupported_input_modality',
      'copilot-sdk V1 accepts text input only; image, audio, and other multimodal message parts are not supported. Remove the media input or use a vision/audio-capable neuron.',
    );
  }
}

function ensurePrivateCwd(dir: string): string {
  const cwd = path.join(dir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
  fs.chmodSync(cwd, 0o700);
  return cwd;
}

export function classifyCopilotSdkFailure(error: unknown, token = ''): CopilotSdkError {
  const chain: AnyObject[] = [];
  let current: unknown = error;
  for (let i = 0; i < 5 && current && typeof current === 'object'; i += 1) {
    chain.push(current as AnyObject);
    current = (current as AnyObject).cause;
  }
  const status = chain.map((entry) => entry.status ?? entry.statusCode ?? entry.response?.status)
    .map((value) => typeof value === 'number' ? value : Number(value))
    .find((value) => Number.isInteger(value) && value >= 100 && value < 600);
  const codes = chain.map((entry) => typeof entry.code === 'string' ? entry.code.toUpperCase() : '');
  const message = redactSecret(
    chain.map((entry) => typeof entry.message === 'string' ? entry.message : '').filter(Boolean).join(' | ') || String(error),
    token,
  ).slice(0, STDERR_TAIL_BYTES);
  const text = message.toLowerCase();
  // Authentication/authorization evidence is terminal even when an upstream
  // message also happens to contain rate-limit or quota wording.
  if (/\b401\b|\b403\b|unauthori[sz]ed|authori[sz]ation|forbidden|authentication|invalid.{0,15}token/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_auth_failed', `GitHub Copilot SDK authentication failed: ${message}`);
  }
  const textualStatusMatch = message.match(/\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i);
  const genericClientStatus = message.match(/\b(4\d{2})\b/);
  const textualStatus = textualStatusMatch
    ? Number(textualStatusMatch[1])
    : genericClientStatus
      ? Number(genericClientStatus[1])
      : undefined;
  const effectiveStatus = status ?? textualStatus;
  if (effectiveStatus === 429) {
    return new CopilotSdkError('copilot_sdk_rate_limited', `GitHub Copilot subscription rate limited: ${message}`);
  }
  if (typeof effectiveStatus === 'number' && effectiveStatus >= 400 && effectiveStatus < 500) {
    return new CopilotSdkError('copilot_sdk_http_4xx', `GitHub Copilot SDK rejected the request (HTTP ${effectiveStatus}): ${message}`);
  }
  if (/\bHTTP\s*4xx\b/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_http_4xx', `GitHub Copilot SDK rejected the request: ${message}`);
  }
  if (typeof effectiveStatus === 'number' && effectiveStatus >= 500 && effectiveStatus < 600) {
    return new CopilotSdkError('copilot_sdk_http_5xx', `GitHub Copilot service failed (HTTP ${effectiveStatus}): ${message}`);
  }
  if (/\b429\b|rate.?limit|quota|too many requests|resource_exhausted/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_rate_limited', `GitHub Copilot subscription rate limited: ${message}`);
  }
  if (codes.some((code) => ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) ||
      /fetch failed|socket hang up|network error|connection (?:reset|refused|aborted)|econnreset|enotfound/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_network', `Copilot SDK network failure: ${message}`);
  }
  if (typeof effectiveStatus !== 'number' && /\b(500|502|503|504)\b|internal server error|bad gateway|service unavailable|gateway timeout/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_http_5xx', `GitHub Copilot service failed: ${message}`);
  }
  if (/overloaded|at capacity|capacity exceeded|temporarily unavailable|server busy/i.test(text)) {
    return new CopilotSdkError('copilot_sdk_capacity', `GitHub Copilot service is at capacity: ${message}`);
  }
  if (/timed out|timeout|etimedout/i.test(message) || codes.includes('ETIMEDOUT')) {
    return new CopilotSdkError('copilot_sdk_timeout', `Copilot SDK request timed out: ${message}`);
  }
  if (/enoent|no such file or directory|could not find.*runtime|runtime (?:not found|unavailable)|failed to spawn|unable to start.*(cli|runtime)/i.test(message)) {
    return new CopilotSdkError('copilot_sdk_runtime_unavailable', `Copilot SDK runtime could not start: ${message}`);
  }
  return new CopilotSdkError('copilot_sdk_failed', `Copilot SDK request failed: ${message || 'unknown SDK error'}`);
}

export interface CopilotSdkDependencies {
  createClient?: (options: CopilotClientOptions) => CopilotClient;
  startBridge?: typeof startRunToolBridge;
  acquireLease?: typeof acquireCopilotLease;
}

export interface RunCopilotSdkStepOptions {
  config: NeuronStepConfig;
  state: AnyObject;
  neuronCfg: AnyObject;
  neuronId: string;
  userId?: string;
  callRunId?: string;
  abortSignal?: AbortSignal;
  emitUsage: (providerResponse: unknown, modelHint?: string, stepIdOverride?: string) => void;
  /** Internal dependency seams for tests; not configurable from neuron documents. */
  dependencies?: CopilotSdkDependencies;
}

export async function runCopilotSdkStep(options: RunCopilotSdkStepOptions): Promise<Record<string, unknown>> {
  const { config, state, neuronCfg, neuronId, callRunId, abortSignal, emitUsage } = options;
  const stepId = config.outputField;
  const runId = callRunId || state?.runId || state?.data?.runId || 'norun';
  const publisher: AnyObject | undefined = getRunPublisher(state);
  const publishChunk = typeof publisher?.chunk === 'function' ? publisher.chunk.bind(publisher) as (text: string) => Promise<unknown> : undefined;
  if (neuronCfg?.secretName !== 'COPILOT_GITHUB_TOKEN') {
    throw new CopilotSdkError(
      'copilot_sdk_bad_secret_name',
      `Neuron '${neuronId}' must resolve the RedSecrets entry named 'COPILOT_GITHUB_TOKEN'.`,
    );
  }
  const token = typeof neuronCfg?.apiKey === 'string' ? neuronCfg.apiKey : '';
  if (!token) {
    throw new CopilotSdkError(
      'copilot_sdk_no_token',
      `Neuron '${neuronId}' uses 'copilot-sdk' but the COPILOT_GITHUB_TOKEN secretName did not resolve through RedSecrets.`,
    );
  }
  if (config.structuredOutput) {
    throw new CopilotSdkError(
      'copilot_sdk_structured_output_unsupported',
      'copilot-sdk structuredOutput remains disabled until Redbtn pins and validates the runtime response-schema contract; parse JSON in a later graph step.',
    );
  }
  assertCopilotTextOnlyInput(config, state);

  const model = resolveCopilotSdkModel(neuronCfg.model);
  const mount = resolveWorkspaceMount(state);
  const timeoutMs = typeof (config as AnyObject).timeoutMs === 'number' && (config as AnyObject).timeoutMs > 0
    ? (config as AnyObject).timeoutMs : DEFAULT_TIMEOUT_MS;
  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `copilot-sdk-${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const cwd = ensurePrivateCwd(dir);

  let bridge: RunToolBridge | null = null;
  let client: CopilotClient | null = null;
  let session: CopilotSession | null = null;
  let lease: CopilotLeaseHandle | null = null;
  let unregisterCancel: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  const unsubscribe: Array<() => void> = [];
  let publishChain: Promise<void> = Promise.resolve();
  let finalText = '';
  let streamedText = '';
  let streamRedactionBuffer = '';
  let streamToUser = false;
  let streamedBytes = 0;
  let usageEventCount = 0;
  let droppedUsageEvents = 0;
  const usageByModel = new Map<string, UsageBucket>();
  const deniedToolNames: string[] = [];
  const ctl: { stopReason: string | null; timedOut: boolean; leaseLost: boolean } = {
    stopReason: null, timedOut: false, leaseLost: false,
  };
  let stopReject!: (error: Error) => void;
  const stopped = new Promise<never>((_resolve, reject) => { stopReject = reject; });
  void stopped.catch(() => undefined);
  const controlled = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, stopped]);
  const requestStop = (reason: string, error: Error): void => {
    if (ctl.stopReason) return;
    ctl.stopReason = reason;
    stopReject(error);
    try { void session?.abort().catch(() => undefined); } catch { /* runtime may already be stopping */ }
    try { void client?.forceStop().catch(() => undefined); } catch { /* best effort child cleanup */ }
  };

  const flushRedactedStream = (final = false): void => {
    if (!streamToUser || !streamRedactionBuffer) return;
    let safeBoundary = final
      ? streamRedactionBuffer.length
      : Math.max(0, streamRedactionBuffer.length - Math.max(0, token.length - 1));
    if (!final && token.length > 1 && safeBoundary > 0) {
      // A full token occurrence can straddle the proposed boundary even when
      // the final token.length-1 suffix is retained. Move the boundary back to
      // the occurrence's start; the next event will let the complete token be
      // redacted before any of its characters can be published.
      let changed = true;
      while (changed) {
        changed = false;
        let index = streamRedactionBuffer.indexOf(token);
        while (index !== -1) {
          if (index < safeBoundary && index + token.length > safeBoundary) {
            safeBoundary = index;
            changed = true;
          }
          index = streamRedactionBuffer.indexOf(token, index + 1);
        }
      }
    }
    if (safeBoundary <= 0) return;
    const safeRaw = streamRedactionBuffer.slice(0, safeBoundary);
    streamRedactionBuffer = streamRedactionBuffer.slice(safeBoundary);
    const safeText = redactSecret(safeRaw, token);
    if (!safeText) return;
    streamedText += safeText;
    publishChain = publishChain.then(async () => { await publishChunk!(safeText); }).catch((error) => {
      console.warn('[CopilotSdk] text chunk publish failed:', redactSecret(String(error), token));
    });
  };

  const queueStartedAt = Date.now();
  let usageEmitted = false;
  const emitCollectedUsage = (): void => {
    if (usageEmitted) return;
    usageEmitted = true;
    for (const [entryModel, bucket] of usageByModel) {
      // `assistant.usage.inputTokens` is the SDK's normalized input total;
      // cache read/write counts are breakdowns within that total (as in the
      // other engine provider usage metadata), not additional prompt tokens.
      const input = bucket.input;
      const usage: CopilotSdkUsage = {
        input_tokens: input,
        output_tokens: bucket.output,
        total_tokens: input + bucket.output,
        uncached_input_tokens: Math.max(0, input - bucket.cacheRead - bucket.cacheWrite),
        input_token_details: { cache_creation: bucket.cacheWrite, cache_read: bucket.cacheRead },
      };
      try {
        emitUsage({ usage_metadata: usage }, `copilot-sdk/${entryModel}`, `${stepId}:sdk:${entryModel}`);
      } catch (error) {
        console.warn('[CopilotSdk] usage emission failed:', error);
      }
    }
  };

  try {
    if (abortSignal?.aborted || runControlRegistry.wasCancelled(runId)) throw abortError('Copilot SDK step cancelled before start');
    const { clientRefs, hostedCapabilities } = partitionToolRefs(Array.isArray(config.tools) ? config.tools : []);
    if (hostedCapabilities.length) {
      console.warn(`[CopilotSdk] provider-hosted tools ignored (${hostedCapabilities.join(', ')}); only attached Redbtn MCP tools are available to this agent.`);
    }
    const resolved = await resolveTools(clientRefs, state);
    const servable: RunBridgeToolRef[] = resolved.filter((tool) => !isForbiddenForBridge(tool.name));
    const rawWait = Number.parseInt(process.env.COPILOT_SDK_QUEUE_WAIT_MS || '', 10);
    const maxWaitMs = Number.isFinite(rawWait) && rawWait > 0 ? Math.min(timeoutMs, rawWait) : timeoutMs;
    try {
      lease = await (options.dependencies?.acquireLease ?? acquireCopilotLease)({
        signal: abortSignal,
        maxWaitMs,
        onWaiting: (reason) => {
          if (publisher?.nodeProgress) {
            void Promise.resolve(publisher.nodeProgress(
              runControlRegistry.get(runId)?.currentNodeId || stepId,
              reason,
              { data: { stepId, phase: 'queued' } },
            )).catch(() => undefined);
          }
        },
      });
    } catch (error) {
      const failure = error as Error & { code?: string };
      if (failure.name === 'AbortError') throw failure;
      if (failure.code === 'copilot_sdk_queue_timeout') {
        throw new CopilotSdkError('copilot_sdk_queue_timeout', failure.message);
      }
      if (failure.code === 'copilot_sdk_redis_url_missing') {
        throw new CopilotSdkError('copilot_sdk_redis_url_missing', 'REDIS_URL is required for the fleet-wide Copilot SDK lease; the SDK session was not started.');
      }
      throw new CopilotSdkError(
        'copilot_sdk_lease_unavailable',
        'Redis could not provide the required fleet-wide Copilot subscription lease; the SDK session was not started.',
      );
    }
    const queuedMs = Date.now() - queueStartedAt;
    let remainingMs = timeoutMs - queuedMs;
    if (remainingMs <= 0) throw new CopilotSdkError('copilot_sdk_queue_timeout', 'Copilot subscription lease consumed the step timeout');
    if (abortSignal?.aborted || runControlRegistry.wasCancelled(runId)) throw abortError('Copilot SDK step cancelled while queued');

    bridge = await (options.dependencies?.startBridge ?? startRunToolBridge)({
      runId,
      state,
      publisher: (publisher as RunBridgePublisher | undefined) ?? null,
      resolvedTools: servable,
      environmentId: typeof state?.data?.environmentId === 'string' ? state.data.environmentId : '',
      workingDir: typeof state?.data?.workingDir === 'string' && state.data.workingDir ? state.data.workingDir : mount.tree,
      abortSignal: abortSignal ?? null,
      neuronStepId: stepId,
      dir,
      maxToolIterations: typeof config.maxToolIterations === 'number' && config.maxToolIterations > 0 ? config.maxToolIterations : undefined,
      onCancel: () => requestStop('run cancelled', abortError('Copilot SDK run cancelled')),
    });

    const prompts = buildPrompts(config, state, mount.tree);
    const promptBytes = Buffer.byteLength(prompts.system, 'utf8') + Buffer.byteLength(prompts.user, 'utf8');
    if (promptBytes > MAX_PROMPT_BYTES) {
      throw new CopilotSdkError('copilot_sdk_prompt_too_large', `Copilot SDK prompt is ${promptBytes} bytes; maximum is ${MAX_PROMPT_BYTES}`);
    }
    const allowedNames = new Set(bridge.toolNames);
    streamToUser = config.stream === true && publishChunk !== undefined;
    const clientOptions = buildCopilotSdkClientOptions({ home, cwd, dir });
    client = (options.dependencies?.createClient ?? ((opts) => new CopilotClient(opts)))(clientOptions);
    const startedAt = Date.now();
    const timeoutError = new CopilotSdkError('copilot_sdk_timeout', `Copilot SDK step '${stepId}' exceeded its ${timeoutMs} ms budget`);
    const onTimeout = () => {
      ctl.timedOut = true;
      requestStop('wall-clock timeout', timeoutError);
    };
    const startWallClock = () => {
      remainingMs = timeoutMs - (Date.now() - queueStartedAt);
      if (remainingMs <= 0) {
        onTimeout();
        return;
      }
      wallTimer = setTimeout(onTimeout, remainingMs);
      wallTimer.unref?.();
    };
    startWallClock();
    if (ctl.timedOut) throw timeoutError;

    unregisterCancel = runControlRegistry.registerOnCancel(runId, () =>
      requestStop('run cancelled', abortError('Copilot SDK run cancelled')),
    );
    if (abortSignal) {
      onAbort = () => requestStop('run aborted', abortError('Copilot SDK run aborted'));
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) onAbort();
    }
    lease.startRenewal((error) => {
      ctl.leaseLost = true;
      requestStop('subscription lease lost', new CopilotSdkError('copilot_sdk_lease_lost', `Copilot subscription lease renewal failed: ${redactSecret(error.message, token)}`));
    });
    if (publisher?.getState) {
      pollTimer = setInterval(() => {
        void publisher.getState().then((run: AnyObject) => {
          if (typeof run?.status === 'string' && TERMINAL_RUN_STATUSES.has(run.status)) {
            requestStop(`run is terminal (${run.status})`, abortError(`Copilot SDK run is terminal (${run.status})`));
          }
        }).catch(() => undefined);
      }, RUN_POLL_INTERVAL_MS);
      pollTimer.unref?.();
    }

    // Only this bridge's exact tool names are permitted. The SDK's own
    // permission callback independently rejects every shell/read/write/url,
    // built-in, or unknown MCP request.
    const sessionConfig = buildCopilotSdkSessionConfig({
      token,
      model,
      systemPrompt: prompts.system,
      cwd,
      toolNames: bridge.toolNames,
      bridgeServer: buildBridgeServer(bridge),
      streaming: streamToUser,
      permissionHandler: makeCopilotPermissionHandler(allowedNames, (request) => {
        const name = request.kind === 'mcp'
          ? `${request.serverName}/${request.toolName}`
          : `${request.kind}/${'toolName' in request ? String(request.toolName) : 'unknown'}`;
        deniedToolNames.push(name.slice(0, 160));
        console.error(`[CopilotSdk][security] denied non-bridge tool request in run ${runId}, step ${stepId}: ${name.slice(0, 160)}`);
      }),
    });
    await controlled(client.start());
    if (abortSignal?.aborted || runControlRegistry.wasCancelled(runId)) throw abortError('Copilot SDK step cancelled before session creation');
    session = await controlled(client.createSession(sessionConfig));
    const sessionId = session.sessionId;

    let finalEventText = '';
    unsubscribe.push(session.on('assistant.message', (event) => {
      if (event.agentId == null && typeof event.data?.content === 'string') {
        finalEventText = redactSecret(event.data.content, token);
      }
    }));
    unsubscribe.push(session.on('assistant.message_delta', (event) => {
      if (event.agentId != null || typeof event.data?.deltaContent !== 'string') return;
      const delta = redactSecret(event.data.deltaContent, token);
      streamedBytes += Buffer.byteLength(delta, 'utf8');
      if (streamedBytes > MAX_ASSISTANT_OUTPUT_BYTES) {
        requestStop('assistant output limit exceeded', new CopilotSdkError(
          'copilot_sdk_output_too_large',
          `Copilot SDK response exceeded ${MAX_ASSISTANT_OUTPUT_BYTES} bytes`,
        ));
        return;
      }
      if (streamToUser && publisher?.chunk) {
        streamRedactionBuffer += delta;
        flushRedactedStream();
      }
    }));
    unsubscribe.push(session.on('assistant.usage', (event) => {
      usageEventCount += 1;
      if (usageEventCount > MAX_USAGE_EVENTS) {
        droppedUsageEvents += 1;
        return;
      }
      const usage = event.data;
      const entryModel = typeof usage?.model === 'string' ? usage.model : model;
      let bucket = usageByModel.get(entryModel);
      if (!bucket) {
        if (usageByModel.size >= MAX_USAGE_MODELS) {
          droppedUsageEvents += 1;
          return;
        }
        bucket = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, calls: 0 };
        usageByModel.set(entryModel, bucket);
      }
      bucket.input += safeNumber(usage.inputTokens);
      bucket.output += safeNumber(usage.outputTokens);
      bucket.cacheRead += safeNumber(usage.cacheReadTokens);
      bucket.cacheWrite += safeNumber(usage.cacheWriteTokens);
      bucket.calls += 1;
    }));

    const response = await controlled(session.sendAndWait({ prompt: prompts.user }, remainingMs));
    if (ctl.leaseLost) throw new CopilotSdkError('copilot_sdk_lease_lost', 'Copilot SDK stopped because its fleet-wide subscription lease was lost');
    if (ctl.timedOut) throw timeoutError;
    if (ctl.stopReason) throw abortError(`Copilot SDK step stopped: ${ctl.stopReason}`);
    finalText = typeof response?.data?.content === 'string'
      ? redactSecret(response.data.content, token)
      : finalEventText || streamedText;
    if (Buffer.byteLength(finalText, 'utf8') > MAX_ASSISTANT_OUTPUT_BYTES) {
      throw new CopilotSdkError('copilot_sdk_output_too_large', `Copilot SDK response exceeded ${MAX_ASSISTANT_OUTPUT_BYTES} bytes`);
    }
    if (streamToUser) {
      // Flush only after the final event is known so a token fragmented across
      // any number of SDK deltas can never escape through RunPublisher.chunk.
      // Rebuild the buffered suffix from the authoritative final response to
      // account for SDK stream corrections before publishing it.
      if (streamedText.length <= finalText.length && finalText.startsWith(streamedText)) {
        streamRedactionBuffer = finalText.slice(streamedText.length);
      } else {
        streamRedactionBuffer = finalText;
        streamedText = '';
        if (publisher?.replaceOutputContent) {
          try { await controlled(Promise.resolve(publisher.replaceOutputContent(''))); }
          catch (error) {
            if (ctl.stopReason) throw error;
            /* best effort before corrected chunks */
          }
        }
      }
      flushRedactedStream(true);
      await controlled(publishChain);
    }
    if (deniedToolNames.length) await auditPermissionDenials(publisher, stepId, deniedToolNames, controlled);
    if (ctl.timedOut) throw timeoutError;
    if (ctl.stopReason) throw abortError(`Copilot SDK step stopped: ${ctl.stopReason}`);
    if (!finalText.trim() && deniedToolNames.length) {
      throw new CopilotSdkError(
        'copilot_sdk_tool_denied',
        `Copilot SDK returned no answer after requesting ${deniedToolNames.length} tool(s) denied by the run policy.`,
      );
    }
    if (!finalText.trim()) throw new CopilotSdkError('copilot_sdk_empty_result', 'Copilot SDK completed without a root assistant message');
    if (streamToUser && streamedText !== finalText && publisher?.replaceOutputContent) {
      try { await controlled(Promise.resolve(publisher.replaceOutputContent(finalText))); } catch (error) {
        if (ctl.stopReason) throw error;
        console.warn('[CopilotSdk] final stream reconciliation failed:', redactSecret(String(error), token));
      }
    }
    emitCollectedUsage();
    const cli = {
      provider: 'copilot-sdk',
      model: response?.data?.model || [...usageByModel.keys()].slice(-1)[0] || model,
      sessionId,
      durationMs: Date.now() - startedAt,
      queuedMs,
      usage: [...usageByModel.entries()].map(([usageModel, bucket]) => ({
        model: usageModel,
        calls: bucket.calls,
        inputTokens: bucket.input,
        outputTokens: bucket.output,
        cacheReadTokens: bucket.cacheRead,
        cacheWriteTokens: bucket.cacheWrite,
      })),
      usageEventsDropped: droppedUsageEvents,
      permissionDenials: deniedToolNames.length,
      permissionDenialNames: deniedToolNames.slice(0, 20),
      totalCostUsdEstimate: 0,
    };
    const cliBag = { ...(state?.data?._cli ?? {}), [stepId]: cli };
    if (state?.data && typeof state.data === 'object') state.data._cli = cliBag;
    return { [stepId]: finalText, 'data._cli': cliBag };
  } catch (error) {
    emitCollectedUsage();
    if (ctl.timedOut) throw new CopilotSdkError('copilot_sdk_timeout', `Copilot SDK step '${stepId}' exceeded its ${timeoutMs} ms budget`);
    if (ctl.leaseLost) throw new CopilotSdkError('copilot_sdk_lease_lost', 'Copilot SDK stopped because its fleet-wide subscription lease was lost');
    if (ctl.stopReason && !ctl.timedOut) {
      const stoppedError = error instanceof Error ? error : abortError(`Copilot SDK stopped: ${ctl.stopReason}`);
      if (stoppedError.name === 'AbortError') throw stoppedError;
    }
    if (error instanceof CopilotSdkError || (error as Error)?.name === 'AbortError') throw error;
    throw classifyCopilotSdkFailure(error, token);
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    if (pollTimer) clearInterval(pollTimer);
    if (unregisterCancel) unregisterCancel();
    if (onAbort && abortSignal) abortSignal.removeEventListener('abort', onAbort);
    for (const off of unsubscribe) {
      try { off(); } catch { /* SDK already disconnected */ }
    }
    if (session) {
      try { await withDeadline(session.disconnect(), 3000, () => undefined); }
      catch { /* stop/forceStop below also tears down the session */ }
    }
    if (client) {
      try {
        const errors = await withDeadline(client.stop(), 5000, () => [new Error('Copilot runtime shutdown timed out')]);
        if (errors.length) await client.forceStop();
      } catch {
        try { await client.forceStop(); } catch { /* best effort: the runtime is already gone */ }
      }
    }
    if (bridge) {
      try { await withDeadline(bridge.close({ removeDir: false }), 3000, () => undefined); }
      catch (error) { console.warn('[CopilotSdk] run bridge close failed:', redactSecret(String(error), token)); }
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (error) { console.warn(`[CopilotSdk] private run-state cleanup failed: ${redactSecret(String(error), token)}`); }
    try { fs.rmdirSync(path.dirname(dir)); } catch { /* sibling step still owns the run directory */ }
    if (lease) {
      try { await withDeadline(lease.release(), 3000, () => undefined); }
      catch (error) { console.error('[CopilotSdk] distributed lease release failed:', redactSecret(String(error), token)); }
    }
  }
}
