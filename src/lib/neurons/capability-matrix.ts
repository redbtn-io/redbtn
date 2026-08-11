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

// =============================================================================
// Provider-hosted tools
// =============================================================================
//
// A second category of tool, distinct from everything the tool-resolver
// handles: the PROVIDER executes these itself (Google's googleSearch,
// OpenAI's web_search, Anthropic's web_search…). They have no name /
// description / schema / executor on our side — you switch them on and
// grounded output comes back inline, with no tool-call callback.
//
// Steps reference them by NORMALISED capability name (`hosted:web_search`),
// never by vendor wire format, so a graph runs unchanged across providers.
// This matrix maps `(provider, model, capability) → raw wire spec`; the specs
// bypass `toBindToolsPayload` and are concatenated verbatim onto the
// `bindTools()` array. Adding a provider or model family is a matrix entry,
// not a code change.

/** Normalised, vendor-neutral capability names steps may reference. */
export type HostedCapability = 'web_search' | 'code_execution' | 'url_context';

export const HOSTED_CAPABILITIES: readonly HostedCapability[] = [
  'web_search',
  'code_execution',
  'url_context',
];

export function isHostedCapability(value: string): value is HostedCapability {
  return (HOSTED_CAPABILITIES as readonly string[]).includes(value);
}

/** Raw provider wire spec — passed verbatim to `model.bindTools()`. */
export type HostedToolSpec = Record<string, unknown>;

interface HostedMatrixEntry {
  /** Glob patterns (case-insensitive, optional trailing `*`) */
  patterns: string[];
  specs: Partial<Record<HostedCapability, HostedToolSpec>>;
}

const HOSTED_MATRIX: Record<NeuronProvider, HostedMatrixEntry[]> = {
  google: [
    {
      patterns: ['gemini-2*', 'gemini-3*'],
      specs: {
        web_search: { googleSearch: {} },
        code_execution: { codeExecution: {} },
        url_context: { urlContext: {} },
      },
    },
    {
      // Gemini 1.5 predates the unified `googleSearch` tool.
      patterns: ['gemini-1.5*'],
      specs: {
        web_search: { googleSearchRetrieval: {} },
      },
    },
  ],
  openai: [
    {
      patterns: ['gpt-4*', 'gpt-5*', 'o1*', 'o3*', 'chatgpt-*'],
      specs: {
        web_search: { type: 'web_search_preview' },
        code_execution: { type: 'code_interpreter', container: { type: 'auto' } },
      },
    },
  ],
  anthropic: [
    {
      patterns: ['claude-*'],
      specs: {
        // Server-side web search tool (Anthropic executes it; results come
        // back inline as grounded text). code_execution needs a beta header
        // LangChain does not set — deliberately absent until wired.
        web_search: { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
      },
    },
  ],
  // No hosted tools exist for self-hosted / OpenAI-compatible endpoints.
  ollama: [],
  custom: [],
};

/**
 * Resolve the provider wire spec for a hosted capability, or `null` when the
 * (provider, model) pair does not support it. `null` is a DECLARED outcome —
 * the executor either degrades to the client-executed equivalent (redbtn's
 * native `web_search`) or fails the step with a clear config error; it never
 * silently drops the capability.
 */
export function resolveHostedToolSpec(
  provider: NeuronProvider,
  model: string,
  capability: HostedCapability,
): HostedToolSpec | null {
  const entries = HOSTED_MATRIX[provider];
  if (!entries) return null;
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (matchesGlob(model, pattern)) {
        return entry.specs[capability] ?? null;
      }
    }
  }
  return null;
}
