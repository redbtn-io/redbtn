/**
 * Vision Capability Matrix
 *
 * Static lookup of `(provider, modelFamily) -> hasVision` used by the
 * neuron executor when buildMultimodalMessage prepares an image content
 * part for a step. If the resolved neuron cannot see, the responder runs
 * the non-vision fallback ladder (OCR / describe-then-inject / skip — see
 * Phase 10).
 *
 * Mirrors the philosophy of `capability-matrix.ts` for tool calling:
 *   - Per-provider glob list, first match wins.
 *   - Per-provider default for "anything else".
 *   - `'auto'` override → consult matrix.
 *   - Boolean override → return that value verbatim (used by
 *     `NeuronConfig.capabilities.vision`).
 *
 * @module lib/neurons/vision-matrix
 */
import type { NeuronProvider } from '../types/neuron';

/**
 * Glob-style match: case-insensitive prefix when the pattern ends with `*`,
 * else exact match. Same helper shape as capability-matrix.ts so future
 * refactors can extract it to a shared util.
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
  /** Glob patterns (case-insensitive, optional trailing `*`). */
  patterns: string[];
  hasVision: boolean;
}

/**
 * Per-provider rule list. Each entry's patterns are tried in order; the
 * first match wins. If no entry matches, the per-provider default kicks
 * in (see `PROVIDER_DEFAULTS`).
 *
 * Conservative: only models we have confirmed vision support for are
 * listed as `true`. Everything else falls back to the provider default,
 * which is `false` for every provider (vision is the exception, not the
 * rule). Users can override per-neuron via NeuronConfig.capabilities.vision.
 */
const MATRIX: Record<NeuronProvider, MatrixEntry[]> = {
  // Anthropic — every Claude 3+ model has vision.
  anthropic: [
    { patterns: ['claude-3*', 'claude-4*'], hasVision: true },
  ],
  // OpenAI — gpt-4o family + dedicated -vision variants + o1/o3 reasoning
  // (which all support image inputs as of late 2025). gpt-5 will too.
  openai: [
    {
      patterns: ['gpt-4o*', 'gpt-4-vision*', 'gpt-4-turbo*', 'gpt-5*', 'o1*', 'o3*'],
      hasVision: true,
    },
  ],
  // Google — Gemini 1.5+ is multimodal by default.
  google: [
    { patterns: ['gemini-1.5*', 'gemini-2*', 'gemini-3*'], hasVision: true },
  ],
  // Ollama — only explicitly multimodal model families. Everything else
  // (granite4, llama3, qwen2.5 without -vl) cannot see.
  ollama: [
    {
      patterns: [
        'llava*',
        'llama3.2-vision*',
        'llama4-scout*',
        'llama4-maverick*',
        'qwen2.5-vl*',
        'qwen2-vl*',
        'minicpm-v*',
        'moondream*',
        'bakllava*',
        'gemma3*', // multimodal Gemma 3 models support image input
      ],
      hasVision: true,
    },
  ],
  // Custom (OpenAI-compatible third-party endpoints) — assume vision since
  // most current OpenAI-compat backends are vision-capable. Users can
  // override per-neuron with capabilities.vision = false.
  custom: [
    { patterns: ['*'], hasVision: true },
  ],
};

const PROVIDER_DEFAULTS: Record<NeuronProvider, boolean> = {
  anthropic: false,
  openai: false,
  google: false,
  ollama: false,
  custom: false,
};

/**
 * Override accepted by `resolveVisionCapability`. `'auto'` consults the
 * matrix; a boolean is returned verbatim (used by
 * `NeuronConfig.capabilities.vision`).
 */
export type VisionOverride = 'auto' | boolean | undefined;

/**
 * Resolve whether the neuron at (provider, model) can natively consume
 * image content parts.
 *
 * @param provider  - Neuron provider
 * @param model     - Model identifier (matched case-insensitively against
 *                    glob patterns)
 * @param override  - Optional explicit override. `true`/`false` wins.
 *                    `'auto'` or undefined consults the matrix.
 */
export function resolveVisionCapability(
  provider: NeuronProvider,
  model: string,
  override?: VisionOverride,
): boolean {
  // Explicit boolean override always wins.
  if (override === true || override === false) return override;

  const entries = MATRIX[provider];
  if (entries) {
    for (const entry of entries) {
      for (const pattern of entry.patterns) {
        if (matchesGlob(model, pattern)) {
          return entry.hasVision;
        }
      }
    }
  }

  return PROVIDER_DEFAULTS[provider] ?? false;
}
