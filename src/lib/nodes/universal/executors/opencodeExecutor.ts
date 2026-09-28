/**
 * `opencode` neuron executor — runs OpenCode CLI turns.
 *
 * Spawns `opencode run -m <model> --format json --standalone --auto`,
 * pipes the rendered prompt via stdin, parses the NDJSON stream,
 * streams tokens, and tracks execution metrics.
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { NeuronStepConfig } from '../types';
import type { NeuronConfig } from '../../../types/neuron';
import { renderTemplate } from '../templateRenderer';
import { getRunPublisher } from '../../../run/contextLookup';
import { runControlRegistry } from '../../../run/RunControlRegistry';

type AnyObject = Record<string, any>;

export const DEFAULT_TIMEOUT_MS = 1_800_000; // 30 minutes

export class OpencodeCliError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'OpencodeCliError';
    this.code = code;
  }
}

export interface RunOpencodeStepOptions {
  config: NeuronStepConfig;
  state: any;
  neuronCfg: NeuronConfig;
  neuronId: string;
  userId: string;
  callRunId?: string;
  abortSignal?: AbortSignal;
  emitUsage?: (usage: any, modelId: string, stepId: string) => void;
}

/** Resolve canonical model identifier. */
export function resolveOpencodeModel(model?: string): string {
  if (!model || model.trim() === '') {
    return 'opencode/big-pickle';
  }
  const trimmed = model.trim();
  return trimmed.includes('/') ? trimmed : `opencode/${trimmed}`;
}

