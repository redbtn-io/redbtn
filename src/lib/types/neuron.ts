/**
 * Neuron Type Definitions
 *
 * Defines the types and interfaces for the Neuron system.
 * Neurons are configurable LLM endpoints that can be dynamically loaded per-user.
 */

/**
 * Supported LLM providers
 *
 * Two of these are not HTTP model endpoints. They denote a neuron backed by a
 * local CLI process authenticated with a SUBSCRIPTION rather than a metered API
 * key, driven by a dedicated executor that is entered before
 * `NeuronRegistry.createModel` is ever reached:
 *
 *   - `'claude-code'` — a Claude Code CLI child on a Claude subscription
 *     (`claudeCodeExecutor`).
 *   - `'agy-cli'`     — an Antigravity CLI (`agy`) child on a Google
 *     Antigravity subscription (`agyCliExecutor`), so a graph can run Gemini
 *     Flash without paying the Gemini API per token.
 *
 * Both are first-class provider values so they are accepted by the Mongoose
 * schema, the neurons API and the capability matrices.
 */
export type NeuronProvider =
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'custom'
  | 'claude-code'
  | 'agy-cli';

/**
 * Neuron role categorization (for UI organization)
 */
export type NeuronRole = 'chat' | 'worker' | 'specialist';

/**
 * Per-modality capability flags. Each flag tells the engine whether the
 * underlying model can natively consume that modality:
 *
 *   - `vision` — the model accepts image_url content parts and reasons over
 *     them. Used by buildMultimodalMessage's gate and the non-vision
 *     fallback ladder (OCR / describe-then-inject / skip).
 *   - `audio`  — the model accepts inline audio content parts. Used today
 *     by Gemini's audio-input path; placeholder for other providers as
 *     they roll out audio support.
 *   - `tools`  — the neuron can call tools at all. Descriptive only: the
 *     engine still decides *how* through `capability-matrix.ts`
 *     (`toolStrategy`), which is `'none'` for `claude-code` because the CLI
 *     runs its own loop and is handed tools over the run bridge instead.
 *   - `streaming` — the neuron can emit incremental text. Descriptive only,
 *     for studio pickers; the executor gates real streaming on the node's
 *     own `config.stream`.
 *
 * Override semantics: when present (true OR false), the explicit value
 * always wins. When absent, callers consult the static matrix
 * (`vision-matrix.ts` / future `audio-matrix.ts`).
 */
export interface NeuronCapabilities {
  vision?: boolean;
  audio?: boolean;
  tools?: boolean;
  streaming?: boolean;
}

/**
 * `--effort` levels the Claude Code CLI accepts.
 *
 * VERIFIED against `claude --help` on 2.1.263 (the version the worker image
 * pins): "Effort level for the current session (low, medium, high, xhigh,
 * max)". Lives here, not in the executor, so the Mongoose schema can validate
 * writes against the same list the executor validates reads against.
 */
export const CLAUDE_CODE_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_LEVELS)[number];

/**
 * Effort used when a `claude-code` neuron doc names none.
 *
 * `xhigh` rather than the CLI's own default because these neurons exist to
 * spend a flat-rate subscription on hard work; a step that wants it cheaper
 * says so explicitly.
 */
export const DEFAULT_CLAUDE_CODE_EFFORT: ClaudeCodeEffort = 'xhigh';

/**
 * `--effort` levels the Antigravity CLI accepts.
 *
 * VERIFIED against agy 1.1.27 on 2026-09-08: `--effort xhigh` is refused with
 * `invalid --effort "xhigh" (valid: low, medium, high)`. This is a strict
 * SUBSET of `CLAUDE_CODE_EFFORT_LEVELS`, which is why the two providers cannot
 * share one list: a neuron doc carrying `effort: 'xhigh'` is legal (the shared
 * Mongoose enum is the union, so a doc can be re-pointed between providers
 * without a migration) but is degraded to the default by `agyCliExecutor`
 * rather than passed through to a run that would die at argument-parse time.
 */
export const AGY_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;

export type AgyEffort = (typeof AGY_EFFORT_LEVELS)[number];

