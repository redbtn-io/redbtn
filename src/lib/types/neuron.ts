/**
 * Neuron Type Definitions
 *
 * Defines the types and interfaces for the Neuron system.
 * Neurons are configurable LLM endpoints that can be dynamically loaded per-user.
 */

/**
 * Supported LLM providers
 */
export type NeuronProvider = 'ollama' | 'openai' | 'anthropic' | 'google' | 'custom';

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
 *
 * Override semantics: when present (true OR false), the explicit value
 * always wins. When absent, callers consult the static matrix
 * (`vision-matrix.ts` / future `audio-matrix.ts`).
 */
export interface NeuronCapabilities {
  vision?: boolean;
  audio?: boolean;
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
}
