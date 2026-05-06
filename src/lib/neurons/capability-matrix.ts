/**
 * Capability Matrix for Neuron Tool Strategies
 *
 * Static lookup of `(provider, modelFamily) -> strategy` used by the neuron
 * executor when a step has tools attached and `toolStrategy: 'auto'` (the
 * default).
 *
 * The returned strategy decides how the engine wires attached tools into the
 * LLM call:
 *
 *   - `'native'`            — `model.bindTools(tools)`. Native tool calling
 *                             via the provider's API. Used by OpenAI,
 *                             Anthropic, Google, and tool-capable Ollama
 *                             models.
 *
 *   - `'prompt-injection'`  — Inject a `<tools>` block into the system prompt
 *                             and parse `<tool_call>` from the LLM's text
 *                             output. Used for Ollama models without native
 *                             tool support. (Stubbed in this PR — the
 *                             executor throws "not yet implemented".)
 *
 *   - `'structured-output'` — Existing structuredOutput path. Mutually
 *                             exclusive with attached tools.
 *
 *   - `'none'`              — Plain LLM call, ignore attached tools.
 *
 * # Override semantics
 *
 * Callers may pass an explicit `override` to force a particular strategy:
 *   - When `override === 'auto'`, this function consults the matrix.
 *   - Any other value is returned verbatim (after coercing for type safety).
 *
 * @module lib/neurons/capability-matrix
 */

import type { NeuronProvider } from '../types/neuron';

/**
 * The strategies the runtime knows how to execute.
 *
 * `'auto'` is NOT a runtime strategy — it's a request to consult this matrix.
 */
export type ToolStrategy = 'native' | 'prompt-injection' | 'structured-output' | 'none';

/**
 * Strategy resolution input — exposed for tests and advanced callers.
 */
export interface ResolveToolStrategyInput {
  provider: NeuronProvider;
  model: string;
  override?: 'auto' | ToolStrategy;
}

/**
 * Glob-style match: a pattern with optional trailing `*` matches when the
 * value starts with the prefix (case-insensitive).
 */
function matchesGlob(value: string, pattern: string): boolean {
  const lowered = value.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.endsWith('*')) {
    return lowered.startsWith(p.slice(0, -1));
  }
  return lowered === p;
}

interface MatrixEntry {
  /** Glob patterns (case-insensitive, optional trailing `*`) */
  patterns: string[];
  strategy: ToolStrategy;
}

/**
 * Per-provider rule list. Each entry's patterns are tried in order; the
 * first match wins. If no entry matches, the per-provider default kicks in
 * (see `PROVIDER_DEFAULTS`).
 */
const MATRIX: Record<NeuronProvider, MatrixEntry[]> = {
  // Anthropic — every Claude model supports native tool calling
  anthropic: [
    { patterns: ['claude-*'], strategy: 'native' },
  ],
  // OpenAI — gpt-3.5+, gpt-4*, o1*, o3* all support tools
  openai: [
    { patterns: ['gpt-3.5*', 'gpt-4*', 'gpt-5*', 'o1*', 'o3*', 'chatgpt-*'], strategy: 'native' },
  ],
  // Google — Gemini 1.5+ all support function calling
  google: [
    { patterns: ['gemini-1.5*', 'gemini-2*', 'gemini-3*'], strategy: 'native' },
  ],
  // Ollama — explicitly tool-capable model families. Anything else gets
  // prompt-injection (which currently throws not-yet-implemented).
  ollama: [
    {
      patterns: [
        'llama3.1*', 'llama3.2*', 'llama3.3*', 'llama4*',
        'qwen2.5*', 'qwen3*',
        'mistral-nemo*', 'mistral-large*',
        'firefunction*',
        'command-r*',
      ],
      strategy: 'native',
    },
  ],
  // Custom (OpenAI-compatible) — assume native; users running non-tool models
  // can override per-step.
  custom: [
    { patterns: ['*'], strategy: 'native' },
  ],
};

/**
 * Per-provider fallback when no pattern matches.
 *
 * - Ollama defaults to `'prompt-injection'` (stubbed in this PR — throws on
 *   execution). This documents the intended path; once implemented, existing
 *   non-tool Ollama models will automatically pick it up.
 * - Everything else falls back to `'none'`.
 */
const PROVIDER_DEFAULTS: Record<NeuronProvider, ToolStrategy> = {
  anthropic: 'none',
  openai: 'none',
  google: 'none',
  ollama: 'prompt-injection',
  custom: 'native',
};

/**
 * Resolve a tool strategy for the given provider/model pair.
 *
 * @param provider - Neuron provider
 * @param model    - Model name (matched case-insensitively against glob patterns)
 * @param override - Optional explicit strategy. `'auto'` (or omit) consults
 *                   the matrix. Any other value is returned as-is.
 *
 * @returns The strategy the executor should use.
 */
export function resolveToolStrategy(
  provider: NeuronProvider,
  model: string,
  override?: 'auto' | ToolStrategy,
): ToolStrategy {
  // Explicit override always wins (except for 'auto' which means "consult
  // the matrix").
  if (override && override !== 'auto') {
    return override;
  }

  const entries = MATRIX[provider];
  if (entries) {
    for (const entry of entries) {
      for (const pattern of entry.patterns) {
        if (matchesGlob(model, pattern)) {
          return entry.strategy;
        }
      }
    }
  }

  // Per-provider fallback
  return PROVIDER_DEFAULTS[provider] ?? 'none';
}

/**
 * Convenience: returns true when the resolved strategy will run the tool-use
 * loop. Used by the executor to decide whether to short-circuit to a plain
 * LLM call.
 */
export function isLoopingStrategy(strategy: ToolStrategy): boolean {
  return strategy === 'native' || strategy === 'prompt-injection';
}