/** Find the opencode binary path. */
export function resolveOpencodeBinary(): string {
  if (process.env.OPENCODE_BIN_PATH && fs.existsSync(process.env.OPENCODE_BIN_PATH)) {
    return process.env.OPENCODE_BIN_PATH;
  }
  // Standard installed locations
  const candidates = [
    '/home/alpha/.nvm/versions/node/v24.13.1/bin/opencode',
    '/usr/local/bin/opencode',
    '/usr/bin/opencode',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'opencode';
}

function runDirRoot(): string {
  return process.env.RUN_DIR_ROOT || '/tmp/redbtn-runs';
}

function sanitizeSegment(val: string, fallback: string): string {
  const cleaned = val.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned || fallback;
}

/**
 * Execute an `opencode` neuron step.
 */
export async function runOpencodeStep(
  options: RunOpencodeStepOptions,
): Promise<Record<string, unknown>> {
  const { config, state, neuronCfg, neuronId, userId: _userId, callRunId, abortSignal, emitUsage } = options;

  const stepId = config.outputField;
  const runId = callRunId || state?.runId || state?.data?.runId || 'norun';
  const publisher: AnyObject | undefined = getRunPublisher(state);

  const model = resolveOpencodeModel(neuronCfg?.model);
  const timeoutMs =
    typeof (config as AnyObject).timeoutMs === 'number' && (config as AnyObject).timeoutMs > 0
      ? (config as AnyObject).timeoutMs
      : DEFAULT_TIMEOUT_MS;

  // Build prompt
  const rawPrompt = config.userPrompt || (config as AnyObject).prompt || '';
  const userPrompt = renderTemplate(rawPrompt, state);
  const systemPrompt = config.systemPrompt ? renderTemplate(config.systemPrompt, state) : '';
  const fullPrompt = systemPrompt
    ? `System Instructions:\n${systemPrompt}\n\nUser Request:\n${userPrompt}`
    : userPrompt;

  const binPath = resolveOpencodeBinary();

  // Create temporary directory for isolated execution
  const dir = path.join(
    runDirRoot(),
    sanitizeSegment(runId, 'norun'),
    `opencode-${sanitizeSegment(stepId, 'step')}-${crypto.randomBytes(4).toString('hex')}`,
  );
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // ignore
  }

  const childEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/home/alpha',
    USER: process.env.USER || 'alpha',
    LANG: process.env.LANG || 'en_US.UTF-8',
    NODE_ENV: process.env.NODE_ENV || 'production',
  };

  if (neuronCfg?.apiKey) {
    childEnv.OPENCODE_API_KEY = neuronCfg.apiKey;
    childEnv.OPENCODE_ZEN_API_KEY = neuronCfg.apiKey;
  } else if (process.env.OPENCODE_API_KEY) {
    childEnv.OPENCODE_API_KEY = process.env.OPENCODE_API_KEY;
  }

  const spawnArgs = ['run', '-m', model, '--format', 'json', '--standalone', '--auto'];

  let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  let wallTimer: NodeJS.Timeout | null = null;
  let unregisterCancel: (() => void) | null = null;
  let onAbort: (() => void) | null = null;
  let timedOut = false;

  const cleanup = () => {
    if (wallTimer) clearTimeout(wallTimer);
    if (unregisterCancel) unregisterCancel();
    if (abortSignal && onAbort) abortSignal.removeEventListener('abort', onAbort);
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  };

  const signalGroup = (sig: NodeJS.Signals) => {
    const pid = child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child?.kill(sig);
      } catch {
        /* already dead */
      }
    }
  };

  try {
    child = spawn(binPath, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      cwd: fs.existsSync(dir) ? dir : process.cwd(),
      env: childEnv,
    });
  } catch (err: any) {
    cleanup();
    throw new OpencodeCliError(
      'opencode_spawn_failed',
      `Failed to spawn opencode process: ${err?.message || String(err)}`,
    );
  }

  const pid = child.pid;
  if (!pid) {
    cleanup();
    throw new OpencodeCliError('opencode_spawn_failed', 'opencode child process has no PID');
  }

  // Register with RunControlRegistry for external interrupt
  if (typeof runControlRegistry?.registerOnCancel === 'function') {
    unregisterCancel = runControlRegistry.registerOnCancel(runId, () => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 2000).unref();
    });
  }

  if (abortSignal) {
    onAbort = () => {
      signalGroup('SIGTERM');
      setTimeout(() => signalGroup('SIGKILL'), 2000).unref();
    };
    if (abortSignal.aborted) {
      onAbort();
    } else {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  }

  wallTimer = setTimeout(() => {
    timedOut = true;
    signalGroup('SIGTERM');
    setTimeout(() => signalGroup('SIGKILL'), 3000).unref();
  }, timeoutMs);
  wallTimer.unref?.();

  // Pipe prompt to stdin and close stdin
  child.stdin.end(fullPrompt, 'utf-8');

  let accumulatedText = '';
  let stderrBuffer = '';
  let lineRemainder = '';
  let lastErrorEvent: any = null;

  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    try {
      const event = JSON.parse(trimmed);
      if (event.type === 'text') {
        const chunk = event.part?.text ?? event.text ?? '';
        if (chunk) {
          accumulatedText += chunk;
          if (config.stream && publisher?.emitTextChunk) {
            publisher.emitTextChunk(chunk);
          }
        }
      } else if (event.type === 'error') {
        lastErrorEvent = event.error || event;
      }
    } catch {
      // not a JSON event
    }
  };

  child.stdout.on('data', (data: Buffer) => {
    const text = data.toString('utf-8');
    const combined = lineRemainder + text;
    const lines = combined.split('\n');
    lineRemainder = lines.pop() ?? '';
    for (const l of lines) {
      parseLine(l);
    }
  });

  child.stderr.on('data', (data: Buffer) => {
    stderrBuffer += data.toString('utf-8');
    if (stderrBuffer.length > 32768) {
      stderrBuffer = stderrBuffer.slice(-32768);
    }
  });

  const exitResult: { code: number | null; signal: NodeJS.Signals | null } = await new Promise((resolve) => {
    child!.on('exit', (code, signal) => resolve({ code, signal }));
    child!.on('error', (err) => {
      resolve({ code: -1, signal: null });
    });
  });

  cleanup();

  if (lineRemainder) {
    parseLine(lineRemainder);
  }

  if (abortSignal?.aborted) {
    const err = new Error('Run aborted');
    err.name = 'AbortError';
    throw err;
  }

  if (timedOut) {
    throw new OpencodeCliError(
      'opencode_timeout',
      `opencode execution timed out after ${timeoutMs}ms for neuron '${neuronId}'`,
    );
  }

  if (lastErrorEvent) {
    const msg = lastErrorEvent.message || JSON.stringify(lastErrorEvent);
    if (/rate.?limit|too many requests|429/i.test(msg)) {
      throw new OpencodeCliError('opencode_rate_limited', msg);
    }
    throw new OpencodeCliError('opencode_error_result', msg);
  }

  if (exitResult.code !== 0 && !accumulatedText) {
    const text = stderrBuffer.trim() || `Exit code ${exitResult.code}`;
    if (/rate.?limit|too many requests|429/i.test(text)) {
      throw new OpencodeCliError('opencode_rate_limited', text);
    }
    throw new OpencodeCliError(
      'opencode_failed',
      `opencode process failed for neuron '${neuronId}': ${text}`,
    );
  }

  // Token usage accounting
  const inputTokens = Math.max(1, Math.ceil(fullPrompt.length / 4));
  const outputTokens = Math.max(1, Math.ceil(accumulatedText.length / 4));
  const usageMetadata = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };

  if (typeof emitUsage === 'function') {
    emitUsage({ usage_metadata: usageMetadata }, model, stepId);
  }

  return {
    [stepId]: accumulatedText,
    data: {
      _cli: {
        ...(state?.data?._cli || {}),
        [stepId]: {
          provider: 'opencode',
          model,
          usage: usageMetadata,
        },
      },
    },
  };
}