/**
 * Effort used when an `agy-cli` neuron doc names none.
 *
 * `high` because these neurons exist to spend a flat-rate subscription; a step
 * that wants it cheaper says so. Note that `--effort` is not merely optional on
 * this CLI: the bare model ids (`gemini-3.8-flash`) REQUIRE one and the Claude
 * and GPT-OSS models REFUSE one, so the executor consults a per-model table
 * before deciding whether this value is used at all.
 */
export const DEFAULT_AGY_EFFORT: AgyEffort = 'high';

/**
 * Provider-specific knobs carried on the neuron document.
 *
 * Deliberately a *closed* shape rather than a free-form bag: the Mongoose
 * schema declares exactly these keys, so an unknown key written by any caller
 * is dropped by strict mode instead of reaching a child process's command
 * line. Adding a knob is a schema change on purpose.
 */
export interface NeuronParameters {
  /**
   * CLI providers only — maps to the CLI's `--effort <level>`.
   *
   * Typed as the Claude Code list because that is the UNION of the two
   * providers' levels. An `agy-cli` neuron may only use `low`/`medium`/`high`
   * (`AGY_EFFORT_LEVELS`); `agyCliExecutor` degrades anything else to
   * `DEFAULT_AGY_EFFORT` with a warning rather than failing the run.
   */
  effort?: ClaudeCodeEffort;
}

/**
 * Runtime neuron configuration
 * Used internally by NeuronRegistry when creating model instances
 */
export interface NeuronConfig {
  id: string;
  name: string;
  description?: string;
  provider: NeuronProvider;
  endpoint: string;
  model: string;
  /** Resolved API key. Populated by NeuronRegistry from `secretName`
   *  (vault lookup). Undefined → LangChain falls through to platform-
   *  level env vars (OPENAI_API_KEY etc.). */
  apiKey?: string;
  /** Name of an entry in the user's secrets vault (`@redbtn/redsecrets`).
   *  NeuronRegistry resolves this at load time and populates `apiKey`
   *  from the resolved value. Unset → run on platform key. */
  secretName?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  role: NeuronRole;
  tier: number;
  userId?: string;
  /** When true, the worker generates TTS audio server-side during streaming */
  audioOptimized?: boolean;
  /**
   * Explicit per-modality capability overrides. When unset, the engine
   * consults `vision-matrix.ts` (and audio-matrix.ts in a future phase).
   */
  capabilities?: NeuronCapabilities;
  /**
   * Provider-specific knobs from the neuron document. Today only
   * `parameters.effort`, read by the `claude-code` and `agy-cli` executors.
   */
  parameters?: NeuronParameters;
}

/**
 * MongoDB document interface for neurons collection
 */
export interface NeuronDocument {
  _id?: any;
  neuronId: string;
  userId: string;
  creatorId?: string;
  status?: 'active' | 'abandoned' | 'deleted';
  abandonedAt?: Date | null;
  scheduledDeletionAt?: Date | null;
  isDefault: boolean;
  isSystem?: boolean;
  isImmutable?: boolean;
  parentNeuronId?: string;
  name: string;
  description?: string;
  provider: NeuronProvider;
  endpoint: string;
  model: string;
  /** Name of an entry in the user's secrets vault. NeuronRegistry
   *  resolves at load time via `@redbtn/redsecrets`. Unset = run on
   *  platform key (LangChain env fallback). */
  secretName?: string;
  temperature: number;
  maxTokens?: number;
  topP?: number;
  role: NeuronRole;
  tier: number;
  createdAt: Date;
  updatedAt: Date;
  usageCount?: number;
  lastUsedAt?: Date;
  /** When true, the worker generates TTS audio server-side during streaming */
  audioOptimized?: boolean;
  /**
   * Explicit per-modality capability overrides on the persisted document.
   * Resolved via vision-matrix when unset.
   */
  capabilities?: NeuronCapabilities;
  /**
   * Provider-specific knobs on the persisted document. Declared in the
   * Mongoose schema (strict mode drops anything else).
   */
  parameters?: NeuronParameters;
}
